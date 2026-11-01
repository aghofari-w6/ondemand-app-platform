import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLoginToken } from '../src/auth/sessions.ts';
import { Definition, EndpointInput, type WorkflowGraph } from '@aod/shared';
import { clientCredentialsGrant, createApiKey, createDelegatedToken, createOAuthClient } from '../src/auth/apiauth.ts';
import { newId } from '../src/db/database.ts';
import { openDraft, publishDraft, saveDraft, sendJobs } from '../src/platform/datastudio.ts';
import { applyInbound, saveEndpoint } from '../src/platform/hub.ts';
import { executeRecordWrite } from '../src/platform/records.ts';
import { principalFor } from '../src/auth/principal.ts';
import { decideApproval } from '../src/platform/approvals.ts';
import { createWorkflow, publishWorkflow } from '../src/platform/workflows/definitions.ts';
import { saveDashboard } from '../src/platform/analytics/dashboards.ts';
import { ensureMetrics, reconcileTenant } from '../src/platform/analytics/metrics.ts';
import { runReport, saveReport } from '../src/platform/analytics/reports.ts';
import { runDsr, saveRetentionPolicy } from '../src/platform/governance.ts';
import { admin, closePlatform, cmd, newTenant, runSaga, setPlan, testPlatform, type TestTenant } from './helpers.ts';

/**
 * Two-tenant isolation over EVERY tenant table.
 *
 * Tables are discovered from the catalog, not listed by hand: a new table with a
 * `tenant_id` column and no forced RLS policy fails this test, and a new table
 * without `tenant_id` must be explicitly declared global below.
 */
const GLOBAL_TABLES = new Set(['consumer_cursor']);
const isMigrationsTable = (t: string) => t === 'pgmigrations' || t.startsWith('pgmigrations_');

const p = testPlatform();
let db: pg.Pool;
let A: TestTenant;
let B: TestTenant;
let tables: { name: string; tenantCol: string }[] = [];

async function populate(t: TestTenant) {
  await setPlan(p, t, 'growth');
  for (const app of ['ordering', 'payments', 'pos', 'logistics']) {
    const r = await runSaga(p, t, app);
    expect(r.status, `${app}: ${r.error}`).toBe('succeeded');
  }
  await p.database.withTenant(t.tenantId, async (tx) => {
    await tx.insertInto('field_definition').values({ id: newId(), tenant_id: t.tenantId, app: 'ordering', entity: 'order', key: 'table_no', label: 'Table', type: 'text' }).execute();
    await tx.insertInto('custom_role').values({ id: newId(), tenant_id: t.tenantId, name: 'Cashier', permissions: ['pos:sale.ring'] }).execute();
    await tx.insertInto('sso_config').values({ tenant_id: t.tenantId, kind: 'oidc', config: JSON.stringify({ issuer: 'https://idp.example', clientId: 'x' }) }).execute();
    await tx.insertInto('sso_attempt').values({ id: newId(), tenant_id: t.tenantId, kind: 'oidc', state: `${t.tenantId}.s${randomUUID()}` }).execute();
    await tx.insertInto('app_pin').values({ tenant_id: t.tenantId, app: 'payments', version: '1.0.0' }).execute();
    await tx.insertInto('tenant_flag').values({ tenant_id: t.tenantId, key: 'demo', value: '{}' }).execute();
    await createLoginToken(tx, t.tenantId, t.ownerId, 'invite');
  });
  const order = await cmd(p, t, 'ordering', 'order.create', { channel: 'web', customer_name: 'Ana', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 10 }], custom: { table_no: '4' } }, { key: `k-${randomUUID()}` });
  const regs = (await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('pos_register').select('id').execute())) as { id: string }[];
  await cmd(p, t, 'pos', 'shift.open', { register_id: regs[0]!.id });
  await cmd(p, t, 'pos', 'sale.complete', { id: randomUUID(), register_id: regs[0]!.id, lines: [{ sku: 'L', name: 'Latte', qty: 1, unit_price: 38000 }], tender: 'card', sold_at: new Date().toISOString() });
  await cmd(p, t, 'payments', 'payment.capture', { reference: 'manual-1', amount: 1000 });
  await cmd(p, t, 'logistics', 'carrier.connect', { carrier: 'jne' });
  await p.ports.eventBus.drain();
  await cmd(p, t, 'logistics', 'shipment.create', { order_id: order.body.id, carrier: 'jne' });
  await populatePhase2(t);
}

/** Milestone B tables, through the real code paths. */
async function populatePhase2(t: TestTenant) {
  const c = () => randomUUID();
  // Data studio: mark the existing custom field as PII (backfill), add an indexed field,
  // a custom entity with a link field, field access and a layout; then publish.
  const r = await p.database.withTenant(t.tenantId, async (tx) => {
    const draft = await openDraft(p, tx, t.tenantId, t.owner, c());
    const def = Definition.parse(draft.definition);
    const set = def.app_fields.find((s) => s.app === 'ordering' && s.entity === 'order')!;
    set.fields[0]!.pii = true;
    set.fields.push({ key: 'lane', label: 'Lane', type: 'text', options: [], required: false, pii: false, indexed: true, default: null });
    def.entities.push({ key: 'supplier', label: 'Supplier', title_field: 'name', fields: [{ key: 'name', label: 'Name', type: 'text', options: [], required: true, pii: false, indexed: false, default: null }, { key: 'order', label: 'Order', type: 'link', link: 'ordering:order', options: [], required: false, pii: false, indexed: false, default: null }], rollups: [], rules: [] });
    def.field_access.push({ role: 'Staff', target: 'ordering:order', field: 'total', access: 'hidden' });
    def.layouts.push({ target: 'custom:supplier', kind: 'list', columns: ['name'], sections: [], card_fields: [] });
    const saved = await saveDraft(p, tx, t.tenantId, t.owner, def, draft.version, undefined, c());
    return publishDraft(p, tx, t.tenantId, t.owner, saved.version, c());
  });
  await sendJobs(p, r.jobs);
  await p.jobs.runAll();
  const order = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('ord_order').select('id').executeTakeFirstOrThrow());
  await executeRecordWrite(p, { tenantId: t.tenantId, principal: t.owner, entity: 'supplier', op: 'create', values: { name: 'Kopi Nusantara', order: order.id }, correlationId: c() });
  // Integration Hub: connector, endpoint (unreachable on purpose: produces an attempt), sync with one mapped record.
  await p.database.withTenant(t.tenantId, async (tx) => {
    await tx.insertInto('hub_connector').values({ id: c(), tenant_id: t.tenantId, name: 'noop', spec: JSON.stringify({ steps: [{ kind: 'map', fields: { id: 'id' } }] }) }).execute();
    const ep = await saveEndpoint(p, tx, t.tenantId, t.owner, EndpointInput.parse({ kind: 'webhook', name: 'iso', event_types: ['order.*'], config: { url: 'http://127.0.0.1:9/hook' } }), c());
    await tx.insertInto('hub_sync').values({ id: c(), tenant_id: t.tenantId, name: 'erp', entity: 'supplier', endpoint_id: ep.id, conflict_rule: 'platform_wins' }).execute();
  });
  const sync = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('hub_sync').select('id').executeTakeFirstOrThrow());
  await applyInbound(p, t.tenantId, t.owner, sync.id, { external_id: 'ERP-1', updated_at: new Date().toISOString(), data: { name: 'From ERP' }, deleted: false }, 'iso');
  await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 10 }] });
  await p.ports.eventBus.drain();
  await p.workers.hub.drain();
  // Public API credentials.
  await p.database.withTenant(t.tenantId, async (tx) => {
    await createApiKey(p, tx, t.tenantId, t.owner, { name: 'k', scopes: ['records:read'] }, c());
    const client = await createOAuthClient(p, tx, t.tenantId, t.owner, { name: 'cl', scopes: ['apps:read'] }, c());
    await createDelegatedToken(p, tx, t.tenantId, t.owner, { name: 'd', scopes: ['apps:read'], expires_in_minutes: 30 }, c());
    return client;
  }).then((client) => clientCredentialsGrant(p, client.client_id, client.client_secret));
  await populatePhase3(t);
  await populatePhase4(t);
}

/** Milestone D tables: metrics (rebuild + reconciliation), dashboard, report + run + file, retention, DSR. */
async function populatePhase4(t: TestTenant) {
  const c = () => randomUUID();
  await ensureMetrics(p, t.tenantId);
  for (let i = 0; i < 4; i++) {
    await p.ports.eventBus.drain();
    await p.jobs.runAll();
  }
  await reconcileTenant(p, t.tenantId);
  await p.database.withTenant(t.tenantId, (tx) => saveDashboard(p, tx, t.tenantId, t.owner, { name: 'Iso', widgets: [{ id: 'k', kind: 'kpi', title: 'Orders', metric: 'ordering:orders' }] }, c()));
  const { id } = await p.database.withTenant(t.tenantId, (tx) => saveReport(p, tx, t.tenantId, t.owner, { name: 'Iso', query: { metrics: ['ordering:orders'], range: 'last_7_days' } }, c()));
  await runReport(p, t.tenantId, t.owner, id, { format: 'csv', trigger: 'manual', correlationId: c() });
  await p.database.withTenant(t.tenantId, (tx) => saveRetentionPolicy(p, tx, t.tenantId, t.owner, { target: 'ordering:order', action: 'anonymise', after_days: 3650 }, c()));
  await runDsr(p, t.tenantId, t.owner, { kind: 'export', subject: 'nobody@iso.example' }, c());
}


/** Milestone C tables: a published workflow with a parallel group and an approval, run for real. */
async function populatePhase3(t: TestTenant) {
  const graph: WorkflowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', name: 'When', position: { x: 0, y: 0 }, config: { event: 'order.created' } },
      { id: 'fork', type: 'parallel', name: 'Fork', position: { x: 0, y: 0 }, config: {} },
      { id: 'a', type: 'set', name: 'A', position: { x: 0, y: 0 }, config: { vars: { a: 1 } } },
      { id: 'ok', type: 'approval', name: 'Approve', position: { x: 0, y: 0 }, config: { title: 'Check {{ trigger.data.number }}', approver_roles: ['Manager'] } },
      { id: 'join', type: 'merge', name: 'Join', position: { x: 0, y: 0 }, config: { parallel: 'fork' } },
    ],
    edges: [
      { id: 'e1', from: 'trigger', port: 'out', to: 'fork' },
      { id: 'e2', from: 'fork', port: 'out', to: 'a' },
      { id: 'e3', from: 'fork', port: 'out', to: 'ok' },
      { id: 'e4', from: 'a', port: 'out', to: 'join' },
      { id: 'e5', from: 'ok', port: 'approved', to: 'join' },
    ],
  };
  const c = () => randomUUID();
  const { id } = await p.database.withTenant(t.tenantId, (tx) => createWorkflow(p, tx, t.tenantId, t.owner, { name: 'Iso', graph }, c()));
  await p.database.withTenant(t.tenantId, (tx) => publishWorkflow(p, tx, t.tenantId, t.owner, id, 1, 'Manager', c()));
  await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: [{ sku: 'W', name: 'W', qty: 1, unit_price: 3 }] });
  for (let i = 0; i < 5; i++) {
    await p.ports.eventBus.drain();
    await p.workers.workflows.drain();
  }
  const managerId = newId();
  await p.database.withTenant(t.tenantId, (tx) => tx.insertInto('app_user').values({ id: managerId, tenant_id: t.tenantId, email: `m-${managerId.slice(0, 6)}@iso.example`, name: 'M', role: 'Manager', status: 'active' }).execute());
  const manager = await p.database.withTenant(t.tenantId, (tx) => principalFor(tx, p.catalog, t.tenantId, { id: managerId, role: 'Manager' }));
  const req = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('approval_request').select('id').where('status', '=', 'pending').executeTakeFirstOrThrow());
  await p.database.withTenant(t.tenantId, (tx) => decideApproval(p, tx, t.tenantId, { id: managerId, role: 'Manager', principal: manager }, req.id, 'approve', '', c()));
}

beforeAll(async () => {
  db = admin();
  A = await newTenant(p, 'iso-a');
  B = await newTenant(p, 'iso-b');
  await populate(A);
  await populate(B);
  await p.ports.eventBus.drain();
  const r = await db.query<{ table_name: string; has_tenant: boolean; is_tenant: boolean }>(`
    SELECT t.table_name,
           EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'tenant_id') AS has_tenant,
           t.table_name = 'tenant' AS is_tenant
    FROM information_schema.tables t
    WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY 1`);
  tables = r.rows.filter((x) => x.has_tenant || x.is_tenant).map((x) => ({ name: x.table_name, tenantCol: x.is_tenant ? 'id' : 'tenant_id' }));
  const unclassified = r.rows.filter((x) => !x.has_tenant && !x.is_tenant && !GLOBAL_TABLES.has(x.table_name) && !isMigrationsTable(x.table_name)).map((x) => x.table_name);
  expect(unclassified, 'tables without tenant_id must be declared global in this test').toEqual([]);
}, 120_000);

afterAll(async () => {
  await db.end();
  await closePlatform(p);
});

describe('tenant isolation (RLS)', () => {
  it('discovers the tenant tables (platform + all templates)', () => {
    const names = tables.map((t) => t.name);
    for (const t of ['tenant', 'app_user', 'audit_log', 'outbox_event', 'event_log', 'ord_order', 'pay_payment', 'pos_sale', 'lgx_shipment']) expect(names).toContain(t);
    expect(tables.length).toBeGreaterThan(30);
  });

  it('every tenant table has forced RLS with the tenant policy', async () => {
    const missing: string[] = [];
    for (const t of tables) {
      const r = await db.query(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                (SELECT count(*) FROM pg_policy pol WHERE pol.polrelid = c.oid AND pg_get_expr(pol.polqual, pol.polrelid) LIKE '%current_tenant_id()%' AND pg_get_expr(pol.polwithcheck, pol.polrelid) LIKE '%current_tenant_id()%') AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`,
        [t.name],
      );
      const row = r.rows[0];
      if (!row?.rls || !row.forced || Number(row.policies) < 1) missing.push(t.name);
    }
    expect(missing, 'tables without a forced tenant policy').toEqual([]);
  });

  it('the app role cannot bypass RLS', async () => {
    const r = await db.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'aod_app'`);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('both tenants have rows in every tenant table (so the checks below are meaningful)', async () => {
    const empty: string[] = [];
    for (const t of tables) {
      for (const tenant of [A, B]) {
        const r = await db.query(`SELECT count(*)::int AS n FROM ${t.name} WHERE ${t.tenantCol} = $1`, [tenant.tenantId]);
        if (r.rows[0].n === 0) empty.push(`${t.name} (${tenant === A ? 'A' : 'B'})`);
      }
    }
    expect(empty).toEqual([]);
  });

  it('each tenant sees exactly its own rows, and nothing without a tenant context', async () => {
    for (const t of tables) {
      for (const tenant of [A, B]) {
        const expected = (await db.query(`SELECT count(*)::int AS n FROM ${t.name} WHERE ${t.tenantCol} = $1`, [tenant.tenantId])).rows[0].n;
        const seen = await p.database.withTenant(tenant.tenantId, async (tx) => {
          const all = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(t.name)}`.execute(tx);
          const foreign = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(t.name)} WHERE ${sql.ref(t.tenantCol)} <> ${tenant.tenantId}`.execute(tx);
          return { all: all.rows[0]!.n, foreign: foreign.rows[0]!.n };
        });
        expect(seen, t.name).toEqual({ all: expected, foreign: 0 });
      }
      const none = await p.database.withoutTenant((tx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(t.name)}`.execute(tx));
      expect(none.rows[0]!.n, `${t.name} without tenant context`).toBe(0);
    }
  });

  it("a tenant cannot move or write rows into another tenant", async () => {
    for (const t of tables) {
      const err = await p.database
        .withTenant(A.tenantId, (tx) => sql`UPDATE ${sql.table(t.name)} SET ${sql.ref(t.tenantCol)} = ${B.tenantId}`.execute(tx))
        .then(() => null)
        .catch((e: Error) => e.message);
      expect(err, t.name).toMatch(/row-level security|permission denied/);
    }
    const ins = await p.database
      .withTenant(A.tenantId, (tx) => tx.insertInto('ord_counter').values({ tenant_id: B.tenantId, next_number: 1 }).execute())
      .then(() => null)
      .catch((e: Error) => e.message);
    expect(ins).toMatch(/row-level security/);
  });

  it('audit_log is append-only for the app role', async () => {
    const upd = await p.database.withTenant(A.tenantId, (tx) => sql`UPDATE audit_log SET action = 'x'`.execute(tx)).catch((e: Error) => e.message);
    const del = await p.database.withTenant(A.tenantId, (tx) => sql`DELETE FROM audit_log`.execute(tx)).catch((e: Error) => e.message);
    expect(upd).toMatch(/permission denied/);
    expect(del).toMatch(/permission denied/);
  });
});
