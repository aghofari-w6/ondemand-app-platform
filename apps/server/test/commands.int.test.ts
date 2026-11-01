import { randomUUID } from 'node:crypto';
import type { Principal } from '@aod/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { principalFor } from '../src/auth/principal.ts';
import { newId } from '../src/db/database.ts';
import { listEntity } from '../src/platform/workspace.ts';
import { changeTenantStatus } from '../src/platform/tenants.ts';
import { closePlatform, cmd, newTenant, runSaga, testPlatform, type TestTenant } from './helpers.ts';

const p = testPlatform();
let t: TestTenant;
const line = [{ sku: 'ESP', name: 'Espresso', qty: 2, unit_price: 25000 }];

async function userWithRole(role: string): Promise<Principal> {
  const id = newId();
  return p.database.withTenant(t.tenantId, async (tx) => {
    await tx.insertInto('app_user').values({ id, tenant_id: t.tenantId, email: `${id}@x.example`, name: 'U', role, status: 'active' }).execute();
    return principalFor(tx, p.catalog, t.tenantId, { id, role });
  });
}

beforeAll(async () => {
  t = await newTenant(p, 'cmd');
  for (const app of ['ordering', 'pos']) expect((await runSaga(p, t, app)).status).toBe('succeeded');
});
afterAll(() => closePlatform(p));

describe('command pipeline', () => {
  it('writes the business row, outbox event and audit entry in one transaction', async () => {
    const r = await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: line });
    expect(r.status).toBe(201);
    const rows = await p.database.withTenant(t.tenantId, async (tx) => ({
      outbox: await tx.selectFrom('outbox_event').select(['type', 'payload', 'aggregatetype', 'aggregateid']).where('aggregateid', '=', r.body.id).execute(),
      audit: await tx.selectFrom('audit_log').select(['action', 'actor_id']).where('resource_id', '=', r.body.id).execute(),
    }));
    expect(rows.outbox).toHaveLength(1);
    const env = rows.outbox[0]!.payload;
    expect(env).toMatchObject({ type: 'order.created', version: 1, tenant_id: t.tenantId, app: 'ordering', origin: 'user', workflow_hop: 0, workflow_chain: [], schema_ref: 'aod://ordering/order.created/v1' });
    for (const k of ['id', 'occurred_at', 'traceparent', 'correlation_id', 'causation_id', 'data']) expect(env).toHaveProperty(k);
    expect(rows.audit).toEqual([{ action: 'ordering:order.create', actor_id: t.ownerId }]);
  });

  it('replays an Idempotency-Key and rejects its reuse for a different request', async () => {
    const key = `idem-${randomUUID()}`;
    const a = await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: line }, { key });
    const b = await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: line }, { key });
    expect(b.replayed).toBe(true);
    expect(b.body).toEqual(a.body);
    const count = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('outbox_event').select('id').where('aggregateid', '=', a.body.id).execute());
    expect(count).toHaveLength(1);
    await expect(cmd(p, t, 'ordering', 'order.create', { channel: 'phone', lines: line }, { key })).rejects.toMatchObject({ status: 422, code: 'idempotency_key_reused' });
    const stored = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('idempotency_key').select(['expires_at', 'created_at']).where('key', '=', key).executeTakeFirstOrThrow());
    expect(new Date(stored.expires_at).getTime() - new Date(stored.created_at).getTime()).toBe(24 * 3600_000);
  });

  it('returns 409 on a stale version', async () => {
    const o = await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: line });
    await cmd(p, t, 'ordering', 'order.advance', { id: o.body.id, version: 1 });
    await expect(cmd(p, t, 'ordering', 'order.advance', { id: o.body.id, version: 1 })).rejects.toMatchObject({ status: 409, code: 'version_conflict' });
    const ok = await cmd(p, t, 'ordering', 'order.advance', { id: o.body.id, version: 2 });
    expect(ok.body).toMatchObject({ version: 3, status: 'preparing' });
  });

  it('authorizes through role presets, custom roles and field rules', async () => {
    const viewer = await userWithRole('Viewer');
    await expect(cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: line }, { principal: viewer })).rejects.toMatchObject({ status: 403 });
    const staff = await userWithRole('Staff');
    expect((await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: line }, { principal: staff })).status).toBe(201);
    await expect(cmd(p, t, 'ordering', 'order.cancel', { id: randomUUID(), version: 1 }, { principal: staff })).rejects.toMatchObject({ status: 403 });

    const roleId = newId();
    await p.database.withTenant(t.tenantId, (tx) =>
      tx.insertInto('custom_role').values({ id: roleId, tenant_id: t.tenantId, name: `Barista ${roleId.slice(0, 4)}`, permissions: ['ordering:order.read', 'ordering:order.update'], field_rules: JSON.stringify([{ resource: 'ordering::Order', field: 'total', access: 'hidden' }, { resource: 'ordering::Order', field: 'notes', access: 'read' }]) }).execute(),
    );
    const barista = await userWithRole(roleId);
    const list = await p.database.withTenant(t.tenantId, (tx) => listEntity(p, tx, barista, 'ordering', 'order', { filters: {} }));
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items[0]).not.toHaveProperty('total');
    expect(list.hiddenFields).toContain('total');
    const o = list.items[0] as { id: string; version: number };
    await expect(cmd(p, t, 'ordering', 'order.update', { id: o.id, version: o.version, notes: 'x' }, { principal: barista })).rejects.toMatchObject({ status: 403, code: 'field_forbidden' });
    expect((await cmd(p, t, 'ordering', 'order.update', { id: o.id, version: o.version, customer_name: 'Ok' }, { principal: barista })).status).toBe(200);
  });

  it('validates custom fields against their definitions', async () => {
    await p.database.withTenant(t.tenantId, (tx) => tx.insertInto('field_definition').values({ id: newId(), tenant_id: t.tenantId, app: 'ordering', entity: 'order', key: 'pickup_slot', label: 'Pickup slot', type: 'select', options: ['am', 'pm'] }).execute());
    await expect(cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: line, custom: { pickup_slot: 'night' } })).rejects.toMatchObject({ status: 422 });
    await expect(cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: line, custom: { nope: 1 } })).rejects.toMatchObject({ status: 422 });
    const ok = await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: line, custom: { pickup_slot: 'pm' } });
    const found = await p.database.withTenant(t.tenantId, (tx) => listEntity(p, tx, t.owner, 'ordering', 'order', { q: 'pm', filters: {} }));
    expect(found.items.map((i: any) => i.id)).toContain(ok.body.id);
  });

  it('pages with a stable cursor, sorts and facets', async () => {
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await p.database.withTenant(t.tenantId, (tx) => listEntity(p, tx, t.owner, 'ordering', 'order', { filters: {}, sort: '-number', limit: 3, ...(cursor ? { cursor } : {}) }));
      all.push(...page.items.map((i: any) => i.number));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toEqual([...all].sort((a: any, b: any) => b - a));
    expect(new Set(all).size).toBe(all.length);
    const f = await p.database.withTenant(t.tenantId, (tx) => listEntity(p, tx, t.owner, 'ordering', 'order', { filters: { status: ['new'] } }));
    expect(f.items.every((i: any) => i.status === 'new')).toBe(true);
    expect(f.facets.status!.length).toBeGreaterThan(1); // the facet ignores its own filter
  });

  it('turns an offline POS sale into an order at its original sale time, exactly once', async () => {
    const reg = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('pos_register').select('id').executeTakeFirstOrThrow());
    await cmd(p, t, 'pos', 'shift.open', { register_id: reg.id });
    const soldAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const sale = { id: randomUUID(), register_id: reg.id, lines: line, tender: 'cash', tendered: 60000, sold_at: soldAt, offline: true };
    const first = await cmd(p, t, 'pos', 'sale.complete', sale, { key: `sale-${sale.id}` });
    const again = await cmd(p, t, 'pos', 'sale.complete', sale, { key: `sale-${sale.id}` });
    expect(first.status).toBe(201);
    expect(again.replayed).toBe(true);
    await p.ports.eventBus.drain();
    await p.ports.eventBus.drain();
    const orders = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('ord_order').selectAll().where('source_ref', '=', `pos:sale:${sale.id}`).execute());
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ channel: 'pos', status: 'completed', total: 50000 });
    expect(new Date(orders[0]!.placed_at).getTime()).toBe(new Date(soldAt).getTime());
    // causation chain: order.created was caused by sale.completed
    const ev = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('event_log').select('payload').where('aggregateid', '=', orders[0]!.id).executeTakeFirstOrThrow());
    expect(ev.payload.causation_id).toBeTruthy();
    expect(ev.payload.origin).toBe('system');
  });

  it('blocks writes on a suspended workspace', async () => {
    const s = await newTenant(p, 'susp');
    await runSaga(p, s, 'ordering');
    await p.database.withTenant(s.tenantId, (tx) => changeTenantStatus(p, tx, s.tenantId, 'suspended', s.owner, randomUUID()));
    await expect(cmd(p, s, 'ordering', 'order.create', { channel: 'web', lines: line })).rejects.toMatchObject({ status: 423 });
  });
});
