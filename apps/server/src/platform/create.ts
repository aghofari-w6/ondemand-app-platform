import { createAuth, createBilling, createChannel, createLlm, createMetrics, createTelemetry, createVault, pgSearch, stubFiles, stubRetriever, stubSandbox, stubWebhooks } from '../adapters/index.ts';
import { createPgBossJobs } from '../adapters/pg-boss-jobs.ts';
import { PgEventBus } from '../adapters/pg-event-bus.ts';
import { loadEnv, loadPlatformConfig, type Env } from '../config.ts';
import { createDatabase } from '../db/database.ts';
import { Catalog } from './catalog.ts';
import { templateConsumers } from './consumers.ts';
import type { Logger, Platform } from './context.ts';
import { handleStepJob } from './provisioning.ts';
import { QUEUES } from './queues.ts';
import { TEMPLATES } from './templates.ts';
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
  const p: Platform = {
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
      webhooks: stubWebhooks,
      channel: createChannel(env.DEMO_MODE, (m) => log.info({}, m)),
      auth: createAuth({ allowInsecureIssuers: env.NODE_ENV !== 'production' }),
      vault: createVault(env.VAULT_KEY, (m) => log.warn({}, m)),
      files: stubFiles,
      telemetry: createTelemetry(),
      llm: createLlm(env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL),
      retriever: stubRetriever,
      sandbox: stubSandbox,
      billing: createBilling(config),
    },
  };
  for (const c of templateConsumers(p)) p.ports.eventBus.subscribe(c);
  return p;
}

/** Starts the in-process workers: outbox dispatcher + pg-boss workers + schedules. */
export async function startWorkers(p: Platform) {
  await p.ports.jobs.start();
  await p.ports.jobs.work<{ tenantId: string; runId: string; step?: string; op: 'run' | 'compensate' }>(QUEUES.provisionStep, (data, job) => handleStepJob(p, data, job.retryCount));
  await p.ports.jobs.work<{ kind: string; tenantId: string; app?: string }>(QUEUES.tenantLifecycle, (data) => handleLifecycleJob(p, data));
  await p.ports.jobs.work(QUEUES.lifecycleSweep, () => lifecycleSweep(p));
  await p.ports.jobs.schedule(QUEUES.lifecycleSweep, '*/5 * * * *');
  await p.ports.eventBus.start();
}

export async function stopPlatform(p: Platform) {
  await p.ports.eventBus.stop();
  await p.ports.jobs.stop();
  await p.database.close();
}
