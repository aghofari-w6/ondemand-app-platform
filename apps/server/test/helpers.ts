import { randomUUID } from 'node:crypto';
import type { Principal } from '@aod/shared';
import pg from 'pg';
import { principalFor } from '../src/auth/principal.ts';
import { consumeLoginToken, createSession, splitToken } from '../src/auth/sessions.ts';
import { executeCommand } from '../src/platform/commands.ts';
import type { Logger, Platform } from '../src/platform/context.ts';
import { createPlatform } from '../src/platform/create.ts';
import { runBackfill } from '../src/platform/maintenance.ts';
import { enqueueStep, handleStepJob, SAGAS, startRun, type RunKind } from '../src/platform/provisioning.ts';
import { QUEUES } from '../src/platform/queues.ts';
import { changeTenantStatus, handleLifecycleJob, signup } from '../src/platform/tenants.ts';
import { ADMIN_URL, APP_URL } from './env.ts';

export const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export { InlineJobs as MemJobs } from '../src/adapters/inline-jobs.ts';
import { InlineJobs as MemJobs } from '../src/adapters/inline-jobs.ts';

export function testPlatform(): Platform & { jobs: MemJobs } {
  const p = createPlatform({ env: { DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: ADMIN_URL, NODE_ENV: 'test', DEMO_MODE: 'true', PUBLIC_URL: 'http://localhost:3000', HUB_ALLOW_PRIVATE_HOSTS: 'localhost,127.0.0.1', HUB_BACKOFF_BASE_MS: '10', HUB_BREAKER_COOLDOWN_MS: '200', HUB_MAX_ATTEMPTS: '3', HUB_BREAKER_THRESHOLD: '3' }, log: silent });
  const jobs = new MemJobs();
  p.ports.jobs = jobs;
  void jobs.work(QUEUES.provisionStep, (d: any, j: any) => handleStepJob(p, d, j.retryCount));
  void jobs.work(QUEUES.tenantLifecycle, (d: any) => handleLifecycleJob(p, d));
  void jobs.work(QUEUES.backfill, (d: any) => runBackfill(p, d));
  return Object.assign(p, { jobs });
}

export function admin() {
  return new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
}

export interface TestTenant {
  tenantId: string;
  ownerId: string;
  owner: Principal;
  cookie: string;
}

let n = 0;
export async function newTenant(p: Platform, prefix = 't'): Promise<TestTenant> {
  const slug = `${prefix}-${Date.now().toString(36)}-${++n}`;
  const r = await signup(p, { workspaceName: `Tenant ${slug}`, slug, ownerName: 'Owner', email: `owner@${slug}.example` }, randomUUID());
  const t = splitToken(r.token)!;
  const cookie = await p.database.withTenant(r.tenantId, async (tx) => {
    const used = await consumeLoginToken(tx, t.secret);
    return (await createSession(tx, r.tenantId, used!.userId, 'magic_link')).cookie;
  });
  const owner = await p.database.withTenant(r.tenantId, (tx) => principalFor(tx, p.catalog, r.tenantId, { id: r.userId, role: 'Owner' }));
  return { tenantId: r.tenantId, ownerId: r.userId, owner, cookie };
}

export async function setPlan(p: Platform, t: TestTenant, plan: string) {
  await p.database.withTenant(t.tenantId, (tx) => changeTenantStatus(p, tx, t.tenantId, 'active', t.owner, randomUUID(), { plan }));
}

export async function runSaga(p: Platform & { jobs: MemJobs }, t: TestTenant, app: string, kind: RunKind = 'provision', extra: { mode?: 'retain' | 'purge'; channel?: 'stable' | 'canary' } = {}) {
  const runId = await p.database.withTenant(t.tenantId, (tx) => startRun(p, tx, { tenantId: t.tenantId, app, kind, actor: t.owner, correlationId: randomUUID(), ...extra }));
  await enqueueStep(p, t.tenantId, runId, SAGAS[kind][0]!.name);
  await p.jobs.runAll();
  const run = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('provisioning_run').selectAll().where('id', '=', runId).executeTakeFirstOrThrow());
  return { runId, status: run.status as string, error: run.error as string | null };
}

export function cmd(p: Platform, t: TestTenant, app: string, command: string, input: unknown, opts: { key?: string; principal?: Principal } = {}) {
  return executeCommand(p, { tenantId: t.tenantId, principal: opts.principal ?? t.owner, app, command, input, idempotencyKey: opts.key, correlationId: randomUUID() });
}

export async function closePlatform(p: Platform) {
  await p.workers.hub.stop();
  await p.ports.eventBus.stop();
  await p.database.close();
}
