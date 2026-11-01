import { CommandError, DEPROVISION_STEPS, PROVISION_STEPS, type Principal } from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../db/database.ts';
import type { CatalogApp } from './catalog.ts';
import { activeApps } from './commands.ts';
import { backfillTenant, templateConsumers } from './consumers.ts';
import type { Platform } from './context.ts';
import { QUEUES } from './queues.ts';
import { recordChange } from './record.ts';

/**
 * Provisioning saga on pg-boss.
 *
 * Each step is its own job keyed by (run, step). A step that is already `done` is
 * skipped, so re-delivered jobs are harmless. A failing step marks the run `failed`;
 * the user can retry from that step or roll back, which compensates every completed
 * step in reverse order. Deprovisioning and upgrades are sagas of the same shape.
 */

export type RunKind = 'provision' | 'deprovision' | 'upgrade';

interface Run {
  id: string;
  tenant_id: string;
  app: string;
  kind: RunKind;
  target_version: string;
  channel: string;
  mode: 'retain' | 'purge' | null;
  status: string;
  created_by: string;
  correlation_id: string;
}

interface StepCtx {
  p: Platform;
  tx: Tx;
  run: Run;
  app: CatalogApp;
  output: Record<string, unknown>;
}

interface StepDef {
  name: string;
  run(c: StepCtx): Promise<Record<string, unknown> | void>;
  compensate?(c: StepCtx): Promise<void>;
}

/** Non-retryable failure: the run stops and waits for retry or rollback. */
export class StepFailed extends Error {}

const system = (run: Run) => ({ type: 'System' as const, id: `saga:${run.id}` });

async function installedRow(tx: Tx, app: string) {
  return tx.selectFrom('installed_app').selectAll().where('app', '=', app).where('status', '<>', 'removed').executeTakeFirst();
}

async function verifySchema(c: StepCtx, version: string) {
  const release = c.p.catalog.release(c.run.app, version);
  if (!release) throw new StepFailed(`unknown release ${version}`);
  const applied = await sql<{ name: string }>`SELECT name FROM ${sql.table(`pgmigrations_${c.run.app}`)}`.execute(c.tx);
  const names = new Set(applied.rows.map((r) => `${r.name}.sql`));
  const missing = release.migrations.filter((m) => !names.has(m));
  if (missing.length) throw new StepFailed(`schema for ${c.run.app} ${version} is not deployed yet (missing ${missing.join(', ')}); run the migrate job, then retry`);
  return release.migrations.length;
}

const PROVISION: StepDef[] = [
  {
    name: 'entitlement',
    async run({ p, tx, run, app }) {
      const t = await tx.selectFrom('tenant').select(['status', 'plan']).executeTakeFirstOrThrow();
      if (t.status !== 'trial' && t.status !== 'active') throw new StepFailed(`workspace is ${t.status}`);
      const plan = p.ports.billing.plan(t.plan);
      if (!plan) throw new StepFailed(`unknown plan ${t.plan}`);
      if (!plan.packages.includes(app.manifest.package)) throw new StepFailed(`the ${plan.label} plan does not include the ${app.manifest.package} package`);
      const used = await tx
        .selectFrom('installed_app')
        .select(sql<number>`count(*)`.as('n'))
        .where('status', 'in', ['provisioning', 'active', 'failed', 'deprovisioning'])
        .where('app', '<>', run.app)
        .executeTakeFirstOrThrow();
      if (Number(used.n) >= plan.appSlots) throw new StepFailed(`all ${plan.appSlots} app slots of the ${plan.label} plan are in use`);
      return { plan: t.plan, slots_used: Number(used.n) + 1, slots: plan.appSlots };
    },
  },
  {
    name: 'dependencies',
    async run({ p, tx, app }) {
      const active = await activeApps(tx);
      const missing = app.manifest.dependencies.requires.filter((d) => !active.includes(d));
      if (missing.length) throw new StepFailed(`${app.manifest.name} requires ${missing.map((m) => p.catalog.get(m)?.manifest.name ?? m).join(', ')}; provision it first`);
      const before = p.catalog.activeCapabilities(active);
      const after = p.catalog.activeCapabilities([...active, app.manifest.id]);
      return { requires: app.manifest.dependencies.requires, capabilities_enabled: after.filter((c) => !before.includes(c)) };
    },
  },
  {
    name: 'allocate',
    async run({ tx, run }) {
      const cur = await installedRow(tx, run.app);
      if (cur && cur.status === 'retained') {
        await tx.updateTable('installed_app').set({ status: 'provisioning', version: run.target_version, channel: run.channel, retained_until: null, updated_at: new Date() }).where('id', '=', cur.id).execute();
        return { installed_app_id: cur.id, restored: true };
      }
      if (cur && cur.status !== 'failed') throw new StepFailed(`${run.app} is already ${cur.status}`);
      if (cur) {
        await tx.updateTable('installed_app').set({ status: 'provisioning', version: run.target_version, channel: run.channel, updated_at: new Date() }).where('id', '=', cur.id).execute();
        return { installed_app_id: cur.id, restored: false };
      }
      const id = newId();
      await tx.insertInto('installed_app').values({ id, tenant_id: run.tenant_id, app: run.app, version: run.target_version, channel: run.channel, status: 'provisioning' }).execute();
      return { installed_app_id: id, restored: false };
    },
    async compensate({ tx, run, output }) {
      if (output.restored) {
        await tx.updateTable('installed_app').set({ status: 'retained', retained_until: new Date(Date.now() + 30 * 86_400_000) }).where('id', '=', String(output.installed_app_id)).execute();
      } else {
        await tx.updateTable('installed_app').set({ status: 'removed', updated_at: new Date() }).where('app', '=', run.app).where('status', '<>', 'removed').execute();
      }
    },
  },
  {
    name: 'migrate_seed',
    async run(c) {
      const migrations = await verifySchema(c, c.run.target_version);
      const restored = (await stepOutput(c.tx, c.run.id, 'allocate')).restored === true;
      if (!restored) await c.app.template.seed({ tx: c.tx, tenantId: c.run.tenant_id, now: () => new Date(), newId });
      return { migrations, seeded: !restored, restored };
    },
    async compensate(c) {
      if (!c.output.restored) await c.app.template.purge({ tx: c.tx, tenantId: c.run.tenant_id, now: () => new Date(), newId });
    },
  },
  {
    name: 'config_theme',
    async run({ tx, app }) {
      const t = await tx.selectFrom('tenant').select('settings').executeTakeFirstOrThrow();
      const theme = (t.settings as { theme?: Record<string, unknown> }).theme ?? { accent: '#2856D9' };
      const config = { ...app.manifest.config, theme };
      await tx.updateTable('installed_app').set({ config: JSON.stringify(config) }).where('app', '=', app.manifest.id).where('status', '=', 'provisioning').execute();
      return { keys: Object.keys(config) };
    },
    async compensate({ tx, run }) {
      await tx.updateTable('installed_app').set({ config: '{}' }).where('app', '=', run.app).where('status', '<>', 'removed').execute();
    },
  },
  {
    name: 'register_contracts',
    async run({ tx, run, app }) {
      const m = app.manifest;
      const rows = [
        ...m.events.publishes.map((e) => ({ kind: 'event', name: e.type })),
        ...m.commands.map((c) => ({ kind: 'command', name: c.name })),
        ...m.permissions.map((x) => ({ kind: 'permission', name: x.id })),
        ...[...new Set(m.events.consumes.map((c) => c.consumer))].map((name) => ({ kind: 'consumer', name: `${m.id}.${name}` })),
      ].map((r) => ({ ...r, tenant_id: run.tenant_id, app: m.id, version: run.target_version }));
      await tx.deleteFrom('contract_registration').where('app', '=', m.id).execute();
      if (rows.length) await tx.insertInto('contract_registration').values(rows).execute();
      return { registered: rows.length };
    },
    async compensate({ tx, run }) {
      await tx.deleteFrom('contract_registration').where('app', '=', run.app).execute();
    },
  },
  {
    name: 'health_check',
    async run({ tx, run, app }) {
      const h = await app.template.health({ tx, tenantId: run.tenant_id, now: () => new Date(), newId });
      if (!h.ok) throw new StepFailed(`health check failed: ${h.detail ?? 'unknown'}`);
      return { ok: true };
    },
  },
  {
    name: 'activate',
    async run({ p, tx, run, app }) {
      await tx.updateTable('installed_app').set({ status: 'active', installed_at: new Date(), updated_at: new Date() }).where('app', '=', run.app).where('status', '=', 'provisioning').execute();
      await recordChange(p, tx, {
        tenantId: run.tenant_id,
        actor: { type: 'User', id: run.created_by },
        action: 'platform:app.provisioned',
        resourceType: 'platform::App',
        resourceId: run.app,
        correlationId: run.correlation_id,
        events: [{ type: 'app.provisioned', data: { app: run.app, version: run.target_version, channel: run.channel, run_id: run.id } }],
      });
      return { name: app.manifest.name };
    },
    async compensate({ tx, run }) {
      await tx.updateTable('installed_app').set({ status: 'provisioning' }).where('app', '=', run.app).where('status', '=', 'active').execute();
    },
  },
];

const DEPROVISION: StepDef[] = [
  {
    name: 'deactivate',
    async run({ p, tx, run }) {
      const cur = await installedRow(tx, run.app);
      if (!cur || !['active', 'failed', 'deprovisioning'].includes(cur.status)) throw new StepFailed(`${run.app} is not installed`);
      const dependents = (await activeApps(tx)).filter((a) => p.catalog.get(a)?.manifest.dependencies.requires.includes(run.app));
      if (dependents.length) throw new StepFailed(`${dependents.join(', ')} depend on ${run.app}; remove them first`);
      await tx.updateTable('installed_app').set({ status: 'deprovisioning', updated_at: new Date() }).where('id', '=', cur.id).execute();
      return { installed_app_id: cur.id };
    },
    async compensate({ tx, run }) {
      await tx.updateTable('installed_app').set({ status: 'active' }).where('app', '=', run.app).where('status', '=', 'deprovisioning').execute();
    },
  },
  {
    name: 'unregister_contracts',
    async run({ tx, run }) {
      const r = await tx.deleteFrom('contract_registration').where('app', '=', run.app).executeTakeFirst();
      return { removed: Number(r.numDeletedRows) };
    },
  },
  {
    name: 'remove_config',
    async run() {
      return { kept_for_restore: true };
    },
  },
  {
    name: 'data',
    async run({ p, tx, run, app }) {
      if (run.mode === 'purge') {
        await app.template.purge({ tx, tenantId: run.tenant_id, now: () => new Date(), newId });
        return { mode: 'purge' };
      }
      const until = new Date(Date.now() + p.config.deprovision.retain_days * 86_400_000);
      return { mode: 'retain', retained_until: until.toISOString() };
    },
  },
  {
    name: 'release',
    async run({ p, tx, run }) {
      const out = await stepOutput(tx, run.id, 'data');
      const retain = out.mode === 'retain';
      await tx
        .updateTable('installed_app')
        .set({ status: retain ? 'retained' : 'removed', retained_until: retain ? new Date(String(out.retained_until)) : null, config: retain ? sql`config` : '{}', updated_at: new Date() })
        .where('app', '=', run.app)
        .where('status', '=', 'deprovisioning')
        .execute();
      await recordChange(p, tx, {
        tenantId: run.tenant_id,
        actor: { type: 'User', id: run.created_by },
        action: 'platform:app.deprovisioned',
        resourceType: 'platform::App',
        resourceId: run.app,
        correlationId: run.correlation_id,
        events: [{ type: 'app.deprovisioned', data: { app: run.app, mode: run.mode, run_id: run.id } }],
      });
      return { status: retain ? 'retained' : 'removed' };
    },
  },
];

const UPGRADE: StepDef[] = [
  {
    name: 'pin_check',
    async run({ tx, run }) {
      const pin = await tx.selectFrom('app_pin').select('version').where('app', '=', run.app).executeTakeFirst();
      if (pin && pin.version !== run.target_version) throw new StepFailed(`${run.app} is pinned to ${pin.version}`);
      const cur = await installedRow(tx, run.app);
      if (!cur || cur.status !== 'active') throw new StepFailed(`${run.app} is not active`);
      return { from: cur.version };
    },
  },
  {
    name: 'migrate',
    async run(c) {
      // Releases after the first are validated as expand-only when manifests load, so the
      // shared schema can move ahead of tenants still on the older version.
      return { migrations: await verifySchema(c, c.run.target_version), expand_only: true };
    },
  },
  {
    name: 'switch_version',
    async run({ tx, run }) {
      await tx.updateTable('installed_app').set({ version: run.target_version, channel: run.channel, updated_at: new Date(), version_no: sql`version_no + 1` }).where('app', '=', run.app).where('status', '=', 'active').execute();
      return { to: run.target_version };
    },
    async compensate({ tx, run }) {
      const from = (await stepOutput(tx, run.id, 'pin_check')).from;
      if (from) await tx.updateTable('installed_app').set({ version: String(from) }).where('app', '=', run.app).where('status', '=', 'active').execute();
    },
  },
  {
    name: 'health_check',
    async run({ p, tx, run, app }) {
      const h = await app.template.health({ tx, tenantId: run.tenant_id, now: () => new Date(), newId });
      if (!h.ok) throw new StepFailed(`health check failed: ${h.detail ?? 'unknown'}`);
      await recordChange(p, tx, {
        tenantId: run.tenant_id,
        actor: { type: 'User', id: run.created_by },
        action: 'platform:app.upgraded',
        resourceType: 'platform::App',
        resourceId: run.app,
        correlationId: run.correlation_id,
        events: [{ type: 'app.upgraded', data: { app: run.app, version: run.target_version, run_id: run.id } }],
      });
      return { ok: true };
    },
  },
];

export const SAGAS: Record<RunKind, StepDef[]> = { provision: PROVISION, deprovision: DEPROVISION, upgrade: UPGRADE };

// Keep the shared step list (UI labels) and the saga definition in lockstep.
if (PROVISION.map((s) => s.name).join() !== PROVISION_STEPS.map((s) => s.name).join()) throw new Error('provision steps out of sync');
if (DEPROVISION.map((s) => s.name).join() !== DEPROVISION_STEPS.map((s) => s.name).join()) throw new Error('deprovision steps out of sync');

async function stepOutput(tx: Tx, runId: string, step: string): Promise<Record<string, unknown>> {
  const r = await tx.selectFrom('provisioning_step').select('output').where('run_id', '=', runId).where('step', '=', step).executeTakeFirst();
  return (r?.output as Record<string, unknown>) ?? {};
}

// ------------------------------------------------------------------ starting runs

export async function startRun(
  p: Platform,
  tx: Tx,
  a: { tenantId: string; app: string; kind: RunKind; actor: Principal; correlationId: string; channel?: 'stable' | 'canary'; mode?: 'retain' | 'purge' },
): Promise<string> {
  const app = p.catalog.get(a.app);
  if (!app) throw new CommandError(404, 'unknown_app', `unknown app ${a.app}`);
  const busy = await tx.selectFrom('provisioning_run').select('id').where('app', '=', a.app).where('status', 'in', ['running', 'failed', 'compensating']).executeTakeFirst();
  if (busy) throw Object.assign(new CommandError(409, 'run_in_progress', `a provisioning run for ${a.app} is still open`), { details: { runId: busy.id } });
  const cur = await installedRow(tx, a.app);
  if (a.kind === 'provision' && cur && !['retained', 'failed'].includes(cur.status)) throw new CommandError(409, 'already_installed', `${app.manifest.name} is already ${cur.status}`);
  if (a.kind !== 'provision' && (!cur || cur.status !== 'active')) throw new CommandError(409, 'not_installed', `${app.manifest.name} is not active`);

  const pin = await tx.selectFrom('app_pin').select('version').where('app', '=', a.app).executeTakeFirst();
  const channel = a.channel ?? (cur?.channel as 'stable' | 'canary' | undefined) ?? 'stable';
  let target = pin?.version ?? p.catalog.channelVersion(a.app, channel);
  if (a.kind === 'deprovision') target = cur!.version;
  if (a.kind === 'upgrade') {
    target = p.catalog.channelVersion(a.app, channel);
    if (pin) throw new CommandError(409, 'pinned', `${app.manifest.name} is pinned to ${pin.version}; unpin it to upgrade`);
    if (!p.catalog.isUpgrade(cur!.version, target)) throw new CommandError(409, 'up_to_date', `${app.manifest.name} ${cur!.version} is already the latest on ${channel}`);
  }

  const id = newId();
  await tx
    .insertInto('provisioning_run')
    .values({ id, tenant_id: a.tenantId, app: a.app, kind: a.kind, target_version: target, channel, mode: a.mode ?? null, status: 'running', created_by: a.actor.id, correlation_id: a.correlationId })
    .execute();
  const steps = SAGAS[a.kind];
  await tx
    .insertInto('provisioning_step')
    .values(steps.map((s, i) => ({ run_id: id, tenant_id: a.tenantId, step: s.name, position: i })))
    .execute();
  await recordChange(p, tx, {
    tenantId: a.tenantId,
    actor: a.actor,
    action: `platform:app.${a.kind}.started`,
    resourceType: 'platform::ProvisioningRun',
    resourceId: id,
    correlationId: a.correlationId,
    events: [{ type: `provisioning.started`, data: { run_id: id, app: a.app, kind: a.kind, version: target } }],
  });
  return id;
}

export async function enqueueStep(p: Platform, tenantId: string, runId: string, step: string) {
  await p.ports.jobs.send(QUEUES.provisionStep, { tenantId, runId, step, op: 'run' }, { singletonKey: `${runId}:${step}:run` });
}

// ------------------------------------------------------------------ job handler

export async function handleStepJob(p: Platform, job: { tenantId: string; runId: string; step?: string; op: 'run' | 'compensate' }, retryCount = 0) {
  if (job.op === 'compensate') return compensateRun(p, job.tenantId, job.runId);
  const { tenantId, runId, step } = job;
  const loaded = await p.database.withTenant(tenantId, async (tx) => {
    const run = (await tx.selectFrom('provisioning_run').selectAll().where('id', '=', runId).executeTakeFirst()) as Run | undefined;
    if (!run || run.status !== 'running') return null;
    const row = await tx.selectFrom('provisioning_step').selectAll().where('run_id', '=', runId).where('step', '=', step!).executeTakeFirst();
    if (!row) return null;
    if (row.status !== 'done') {
      await tx.updateTable('provisioning_step').set({ status: 'running', attempts: sql`attempts + 1`, started_at: new Date(), error: null }).where('run_id', '=', runId).where('step', '=', step!).execute();
    }
    return { run, done: row.status === 'done' };
  });
  if (!loaded) return;
  const { run } = loaded;
  const steps = SAGAS[run.kind];
  const idx = steps.findIndex((s) => s.name === step);
  const def = steps[idx]!;
  const app = p.catalog.get(run.app)!;

  if (!loaded.done) {
    try {
      await p.ports.telemetry.span('provisioning.step', { 'aod.run': runId, 'aod.step': def.name }, () =>
        p.database.withTenant(tenantId, async (tx) => {
          const fail = await tx.selectFrom('tenant_flag').select('value').where('key', '=', 'provisioning.fail_once').executeTakeFirst();
          if (fail && (fail.value as { step?: string }).step === def.name) {
            await tx.deleteFrom('tenant_flag').where('key', '=', 'provisioning.fail_once').execute();
            // Commit the flag removal, then fail: the next attempt (retry) succeeds.
            return { injected: true };
          }
          const output = (await def.run({ p, tx, run, app, output: {} })) ?? {};
          await tx.updateTable('provisioning_step').set({ status: 'done', output: JSON.stringify(output), finished_at: new Date() }).where('run_id', '=', runId).where('step', '=', def.name).execute();
          if (idx === steps.length - 1) {
            await tx.updateTable('provisioning_run').set({ status: 'succeeded', finished_at: new Date(), version: sql`version + 1` }).where('id', '=', runId).execute();
          }
          return { injected: false };
        }).then((r) => {
          if (r.injected) throw new StepFailed(`injected failure at ${def.name} (demo flag provisioning.fail_once)`);
        }),
      );
    } catch (e) {
      const retryable = !(e instanceof StepFailed) && !(e instanceof CommandError) && retryCount < 2;
      p.log.warn({ err: e, runId, step: def.name, retryable }, 'provisioning step failed');
      await p.database.withTenant(tenantId, async (tx) => {
        await tx.updateTable('provisioning_step').set({ status: retryable ? 'pending' : 'failed', error: (e as Error).message, finished_at: new Date() }).where('run_id', '=', runId).where('step', '=', def.name).execute();
        if (!retryable) {
          await tx.updateTable('provisioning_run').set({ status: 'failed', error: `${def.name}: ${(e as Error).message}`, version: sql`version + 1` }).where('id', '=', runId).execute();
          if (run.kind === 'provision') await tx.updateTable('installed_app').set({ status: 'failed' }).where('app', '=', run.app).where('status', '=', 'provisioning').execute();
        }
      });
      if (retryable) throw e; // pg-boss retries with backoff
      return;
    }
  }

  const next = steps[idx + 1];
  if (next) await enqueueStep(p, tenantId, runId, next.name);
  else if (run.kind === 'provision') {
    // The app is active: replay past events into its consumers (and into consumers
    // whose capability rule just became satisfied). Exactly-once via processed_event.
    await backfillTenant(p, templateConsumers(p), tenantId).catch((e) => p.log.error({ err: e, tenantId }, 'backfill failed'));
  }
}

// ------------------------------------------------------------------ retry / rollback

export async function retryRun(p: Platform, tenantId: string, runId: string, actor: Principal, correlationId: string) {
  const step = await p.database.withTenant(tenantId, async (tx) => {
    const run = await tx.selectFrom('provisioning_run').select(['status', 'app', 'kind']).where('id', '=', runId).executeTakeFirst();
    if (!run) throw new CommandError(404, 'not_found', 'run not found');
    if (run.status !== 'failed') throw new CommandError(409, 'not_failed', `run is ${run.status}`);
    const failed = await tx.selectFrom('provisioning_step').select('step').where('run_id', '=', runId).where('status', '=', 'failed').executeTakeFirstOrThrow();
    await tx.updateTable('provisioning_step').set({ status: 'pending', error: null }).where('run_id', '=', runId).where('step', '=', failed.step).execute();
    await tx.updateTable('provisioning_run').set({ status: 'running', error: null, version: sql`version + 1` }).where('id', '=', runId).execute();
    if (run.kind === 'provision') await tx.updateTable('installed_app').set({ status: 'provisioning' }).where('app', '=', run.app).where('status', '=', 'failed').execute();
    await recordChange(p, tx, { tenantId, actor, action: 'platform:provisioning.retry', resourceType: 'platform::ProvisioningRun', resourceId: runId, correlationId, data: { step: failed.step } });
    return failed.step;
  });
  await p.ports.jobs.send(QUEUES.provisionStep, { tenantId, runId, step, op: 'run' });
}

export async function rollbackRun(p: Platform, tenantId: string, runId: string, actor: Principal, correlationId: string) {
  await p.database.withTenant(tenantId, async (tx) => {
    const run = await tx.selectFrom('provisioning_run').select('status').where('id', '=', runId).executeTakeFirst();
    if (!run) throw new CommandError(404, 'not_found', 'run not found');
    if (run.status !== 'failed') throw new CommandError(409, 'not_failed', `only a failed run can be rolled back (run is ${run.status})`);
    await tx.updateTable('provisioning_run').set({ status: 'compensating', version: sql`version + 1` }).where('id', '=', runId).execute();
    await recordChange(p, tx, { tenantId, actor, action: 'platform:provisioning.rollback', resourceType: 'platform::ProvisioningRun', resourceId: runId, correlationId });
  });
  await p.ports.jobs.send(QUEUES.provisionStep, { tenantId, runId, op: 'compensate' });
}

async function compensateRun(p: Platform, tenantId: string, runId: string) {
  const run = await p.database.withTenant(tenantId, (tx) => tx.selectFrom('provisioning_run').selectAll().where('id', '=', runId).executeTakeFirst() as Promise<Run | undefined>);
  if (!run || run.status !== 'compensating') return;
  const app = p.catalog.get(run.app)!;
  const steps = SAGAS[run.kind];
  for (const def of [...steps].reverse()) {
    await p.database.withTenant(tenantId, async (tx) => {
      const row = await tx.selectFrom('provisioning_step').select(['status', 'output']).where('run_id', '=', runId).where('step', '=', def.name).executeTakeFirstOrThrow();
      if (row.status === 'done') {
        if (def.compensate) await def.compensate({ p, tx, run, app, output: row.output as Record<string, unknown> });
        await tx.updateTable('provisioning_step').set({ status: 'compensated', finished_at: new Date() }).where('run_id', '=', runId).where('step', '=', def.name).execute();
      } else if (row.status !== 'compensated') {
        await tx.updateTable('provisioning_step').set({ status: 'skipped' }).where('run_id', '=', runId).where('step', '=', def.name).execute();
      }
    });
  }
  await p.database.withTenant(tenantId, async (tx) => {
    if (run.kind === 'provision') await tx.updateTable('installed_app').set({ status: 'removed' }).where('app', '=', run.app).where('status', 'in', ['failed', 'provisioning']).execute();
    await tx.updateTable('provisioning_run').set({ status: 'compensated', finished_at: new Date(), version: sql`version + 1` }).where('id', '=', runId).execute();
    await recordChange(p, tx, {
      tenantId,
      actor: system(run),
      action: 'platform:provisioning.compensated',
      resourceType: 'platform::ProvisioningRun',
      resourceId: runId,
      correlationId: run.correlation_id,
      events: [{ type: 'provisioning.compensated', data: { run_id: runId, app: run.app, kind: run.kind } }],
    });
  });
}

export async function runSnapshot(tx: Tx, runId: string) {
  const run = await tx.selectFrom('provisioning_run').selectAll().where('id', '=', runId).executeTakeFirst();
  if (!run) return null;
  const steps = await tx.selectFrom('provisioning_step').select(['step', 'position', 'status', 'attempts', 'error', 'output', 'started_at', 'finished_at']).where('run_id', '=', runId).orderBy('position').execute();
  return { ...(run as Record<string, any>), steps } as Record<string, any> & { status: string; steps: typeof steps };
}
