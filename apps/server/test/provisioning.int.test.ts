import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { retryRun, rollbackRun } from '../src/platform/provisioning.ts';
import { closePlatform, cmd, newTenant, runSaga, setPlan, testPlatform, type TestTenant } from './helpers.ts';

const p = testPlatform();
afterAll(() => closePlatform(p));

const installed = (t: TestTenant, app: string) =>
  p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('installed_app').selectAll().where('app', '=', app).where('status', '<>', 'removed').executeTakeFirst());
const steps = (t: TestTenant, runId: string) =>
  p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('provisioning_step').select(['step', 'status', 'attempts']).where('run_id', '=', runId).orderBy('position').execute());
const failOnce = (t: TestTenant, step: string) =>
  p.database.withTenant(t.tenantId, (tx) => tx.insertInto('tenant_flag').values({ tenant_id: t.tenantId, key: 'provisioning.fail_once', value: JSON.stringify({ step }) }).execute());

describe('provisioning saga', () => {
  it('runs all eight steps and activates the app', async () => {
    const t = await newTenant(p, 'prov');
    const r = await runSaga(p, t, 'ordering');
    expect(r.status).toBe('succeeded');
    expect((await steps(t, r.runId)).map((s) => `${s.step}:${s.status}`)).toEqual([
      'entitlement:done', 'dependencies:done', 'allocate:done', 'migrate_seed:done', 'config_theme:done', 'register_contracts:done', 'health_check:done', 'activate:done',
    ]);
    expect((await installed(t, 'ordering'))?.status).toBe('active');
    const contracts = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('contract_registration').select('kind').where('app', '=', 'ordering').execute());
    expect(contracts.length).toBeGreaterThan(10);
  });

  it('enforces dependencies and trial app-slot limits', async () => {
    const t = await newTenant(p, 'slots');
    const dep = await runSaga(p, t, 'logistics');
    expect(dep).toMatchObject({ status: 'failed' });
    expect(dep.error).toMatch(/requires Ordering/);
    await rollbackRun(p, t.tenantId, dep.runId, t.owner, randomUUID());
    await p.jobs.runAll();
    for (const app of ['ordering', 'payments', 'pos']) expect((await runSaga(p, t, app)).status).toBe('succeeded');
    const full = await runSaga(p, t, 'logistics');
    expect(full.error).toMatch(/app slots/);
  });

  it('retries from the failed step only', async () => {
    const t = await newTenant(p, 'retry');
    await failOnce(t, 'health_check');
    const r = await runSaga(p, t, 'ordering');
    expect(r.status).toBe('failed');
    expect((await installed(t, 'ordering'))?.status).toBe('failed');
    await retryRun(p, t.tenantId, r.runId, t.owner, randomUUID());
    await p.jobs.runAll();
    const s = await steps(t, r.runId);
    expect(s.every((x) => x.status === 'done')).toBe(true);
    // earlier steps ran once; the failed one twice
    expect(s.find((x) => x.step === 'migrate_seed')!.attempts).toBe(1);
    expect(s.find((x) => x.step === 'health_check')!.attempts).toBe(2);
    expect((await installed(t, 'ordering'))?.status).toBe('active');
  });

  it('compensates completed steps in reverse on rollback', async () => {
    const t = await newTenant(p, 'comp');
    await failOnce(t, 'activate');
    const r = await runSaga(p, t, 'pos');
    expect(r.status).toBe('failed');
    const storesBefore = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('pos_store').select('id').execute());
    expect(storesBefore).toHaveLength(1); // seeded by migrate_seed
    await rollbackRun(p, t.tenantId, r.runId, t.owner, randomUUID());
    await p.jobs.runAll();
    const run = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('provisioning_run').select('status').where('id', '=', r.runId).executeTakeFirstOrThrow());
    expect(run.status).toBe('compensated');
    expect(await installed(t, 'pos')).toBeUndefined();
    expect(await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('pos_store').select('id').execute())).toHaveLength(0);
    expect((await steps(t, r.runId)).map((s) => s.status)).toEqual(['compensated', 'compensated', 'compensated', 'compensated', 'compensated', 'compensated', 'compensated', 'skipped']);
    // provisioning again works after compensation
    expect((await runSaga(p, t, 'pos')).status).toBe('succeeded');
  });

  it('deprovisions with retain (restorable) or purge, guarding dependents', async () => {
    const t = await newTenant(p, 'deprov');
    await runSaga(p, t, 'ordering');
    await runSaga(p, t, 'logistics');
    await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: [{ sku: 'X', name: 'X', qty: 1, unit_price: 5 }] });
    const blocked = await runSaga(p, t, 'ordering', 'deprovision', { mode: 'retain' });
    expect(blocked.error).toMatch(/depend on ordering/);
    await rollbackRun(p, t.tenantId, blocked.runId, t.owner, randomUUID());
    await p.jobs.runAll();
    expect((await installed(t, 'ordering'))?.status).toBe('active');

    expect((await runSaga(p, t, 'logistics', 'deprovision', { mode: 'purge' })).status).toBe('succeeded');
    expect(await installed(t, 'logistics')).toBeUndefined();
    expect((await runSaga(p, t, 'ordering', 'deprovision', { mode: 'retain' })).status).toBe('succeeded');
    const kept = await installed(t, 'ordering');
    expect(kept?.status).toBe('retained');
    expect(new Date(kept!.retained_until).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    // Re-provisioning restores the retained data instead of seeding.
    expect((await runSaga(p, t, 'ordering')).status).toBe('succeeded');
    const orders = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('ord_order').select('id').execute());
    expect(orders).toHaveLength(1);
  });

  it('upgrades along a release channel with expand-only migrations, and respects pins', async () => {
    const t = await newTenant(p, 'upgrade');
    expect((await runSaga(p, t, 'ordering')).status).toBe('succeeded');
    expect((await installed(t, 'ordering'))?.version).toBe('1.0.0');
    await p.database.withTenant(t.tenantId, (tx) => tx.insertInto('app_pin').values({ tenant_id: t.tenantId, app: 'ordering', version: '1.0.0' }).execute());
    await expect(runSaga(p, t, 'ordering', 'upgrade', { channel: 'canary' })).rejects.toThrow(/pinned/);
    await p.database.withTenant(t.tenantId, (tx) => tx.deleteFrom('app_pin').execute());
    const up = await runSaga(p, t, 'ordering', 'upgrade', { channel: 'canary' });
    expect(up.status).toBe('succeeded');
    expect(await installed(t, 'ordering')).toMatchObject({ version: '1.1.0', channel: 'canary' });
  });

  it('backfills consumers when a capability becomes active', async () => {
    const t = await newTenant(p, 'backfill');
    await setPlan(p, t, 'growth');
    await runSaga(p, t, 'ordering');
    const o = await cmd(p, t, 'ordering', 'order.create', { channel: 'phone', lines: [{ sku: 'X', name: 'X', qty: 1, unit_price: 5 }] });
    await p.ports.eventBus.drain(); // logistics not installed yet: its consumer skips
    await runSaga(p, t, 'logistics');
    const known = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('lgx_order').select(['order_id', 'number']).execute());
    expect(known).toEqual([{ order_id: o.body.id, number: o.body.number }]);
  });
});
