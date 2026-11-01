import { randomUUID } from 'node:crypto';
import { Definition, type FieldDef, type Principal } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileTooLarge } from '../src/adapters/pg-files.ts';
import { principalFor } from '../src/auth/principal.ts';
import { SESSION_COOKIE, createSession } from '../src/auth/sessions.ts';
import { newId, type Tx } from '../src/db/database.ts';
import { buildApp } from '../src/http/app.ts';
import { listDashboards, saveDashboard } from '../src/platform/analytics/dashboards.ts';
import { ensureMetrics, forgetSpecs, metricsConsumer, reconcileTenant } from '../src/platform/analytics/metrics.ts';
import { queryMetric } from '../src/platform/analytics/query.ts';
import { runDueSchedules, runReport, saveReport } from '../src/platform/analytics/reports.ts';
import { openDraft, publishDraft, saveDraft, sendJobs } from '../src/platform/datastudio.ts';
import { accessReview, exportAuditLog, piiInventory, runDsr, runRetention, saveRetentionPolicy } from '../src/platform/governance.ts';
import { executeRecordWrite } from '../src/platform/records.ts';
import { closePlatform, cmd, newTenant, runSaga, setPlan, testPlatform, type TestTenant } from './helpers.ts';

const p = testPlatform();
let t: TestTenant;
let registerId: string;
const cid = () => randomUUID();
const inTenant = <T>(fn: (tx: Tx) => Promise<T>, tenant = () => t.tenantId): Promise<T> => p.database.withTenant(tenant(), fn);
const hour = 3_600_000;
const range = () => ({ from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date(Date.now() + hour).toISOString() });
const q = (metric: string, extra: Record<string, unknown> = {}, principal: Principal = t.owner) => inTenant((tx) => queryMetric(p, tx, principal, { metric, ...range(), filters: {}, compare: false, ...extra } as any));

/** Event bus + queued jobs (rebuilds) until quiet. */
async function settle() {
  for (let i = 0; i < 6; i++) {
    await p.ports.eventBus.drain();
    await p.jobs.runAll();
  }
}
async function readFile(tenantId: string, id: string): Promise<Buffer> {
  const f = await p.ports.files.open(tenantId, id);
  const parts: Buffer[] = [];
  for await (const c of f!.stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}
const order = (store: string, total: number, extra: Record<string, unknown> = {}) => cmd(p, t, 'ordering', 'order.create', { channel: 'web', store, lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: total }], ...extra });
async function sale(store: string, total: number) {
  const id = randomUUID();
  const r = await cmd(p, t, 'pos', 'sale.complete', { id, register_id: registerId, lines: [{ sku: 'X', name: 'X', qty: 1, unit_price: total }], tender: 'cash', sold_at: new Date().toISOString() });
  return { id, version: r.body.version as number, store };
}
const field = (key: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: key, type: 'text', options: [], required: false, pii: false, indexed: false, default: null, ...extra });
async function publish(fn: (d: Definition) => void) {
  const r = await inTenant(async (tx) => {
    const draft = await openDraft(p, tx, t.tenantId, t.owner, cid());
    const def = Definition.parse(draft.definition);
    fn(def);
    const saved = await saveDraft(p, tx, t.tenantId, t.owner, def, draft.version, undefined, cid());
    return publishDraft(p, tx, t.tenantId, t.owner, saved.version, cid());
  });
  await sendJobs(p, r.jobs);
  await p.jobs.runAll();
  forgetSpecs(t.tenantId);
}
async function roleUser(name: string, permissions: string[], fieldRules: unknown[] = []) {
  const roleId = newId();
  const userId = newId();
  await inTenant(async (tx) => {
    await tx.insertInto('custom_role').values({ id: roleId, tenant_id: t.tenantId, name, permissions, field_rules: JSON.stringify(fieldRules) }).execute();
    await tx.insertInto('app_user').values({ id: userId, tenant_id: t.tenantId, email: `${name.toLowerCase().replace(/\W/g, '')}@an.example`, name, role: roleId, status: 'active' }).execute();
  });
  return { roleId, userId, principal: await inTenant((tx) => principalFor(tx, p.catalog, t.tenantId, { id: userId, role: roleId })) };
}

beforeAll(async () => {
  t = await newTenant(p, 'an');
  await setPlan(p, t, 'growth');
  for (const app of ['ordering', 'payments', 'pos']) expect((await runSaga(p, t, app)).status).toBe('succeeded');
  registerId = ((await inTenant((tx) => tx.selectFrom('pos_register').select('id').execute())) as { id: string }[])[0]!.id;
  await cmd(p, t, 'pos', 'shift.open', { register_id: registerId });
});
afterAll(() => closePlatform(p));

describe('metrics pipeline', () => {
  it('backfills history with a rebuild, then follows new events; voids come back out of takings', async () => {
    // History written before anything asked for metrics.
    await order('Kemang', 100_000);
    await order('Senopati', 50_000, { channel: 'phone' });
    await p.ports.eventBus.drain();
    expect(await ensureMetrics(p, t.tenantId)).toEqual(expect.arrayContaining(['ordering:orders', 'ordering:revenue', 'pos:takings', 'payments:captured_amount']));
    await settle();
    const states = await inTenant((tx) => tx.selectFrom('metric_state').select(['metric', 'status']).execute());
    expect(states.every((s) => s.status === 'ready')).toBe(true);

    // Now incremental: the consumer adds new events.
    await order('Kemang', 25_000);
    const s1 = await sale('Blok M', 80_000);
    await sale('Blok M', 20_000);
    await cmd(p, t, 'pos', 'sale.void', { id: s1.id, version: s1.version, reason: 'test' });
    await settle();

    const revenue = await q('ordering:revenue');
    const fromPos = 100_000; // the two POS sales also became orders (pos_sales consumer)
    expect(revenue.total).toBe(175_000 + fromPos);
    expect((await q('ordering:orders')).total).toBe(5);
    const takings = await q('pos:takings');
    expect(takings.total).toBe(20_000);
    expect((await q('pos:sales')).total).toBe(1);
    const byStore = await q('ordering:revenue', { group_by: 'store' });
    expect(byStore.series.find((r) => r.key === 'Kemang')!.value).toBe(125_000);
    const kemangOnly = await q('ordering:revenue', { filters: { store: ['Kemang'] } });
    expect(kemangOnly.total).toBe(125_000);
    const phone = await q('ordering:orders', { filters: { channel: ['phone'] } });
    expect(phone.total).toBe(1);
    const kpi = await q('ordering:revenue', { compare: true });
    expect(kpi.previous).toBe(0);
    expect(kpi.series.length).toBeGreaterThan(0);
    expect(kpi.granularity).toBe('day');
  });

  it('a rebuild gives the same numbers as the incremental path; reconciliation finds drift and rebuilds', async () => {
    const before = await q('ordering:revenue', { group_by: 'store' });
    await p.jobs.send('analytics-metric-rebuild', { tenantId: t.tenantId, metric: 'ordering:revenue' });
    await settle();
    expect(await q('ordering:revenue', { group_by: 'store' })).toEqual(before);

    expect(await reconcileTenant(p, t.tenantId)).toEqual([]);
    // Corrupt a bucket; the nightly check finds it and rebuilds once (it was rebuilt just now,
    // so the first check records "drift persists" and does not loop).
    await inTenant((tx) => tx.updateTable('metric_bucket').set({ value: sql`value + 999` }).where('metric', '=', 'ordering:revenue').execute());
    await inTenant((tx) => tx.updateTable('metric_state').set({ rebuilt_at: new Date(Date.now() - 2 * 86_400_000) }).where('metric', '=', 'ordering:revenue').execute());
    expect(await reconcileTenant(p, t.tenantId)).toEqual(['ordering:revenue']);
    await settle();
    expect(await reconcileTenant(p, t.tenantId)).toEqual([]);
    const checks = await inTenant((tx) => tx.selectFrom('metric_check').select(['metric', 'ok', 'action']).where('metric', '=', 'ordering:revenue').orderBy('checked_at').execute());
    expect(checks.map((c) => c.action)).toEqual(['none', 'rebuild', 'none']);
  });

  it('a Data studio metric over a custom entity counts records', async () => {
    await publish((d) => {
      d.entities.push({ key: 'member', label: 'Member', title_field: 'name', fields: [field('name', { required: true }), field('email', { pii: true }), field('city')], rollups: [], rules: [] });
      d.metrics.push({ key: 'members', label: 'Members', entity: 'member', aggregate: 'count', dims: { store: 'city' } });
    });
    for (const city of ['Kemang', 'Kemang', 'Cikini']) await executeRecordWrite(p, { tenantId: t.tenantId, principal: t.owner, entity: 'member', op: 'create', values: { name: `M ${city}`, city, email: `${city.toLowerCase()}@member.example` }, correlationId: cid() });
    await ensureMetrics(p, t.tenantId);
    await settle();
    const m = await q('custom:members', { group_by: 'store' });
    expect(m.total).toBe(3);
    expect(m.series.find((r) => r.key === 'Kemang')!.value).toBe(2);
  });

  it('counts events that arrive before a metric has state, and the rebuild that follows does not double them', async () => {
    const fresh = await newTenant(p, 'an-race');
    await setPlan(p, fresh, 'growth');
    expect((await runSaga(p, fresh, 'ordering')).status).toBe('succeeded');
    await cmd(p, fresh, 'ordering', 'order.create', { channel: 'web', store: 'X', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 10 }] });
    await p.ports.eventBus.drain(); // consumer only: no rebuild has run yet
    const total = () => p.database.withTenant(fresh.tenantId, (tx) => queryMetric(p, tx, fresh.owner, { metric: 'ordering:orders', ...range(), filters: {}, compare: false }));
    expect((await total()).total).toBe(1);
    await p.jobs.runAll(); // the requested rebuild resets and replays
    expect((await total()).total).toBe(1);
    await cmd(p, fresh, 'ordering', 'order.create', { channel: 'web', store: 'X', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 10 }] });
    await settle();
    expect((await total()).total).toBe(2);
  });

  it('skips (never throws on) events of a tenant that no longer exists, so the consumer cannot stall', async () => {
    const gone = randomUUID();
    const ev = { id: randomUUID(), type: 'order.created', tenant_id: gone, occurred_at: new Date().toISOString(), data: { total: 1 } } as any;
    await expect(p.database.withTenant(gone, (tx) => metricsConsumer(p).handle(ev, tx))).resolves.toBe('skipped');
  });

  it('needs the Analytics package, the entity read permission, and respects hidden fields', async () => {
    const starter = await newTenant(p, 'an-starter');
    await expect(p.database.withTenant(starter.tenantId, (tx) => queryMetric(p, tx, starter.owner, { metric: 'ordering:revenue', ...range(), filters: {}, compare: false }))).rejects.toMatchObject({ code: 'not_in_plan' });

    const noOrders = await roleUser('Analyst no orders', ['platform:analytics.read', 'pos:sale.read']);
    await expect(q('ordering:revenue', {}, noOrders.principal)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await q('pos:takings', {}, noOrders.principal)).total).toBe(20_000);

    const hidden = await roleUser('Analyst hidden total', ['platform:analytics.read', 'ordering:order.read'], [
      { resource: 'ordering::Order', field: 'total', access: 'hidden' },
      { resource: 'ordering::Order', field: 'store', access: 'hidden' },
    ]);
    await expect(q('ordering:revenue', {}, hidden.principal)).rejects.toMatchObject({ code: 'field_hidden' });
    expect((await q('ordering:orders', {}, hidden.principal)).total).toBe(5); // a count aggregates no field
    await expect(q('ordering:orders', { group_by: 'store' }, hidden.principal)).rejects.toMatchObject({ code: 'field_hidden' });
    // Default dashboards leave out what the viewer cannot see.
    const boards = await inTenant((tx) => listDashboards(p, tx, hidden.principal, hidden.roleId));
    expect(JSON.stringify(boards)).not.toContain('ordering:revenue');
  });
});

describe('dashboards', () => {
  it('lists built-in defaults; saved dashboards are validated and shared per role', async () => {
    const boards = await inTenant((tx) => listDashboards(p, tx, t.owner, 'Owner'));
    expect(boards.map((b) => b.id)).toEqual(expect.arrayContaining(['default:overview', 'default:ordering', 'default:pos']));
    const overview = boards.find((b) => b.id === 'default:overview')!;
    expect(overview.widgets.map((w) => w.kind)).toEqual(expect.arrayContaining(['kpi', 'timeseries', 'bar', 'table']));

    await expect(inTenant((tx) => saveDashboard(p, tx, t.tenantId, t.owner, { name: 'Bad', widgets: [{ id: 'w1', kind: 'bar', title: 'x', metric: 'payments:captured_amount', group_by: 'store' }] }, cid()))).rejects.toMatchObject({ code: 'invalid_widget' });
    const analyst = await roleUser('Store analyst', ['platform:analytics.read', 'ordering:order.read']);
    const { id } = await inTenant((tx) => saveDashboard(p, tx, t.tenantId, t.owner, { name: 'Stores', widgets: [{ id: 'w1', kind: 'bar', title: 'Orders per store', metric: 'ordering:orders', group_by: 'store' }] }, cid()));
    const seen = async () => (await inTenant((tx) => listDashboards(p, tx, analyst.principal, analyst.roleId))).some((b) => b.id === id);
    expect(await seen()).toBe(false);
    const cur = await inTenant((tx) => tx.selectFrom('dashboard').select('version').where('id', '=', id).executeTakeFirstOrThrow());
    await inTenant((tx) => saveDashboard(p, tx, t.tenantId, t.owner, { name: 'Stores', widgets: [{ id: 'w1', kind: 'bar', title: 'Orders per store', metric: 'ordering:orders', group_by: 'store' }], shared_roles: [analyst.roleId] }, cid(), { id, version: cur.version }));
    expect(await seen()).toBe(true);
  });
});

describe('reports and files', () => {
  it('exports CSV and PDF into Files, runs on a schedule, and serves signed expiring downloads', async () => {
    const { id } = await inTenant((tx) =>
      saveReport(p, tx, t.tenantId, t.owner, { name: 'Store revenue', query: { metrics: ['ordering:revenue', 'ordering:orders'], range: 'last_7_days', group_by: 'store' }, schedule: { every: 'day', hour: 6, format: 'csv' } }, cid()),
    );
    const csvRun = await runReport(p, t.tenantId, t.owner, id, { format: 'csv', trigger: 'manual', correlationId: cid() });
    const csv = (await readFile(t.tenantId, csvRun.file_id)).toString();
    expect(csv.split('\r\n')[0]).toBe('Store,Revenue,Orders');
    expect(csv).toContain('Kemang,125000,2');
    const pdfRun = await runReport(p, t.tenantId, t.owner, id, { format: 'pdf', trigger: 'manual', correlationId: cid() });
    expect((await readFile(t.tenantId, pdfRun.file_id)).subarray(0, 5).toString()).toBe('%PDF-');

    // Schedule: due now -> the minute job runs it as the owner and sets the next run.
    await inTenant((tx) => tx.updateTable('report').set({ next_run_at: new Date(Date.now() - 1000) }).where('id', '=', id).execute());
    expect(await runDueSchedules(p)).toBe(1);
    const runs = await inTenant((tx) => tx.selectFrom('report_run').select(['trigger', 'status']).where('report_id', '=', id).execute());
    expect(runs.filter((r) => r.trigger === 'schedule' && r.status === 'succeeded')).toHaveLength(1);
    const next = await inTenant((tx) => tx.selectFrom('report').select('next_run_at').where('id', '=', id).executeTakeFirstOrThrow());
    expect(new Date(next.next_run_at!).getUTCHours()).toBe(6);
    expect(new Date(next.next_run_at!).getTime()).toBeGreaterThan(Date.now());

    // Signed downloads over HTTP: valid, tampered, expired, other tenant.
    const app: FastifyInstance = await buildApp(p);
    try {
      const ok = await app.inject({ url: `/api/files/download?token=${p.ports.files.signToken(t.tenantId, csvRun.file_id, 60)}` });
      expect(ok.statusCode, ok.body.slice(0, 300)).toBe(200);
      expect(ok.headers['content-disposition']).toMatch(/attachment; filename="Store revenue/);
      expect(ok.body).toBe(csv);
      const token = p.ports.files.signToken(t.tenantId, csvRun.file_id, 60);
      expect((await app.inject({ url: `/api/files/download?token=${token.slice(0, -2)}xx` })).statusCode).toBe(403);
      expect((await app.inject({ url: `/api/files/download?token=${p.ports.files.signToken(t.tenantId, csvRun.file_id, -1)}` })).statusCode).toBe(403);
      const other = await newTenant(p, 'an-other');
      expect((await app.inject({ url: `/api/files/download?token=${p.ports.files.signToken(other.tenantId, csvRun.file_id, 60)}` })).statusCode).toBe(404);
      // HTTP: a Staff user cannot read reports; the Owner sees runs with links.
      const staffId = newId();
      await inTenant((tx) => tx.insertInto('app_user').values({ id: staffId, tenant_id: t.tenantId, email: 'staff@an.example', name: 'S', role: 'Staff', status: 'active' }).execute());
      const staff = `${SESSION_COOKIE}=${(await inTenant((tx) => createSession(tx, t.tenantId, staffId, 'magic_link'))).cookie}`;
      expect((await app.inject({ url: '/api/reports', headers: { cookie: staff } })).statusCode).toBe(403);
      const owner = `${SESSION_COOKIE}=${t.cookie}`;
      const list = (await app.inject({ url: '/api/reports', headers: { cookie: owner } })).json();
      expect(list.reports[0].runs[0].download_url).toMatch(/^\/api\/files\/download\?token=/);
    } finally {
      await app.close();
    }
  });

  it('streams files in chunks under RLS and refuses oversized bodies without storing anything', async () => {
    async function* body(n: number) {
      for (let i = 0; i < n; i++) yield Buffer.alloc(100 * 1024, i % 256);
    }
    const f = await p.ports.files.put(t.tenantId, { name: 'big.bin', contentType: 'application/octet-stream', purpose: 'test', createdBy: t.ownerId }, body(6), { maxBytes: 1024 * 1024 });
    expect(f.size).toBe(600 * 1024);
    const chunks = await inTenant((tx) => tx.selectFrom('file_chunk').select(sql<number>`count(*)::int`.as('n')).where('file_id', '=', f.id).executeTakeFirstOrThrow());
    expect(chunks.n).toBe(3); // 256 KB chunks
    expect((await readFile(t.tenantId, f.id)).length).toBe(600 * 1024);
    const other = await newTenant(p, 'an-rls');
    expect(await p.ports.files.open(other.tenantId, f.id)).toBeNull();
    const before = await inTenant((tx) => tx.selectFrom('file_object').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow());
    await expect(p.ports.files.put(t.tenantId, { name: 'too-big.bin', contentType: 'application/octet-stream', purpose: 'test', createdBy: t.ownerId }, body(20), { maxBytes: 1024 * 1024 })).rejects.toBeInstanceOf(FileTooLarge);
    const after = await inTenant((tx) => tx.selectFrom('file_object').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow());
    expect(after.n).toBe(before.n);
  });
});

describe('data governance', () => {
  it('lists PII from manifests and Data studio, and reviews who can read each field', async () => {
    const inv = await inTenant((tx) => piiInventory(p, tx));
    expect(inv.map((f) => `${f.target}.${f.field}`)).toEqual(expect.arrayContaining(['ordering:order.customer_name', 'ordering:order.customer_phone', 'custom:member.email']));
    await roleUser('No names', ['ordering:order.read'], [{ resource: 'ordering::Order', field: 'customer_name', access: 'hidden' }]);
    const review = await inTenant((tx) => accessReview(p, tx));
    const names = review.find((f) => f.target === 'ordering:order' && f.field === 'customer_name')!;
    expect(names.roles.map((r) => r.name)).toEqual(expect.arrayContaining(['Owner', 'Manager', 'Viewer']));
    expect(names.roles.map((r) => r.name)).not.toContain('No names');
  });

  it('a retention policy anonymises old customer names and keeps totals, audited', async () => {
    const old = await order('Cikini', 42_000, { customer_name: 'Rina Old', customer_phone: '0812-1111-2222' });
    const recent = await order('Cikini', 43_000, { customer_name: 'Dewi New' });
    await inTenant((tx) => tx.updateTable('ord_order').set({ created_at: new Date(Date.now() - 400 * 86_400_000) }).where('id', '=', old.body.id).execute());
    await expect(inTenant((tx) => saveRetentionPolicy(p, tx, t.tenantId, t.owner, { target: 'ordering:order', action: 'purge', after_days: 365 }, cid()))).rejects.toMatchObject({ code: 'purge_not_allowed' });
    const { id } = await inTenant((tx) => saveRetentionPolicy(p, tx, t.tenantId, t.owner, { target: 'ordering:order', action: 'anonymise', after_days: 365 }, cid()));
    const [res] = await runRetention(p, t.tenantId, { policyId: id, correlationId: 'retention-test' });
    expect(res!.records).toBeGreaterThanOrEqual(1);
    const rows = await inTenant((tx) => tx.selectFrom('ord_order').select(['id', 'customer_name', 'customer_phone', 'total']).where('id', 'in', [old.body.id, recent.body.id]).execute());
    const o = rows.find((r) => r.id === old.body.id)!;
    expect(o).toMatchObject({ customer_name: '[anonymised]', customer_phone: '[anonymised]' });
    expect(Number(o.total)).toBe(42_000);
    expect(rows.find((r) => r.id === recent.body.id)!.customer_name).toBe('Dewi New');
    const audit = await inTenant((tx) => tx.selectFrom('audit_log').select(['action', 'data']).where('correlation_id', '=', 'retention-test').execute());
    expect(audit).toEqual([expect.objectContaining({ action: 'platform:retention.applied' })]);
    expect(JSON.stringify(audit)).not.toContain('Rina');
    // A second run finds nothing left to do.
    const [again] = await runRetention(p, t.tenantId, { policyId: id, correlationId: cid() });
    expect(again!.records).toBe(0);
  });

  it('a data subject request exports and then erases a test customer, keeping amounts and audit', async () => {
    const phone = '+62 813-5555-0101';
    const o1 = await order('Kemang', 61_000, { customer_name: 'Sari Test', customer_phone: phone });
    const o2 = await order('Senopati', 62_000, { customer_name: 'Sari T.', customer_phone: '081355550101' });
    await executeRecordWrite(p, { tenantId: t.tenantId, principal: t.owner, entity: 'member', op: 'create', values: { name: 'Sari', city: 'Kemang', email: 'sari@subject.example' }, correlationId: cid() });

    const exp = await runDsr(p, t.tenantId, t.owner, { kind: 'export', subject: '+62 813 5555 0101' }, 'dsr-export');
    expect(exp.found.map((f) => f.id)).toEqual(expect.arrayContaining([o1.body.id, o2.body.id]));
    const file = JSON.parse((await readFile(t.tenantId, exp.file_id!)).toString());
    expect(JSON.stringify(file)).toContain('Sari Test');
    const byEmail = await runDsr(p, t.tenantId, t.owner, { kind: 'export', subject: 'SARI@subject.example' }, cid());
    expect(byEmail.found.map((f) => f.type)).toEqual(['custom:member']);

    const er = await runDsr(p, t.tenantId, t.owner, { kind: 'erase', subject: phone }, 'dsr-erase');
    expect(er.found.length).toBe(2);
    const rows = await inTenant((tx) => tx.selectFrom('ord_order').select(['customer_name', 'customer_phone', 'total']).where('id', 'in', [o1.body.id, o2.body.id]).execute());
    expect(rows.every((r) => r.customer_name === '[erased]' && r.customer_phone === '[erased]')).toBe(true);
    expect(rows.map((r) => Number(r.total)).sort()).toEqual([61_000, 62_000]);
    await runDsr(p, t.tenantId, t.owner, { kind: 'erase', subject: 'sari@subject.example' }, cid());
    const member = await inTenant((tx) => tx.selectFrom('custom_record').select('data').where('entity', '=', 'member').where(sql<boolean>`data ->> 'name' = 'Sari'`).executeTakeFirstOrThrow());
    expect((member.data as Record<string, unknown>).email ?? null).toBeNull();

    // Audited without the subject; the request stores the subject only encrypted.
    const audit = await inTenant((tx) => tx.selectFrom('audit_log').select(['action', 'data']).where('correlation_id', 'in', ['dsr-export', 'dsr-erase']).execute());
    expect(audit.map((a) => a.action).sort()).toEqual(['platform:dsr.erase', 'platform:dsr.export']);
    expect(JSON.stringify(audit)).not.toMatch(/5555|Sari/);
    const stored = await inTenant((tx) => tx.selectFrom('dsr_request').select('subject_enc').execute());
    expect(JSON.stringify(stored)).not.toMatch(/5555|subject\.example/);
  });

  it('exports the audit log as CSV', async () => {
    const r = await exportAuditLog(p, t.tenantId, t.owner, { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() }, cid());
    const csv = (await readFile(t.tenantId, r.file_id)).toString();
    expect(csv.split('\r\n')[0]).toBe('at,actor_type,actor_id,action,resource_type,resource_id,correlation_id,data');
    expect(r.rows).toBeGreaterThan(10);
    expect(csv).toContain('platform:retention.applied');
  });
});
