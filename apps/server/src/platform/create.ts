import { createAuth, createBilling, createChannel, createLlm, createMetrics, createTelemetry, createVault, pgSearch, stubRetriever } from '../adapters/index.ts';
import { pgAnalytics } from '../adapters/pg-analytics.ts';
import { createPgFiles } from '../adapters/pg-files.ts';
import { registerAnalyticsJobs } from './analytics/jobs.ts';
import { metricsConsumer } from './analytics/metrics.ts';
import { createDelivery } from '../adapters/delivery.ts';
import { createSandbox } from '../adapters/sandbox.ts';
import { policyFrom } from '../adapters/ssrf.ts';
import { createPgBossJobs } from '../adapters/pg-boss-jobs.ts';
import { PgEventBus } from '../adapters/pg-event-bus.ts';
import { loadEnv, loadPlatformConfig, type Env } from '../config.ts';
import { createDatabase } from '../db/database.ts';
import { Catalog } from './catalog.ts';
import { templateConsumers } from './consumers.ts';
import type { Logger, Platform } from './context.ts';
import { HubDeliverer, hubFanoutConsumer } from './hub.ts';
import { linkIndexConsumer } from './links.ts';
import { IndexBuilder, runBackfill } from './maintenance.ts';
import { handleStepJob } from './provisioning.ts';
import { QUEUES } from './queues.ts';
import { TEMPLATES } from './templates.ts';
import { notificationsConsumer, WorkflowRunner, workflowsConsumer } from './workflows/engine.ts';
import { handleLifecycleJob, lifecycleSweep } from './tenants.ts';

const consoleLogger: Logger = {
  info: (o, m) => console.log(m ?? '', o && Object.keys(o as object).length ? JSON.stringify(o) : ''),
  warn: (o, m) => console.warn(m ?? '', o),
  error: (o, m) => console.error(m ?? '', o),
};

export function createPlatform(opts: { env?: Partial<Record<keyof Env, string>>; log?: Logger; jobsPollSeconds?: number } = {}): Platform {
  const env = loadEnv(opts.env as Record<string, string>);
  const log = opts.log ?? consoleLogger;
  const config = loadPlatformConfig();
  const catalog = new Catalog(TEMPLATES, config);
  const database = createDatabase(env.DATABASE_URL, { max: 15 });
  const metrics = createMetrics();
  const vault = createVault(env.VAULT_KEY, (m) => log.warn({}, m));
  const p: Platform = {
    workers: undefined as unknown as Platform['workers'],
    env,
    config,
    catalog,
    database,
    log,
    ports: {
      eventBus: new PgEventBus({ database, metrics, log, intervalMs: env.DISPATCH_INTERVAL_MS }),
      search: pgSearch,
      metrics,
      jobs: createPgBossJobs(env.DATABASE_URL, (m) => log.warn({}, m), { pollingIntervalSeconds: opts.jobsPollSeconds ?? 0.5 }),
      webhooks: createDelivery(policyFrom(env.HUB_ALLOW_PRIVATE_HOSTS, env.NODE_ENV === 'production'), { production: env.NODE_ENV === 'production', log: (msg, err) => log.warn({ err: String(err) }, msg) }),
      channel: createChannel(env.DEMO_MODE, (m) => log.info({}, m)),
      auth: createAuth({ allowInsecureIssuers: env.NODE_ENV !== 'production' }),
      vault,
      files: createPgFiles(database, vault),
      telemetry: createTelemetry(),
      llm: createLlm(env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL),
      retriever: stubRetriever,
      sandbox: createSandbox(),
      billing: createBilling(config),
      analytics: pgAnalytics,
    },
  };
  for (const c of templateConsumers(p)) p.ports.eventBus.subscribe(c);
  p.ports.eventBus.subscribe(linkIndexConsumer(p));
  p.ports.eventBus.subscribe(hubFanoutConsumer(p));
  p.ports.eventBus.subscribe(workflowsConsumer(p));
  p.ports.eventBus.subscribe(notificationsConsumer(p));
  p.ports.eventBus.subscribe(metricsConsumer(p));
  p.workers = { hub: new HubDeliverer(p), workflows: new WorkflowRunner(p), indexes: null };
  return p;
}

/** Starts the in-process workers: outbox dispatcher + pg-boss workers + schedules. */
export async function startWorkers(p: Platform) {
  await p.ports.jobs.start();
  await p.ports.jobs.work<{ tenantId: string; runId: string; step?: string; op: 'run' | 'compensate' }>(QUEUES.provisionStep, (data, job) => handleStepJob(p, data, job.retryCount));
  await p.ports.jobs.work<{ kind: string; tenantId: string; app?: string }>(QUEUES.tenantLifecycle, (data) => handleLifecycleJob(p, data));
  await p.ports.jobs.work(QUEUES.lifecycleSweep, () => lifecycleSweep(p));
  await p.ports.jobs.schedule(QUEUES.lifecycleSweep, '*/5 * * * *');
  await p.ports.jobs.work<{ tenantId: string; runId: string }>(QUEUES.backfill, (data) => runBackfill(p, data));
  await registerAnalyticsJobs(p);
  await p.ports.eventBus.start();
  p.workers.hub.start();
  p.workers.workflows.start();
  const ownerUrl = p.env.INDEX_DATABASE_URL ?? p.env.MIGRATION_DATABASE_URL;
  if (ownerUrl) {
    const builder = new IndexBuilder(p, ownerUrl);
    p.workers.indexes = builder;
    const failed = (e: unknown) => p.log.error({ err: String(e) }, 'index builder failed');
    const loop = async () => {
      await builder.runPending().catch(failed);
      indexTimer = setTimeout(() => {
        loop().catch(failed);
      }, 2000);
    };
    indexTimer = setTimeout(() => {
      loop().catch(failed);
    }, 500);
  }
}

let indexTimer: NodeJS.Timeout | null = null;

export async function stopPlatform(p: Platform) {
  if (indexTimer) clearTimeout(indexTimer);
  await p.workers.hub.stop();
  await p.workers.workflows.stop();
  await p.ports.eventBus.stop();
  await p.ports.jobs.stop();
  await p.database.close();
}
