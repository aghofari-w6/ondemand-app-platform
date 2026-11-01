import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLoginToken } from '../src/auth/sessions.ts';
import { newId } from '../src/db/database.ts';
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
