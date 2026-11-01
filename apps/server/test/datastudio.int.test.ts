import { randomUUID } from 'node:crypto';
import { Definition, type CustomEntity, type FieldDef } from '@aod/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { principalFor } from '../src/auth/principal.ts';
import { newId } from '../src/db/database.ts';
import { computeImpact, openDraft, publishDraft, publishedDefinition, rollbackTo, saveDraft, sendJobs } from '../src/platform/datastudio.ts';
import { IndexBuilder } from '../src/platform/maintenance.ts';
import { executeRecordWrite, getRecord, listRecords } from '../src/platform/records.ts';
import { getEntity, listEntity } from '../src/platform/workspace.ts';
import { linksFor } from '../src/platform/links.ts';
import { ADMIN_URL } from './env.ts';
import { admin, closePlatform, cmd, newTenant, runSaga, setPlan, testPlatform, type TestTenant } from './helpers.ts';

const p = testPlatform();
let t: TestTenant;
const cid = () => randomUUID();

const field = (key: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: key, type: 'text', options: [], required: false, pii: false, indexed: false, default: null, ...extra });

/** Edits the draft with `fn` and publishes it; runs queued backfills. */
async function publish(fn: (d: Definition) => void) {
  const r = await p.database.withTenant(t.tenantId, async (tx) => {
    const draft = await openDraft(p, tx, t.tenantId, t.owner, cid());
    const def = Definition.parse(draft.definition);
    fn(def);
    const saved = await saveDraft(p, tx, t.tenantId, t.owner, def, draft.version, undefined, cid());
    return publishDraft(p, tx, t.tenantId, t.owner, saved.version, cid());
  });
  await sendJobs(p, r.jobs);
  await p.jobs.runAll();
  return r;
}
const write = (entity: string, op: 'create' | 'update' | 'delete', rest: Record<string, unknown> = {}) =>
  executeRecordWrite(p, { tenantId: t.tenantId, principal: t.owner, entity, op, correlationId: cid(), ...rest } as any);

const supplier: CustomEntity = {
  key: 'supplier',
  label: 'Supplier',
  title_field: 'name',
  fields: [field('name', { required: true }), field('tier', { type: 'select', options: ['gold', 'silver'] }), field('email', { pii: true }), field('discount', { type: 'number' }), field('label', { formula: "upper(name) + ' (' + coalesce(tier, 'none') + ')'" })],
  rollups: [
    { key: 'deliveries', label: 'Deliveries', from: 'delivery', via: 'supplier', aggregate: 'count' },
    { key: 'kg', label: 'Total kg', from: 'delivery', via: 'supplier', aggregate: 'sum', field: 'kg' },
  ],
  rules: [{ name: 'discount cap', when: 'discount != null', condition: 'discount <= 30', message: 'Discount cannot exceed 30%' }],
};
const delivery: CustomEntity = { key: 'delivery', label: 'Delivery', title_field: 'ref', fields: [field('ref', { required: true }), field('kg', { type: 'number' }), field('supplier', { type: 'link', link: 'custom:supplier' })], rollups: [], rules: [] };

beforeAll(async () => {
  t = await newTenant(p, 'ds');
  await setPlan(p, t, 'growth');
  expect((await runSaga(p, t, 'ordering')).status).toBe('succeeded');
});
afterAll(() => closePlatform(p));

describe('Data studio', () => {
  it('publishes custom entities with formulas, rollups and rules', async () => {
    const r = await publish((d) => d.entities.push(supplier, delivery));
    expect(r.number).toBe(1);
    expect(r.impact.changes.filter((c) => c.change === 'entity added')).toHaveLength(2);

    const s = await write('supplier', 'create', { values: { name: 'Kopi Nusantara', tier: 'gold', email: 'sales@kopi.example', discount: 10 } });
    expect(s.status).toBe(201);
    await write('delivery', 'create', { values: { ref: 'D-1', kg: 12.5, supplier: s.body.id } });
    await write('delivery', 'create', { values: { ref: 'D-2', kg: 7.5, supplier: s.body.id } });

    const got = await p.database.withTenant(t.tenantId, (tx) => getRecord(p, tx, t.owner, 'supplier', s.body.id));
    expect(got.item.values).toMatchObject({ name: 'Kopi Nusantara', label: 'KOPI NUSANTARA (gold)', deliveries: 2, kg: 20, email: 'sales@kopi.example' });

    await expect(write('supplier', 'create', { values: { name: 'Greedy', discount: 45 } })).rejects.toMatchObject({ status: 422, code: 'rule_failed' });
    await expect(write('supplier', 'create', { values: { name: 'X', label: 'forced' } })).rejects.toMatchObject({ status: 422 });
    await expect(write('delivery', 'create', { values: { ref: 'D-3', supplier: randomUUID() } })).rejects.toMatchObject({ code: 'invalid_link' });
  });

  it('encrypts PII at rest and keeps it out of events', async () => {
    const db = admin();
    try {
      const raw = await db.query(`SELECT data->>'email' AS e FROM custom_record WHERE tenant_id = $1 AND entity = 'supplier'`, [t.tenantId]);
      expect(raw.rows[0].e).toMatch(/^enc:v1\./);
      const ev = await db.query(`SELECT payload FROM outbox_event WHERE tenant_id = $1 AND type = 'record.created' AND payload->'data'->>'entity' = 'supplier'`, [t.tenantId]);
      expect(ev.rows[0].payload.data.values).not.toHaveProperty('email');
      expect(JSON.stringify(ev.rows)).not.toContain('sales@kopi.example');
    } finally {
      await db.end();
    }
  });

  it('writes records through the full contract: idempotency, versions, outbox, audit, link index', async () => {
    const key = `rec-${randomUUID()}`;
    const a = await write('supplier', 'create', { values: { name: 'Twice' }, idempotencyKey: key });
    const b = await write('supplier', 'create', { values: { name: 'Twice' }, idempotencyKey: key });
    expect(b.replayed).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    const u = await write('supplier', 'update', { id: a.body.id, version: 1, values: { tier: 'silver' } });
    expect(u.body.version).toBe(2);
    await expect(write('supplier', 'update', { id: a.body.id, version: 1, values: { tier: 'gold' } })).rejects.toMatchObject({ status: 409 });
    const audit = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('audit_log').select('action').where('resource_id', '=', a.body.id).orderBy('at').execute());
    expect(audit.map((x) => x.action)).toEqual(['custom:supplier.create', 'custom:supplier.update']);

    const sup = (await p.database.withTenant(t.tenantId, (tx) => listRecords(p, tx, t.owner, 'supplier', { filters: { tier: ['gold'] } }))).items[0]!;
    const links = await p.database.withTenant(t.tenantId, (tx) => linksFor(p, tx, t.owner, 'custom::Supplier', sup.id));
    expect(links.links.map((l) => `${l.direction}:${l.rel}:${l.entity}`).sort()).toEqual(['in:supplier:delivery', 'in:supplier:delivery']);
  });

  it('pages, sorts and facets custom records', async () => {
    for (let i = 0; i < 5; i++) await write('delivery', 'create', { values: { ref: `P-${i}`, kg: i } });
    const seen: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await p.database.withTenant(t.tenantId, (tx) => listRecords(p, tx, t.owner, 'delivery', { filters: {}, sort: '-kg', limit: 2, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.items.map((i) => i.values.kg ?? null));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.filter((x) => x !== null)).toEqual([12.5, 7.5, 4, 3, 2, 1, 0]);
    const q = await p.database.withTenant(t.tenantId, (tx) => listRecords(p, tx, t.owner, 'supplier', { q: 'nusantara', filters: {} }));
    expect(q.items).toHaveLength(1);
  });

  it('summarises impact and blocks unsafe publishes', async () => {
    await expect(
      publish((d) => d.entities.find((e) => e.key === 'supplier')!.fields.push(field('country', { required: true }))),
    ).rejects.toMatchObject({ status: 409, code: 'publish_blocked' });
    await p.database.withTenant(t.tenantId, (tx) => tx.updateTable('metadata_version').set({ status: 'discarded' }).where('status', '=', 'draft').execute());

    const impact = await p.database.withTenant(t.tenantId, async (tx) => {
      const pub = (await publishedDefinition(tx)).definition;
      const next = Definition.parse(JSON.parse(JSON.stringify(pub)));
      next.entities.find((e) => e.key === 'supplier')!.fields.find((f) => f.key === 'tier')!.options = ['gold'];
      next.entities.find((e) => e.key === 'supplier')!.fields.push(field('country', { required: true, default: 'ID' }));
      return computeImpact(p, tx, pub, next);
    });
    expect(impact.blocking.join()).toMatch(/not valid select/);
    expect(impact.backfills).toContainEqual(expect.objectContaining({ target: 'custom:supplier', field: 'country', kind: 'set_default' }));
  });

  it('backfills defaults, toggles PII encryption on existing values, and rolls back', async () => {
    const o = await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 10 }] });
    const before = await publish((d) => d.app_fields.push({ app: 'ordering', entity: 'order', fields: [field('table_no'), field('rush', { type: 'boolean', default: false })] }));
    expect(before.impact.backfills).toContainEqual(expect.objectContaining({ field: 'rush', kind: 'set_default' }));
    const db = admin();
    try {
      const row = async () => (await db.query(`SELECT custom FROM ord_order WHERE id = $1`, [o.body.id])).rows[0].custom;
      expect(await row()).toMatchObject({ rush: false });

      await cmd(p, t, 'ordering', 'order.update', { id: o.body.id, version: 1, custom: { table_no: 'T7' } });
      const enc = await publish((d) => (d.app_fields.find((s) => s.app === 'ordering')!.fields.find((f) => f.key === 'table_no')!.pii = true));
      expect(enc.impact.backfills).toContainEqual(expect.objectContaining({ field: 'table_no', kind: 'encrypt', records: 1 }));
      expect((await row()).table_no).toMatch(/^enc:/);
      const shown = await p.database.withTenant(t.tenantId, (tx) => getEntity(p, tx, t.owner, 'ordering', 'order', o.body.id));
      expect((shown.item as any).custom.table_no).toBe('T7');

      // Roll back to the version before encryption: a new version that decrypts again.
      const rb = await p.database.withTenant(t.tenantId, (tx) => rollbackTo(p, tx, t.tenantId, t.owner, before.number, cid()));
      await sendJobs(p, rb.jobs);
      await p.jobs.runAll();
      expect(rb.number).toBe(enc.number + 1);
      expect(rb.impact.backfills).toContainEqual(expect.objectContaining({ field: 'table_no', kind: 'decrypt' }));
      expect((await row()).table_no).toBe('T7');
      const hist = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('metadata_version').select(['number', 'status']).orderBy('number').execute());
      expect(hist.at(-1)).toEqual({ number: rb.number, status: 'published' });
    } finally {
      await db.end();
    }
  });

  it('applies field access per role from the published version', async () => {
    await publish((d) => d.field_access.push({ role: 'Staff', target: 'ordering:order', field: 'total', access: 'hidden' }, { role: 'Staff', target: 'custom:supplier', field: 'discount', access: 'hidden' }));
    const staff = await p.database.withTenant(t.tenantId, async (tx) => {
      const id = newId();
      await tx.insertInto('app_user').values({ id, tenant_id: t.tenantId, email: `${id}@x.example`, name: 'S', role: 'Staff', status: 'active' }).execute();
      return principalFor(tx, p.catalog, t.tenantId, { id, role: 'Staff' });
    });
    const orders = await p.database.withTenant(t.tenantId, (tx) => listEntity(p, tx, staff, 'ordering', 'order', { filters: {} }));
    expect(orders.items[0]).not.toHaveProperty('total');
    const sups = await p.database.withTenant(t.tenantId, (tx) => listRecords(p, tx, staff, 'supplier', { filters: {} }));
    expect(sups.items[0]!.values).not.toHaveProperty('discount');
    await expect(executeRecordWrite(p, { tenantId: t.tenantId, principal: staff, entity: 'supplier', op: 'create', values: { name: 'S', discount: 5 }, correlationId: cid() })).rejects.toMatchObject({ code: 'field_forbidden' });

    // Computed values and search must not reveal a hidden field.
    await publish((d) => {
      d.entities.find((e) => e.key === 'supplier')!.fields.push(field('disc_copy', { formula: 'discount * 1' }));
      d.field_access.push({ role: 'Staff', target: 'custom:supplier', field: 'name', access: 'hidden' });
    });
    const again = await p.database.withTenant(t.tenantId, async (tx) => principalFor(tx, p.catalog, t.tenantId, { id: staff.id, role: 'Staff' }));
    const view = await p.database.withTenant(t.tenantId, (tx) => listRecords(p, tx, again, 'supplier', { filters: {} }));
    expect(view.items[0]!.values).not.toHaveProperty('disc_copy');
    expect(view.items[0]!.values).not.toHaveProperty('label'); // label = upper(name), name hidden
    expect(view.hiddenFields).toEqual(expect.arrayContaining(['discount', 'disc_copy', 'name', 'label']));
    const searched = await p.database.withTenant(t.tenantId, (tx) => listRecords(p, tx, again, 'supplier', { q: 'nusantara', filters: {} }));
    expect(searched.items).toHaveLength(0);
    const ownerSearch = await p.database.withTenant(t.tenantId, (tx) => listRecords(p, tx, t.owner, 'supplier', { q: 'nusantara', filters: {} }));
    expect(ownerSearch.items).toHaveLength(1);
    const del = (await p.database.withTenant(t.tenantId, (tx) => listRecords(p, tx, t.owner, 'delivery', { filters: {} }))).items.find((i) => i.values.supplier);
    const lk = await p.database.withTenant(t.tenantId, (tx) => linksFor(p, tx, again, 'custom::Delivery', del!.id));
    expect(lk.links[0]!.title).not.toBe('Kopi Nusantara');
  });

  it('never writes a removed PII field back in clear text or into events', async () => {
    const s = await write('supplier', 'create', { values: { name: 'Secret Beans', email: 'secret@beans.example' } });
    await publish((d) => {
      const e = d.entities.find((x) => x.key === 'supplier')!;
      e.fields = e.fields.filter((f) => f.key !== 'email');
    });
    await write('supplier', 'update', { id: s.body.id, version: 1, values: { tier: 'silver' } });
    const db = admin();
    try {
      const raw = (await db.query(`SELECT data->>'email' AS e FROM custom_record WHERE id = $1`, [s.body.id])).rows[0].e;
      expect(raw).toMatch(/^enc:/);
      const evs = await db.query(`SELECT payload FROM outbox_event WHERE aggregateid = $1`, [s.body.id]);
      expect(JSON.stringify(evs.rows)).not.toContain('secret@beans.example');
    } finally {
      await db.end();
    }
    const got = await p.database.withTenant(t.tenantId, (tx) => getRecord(p, tx, t.owner, 'supplier', s.body.id));
    expect(got.item.values).not.toHaveProperty('email');
  });

  it('builds per-tenant indexes concurrently and drops them when unindexed', async () => {
    await publish((d) => (d.entities.find((e) => e.key === 'delivery')!.fields.find((f) => f.key === 'ref')!.indexed = true));
    const builder = new IndexBuilder(p, ADMIN_URL);
    await builder.runPending();
    const req = await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('index_request').selectAll().where('field', '=', 'ref').executeTakeFirstOrThrow());
    expect(req.status).toBe('ready');
    const db = admin();
    try {
      const idx = await db.query(`SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, [req.index_name]);
      expect(idx.rows[0].indisvalid).toBe(true);
      expect(idx.rows[0].def).toContain(`tenant_id = '${t.tenantId}'`);
      await publish((d) => (d.entities.find((e) => e.key === 'delivery')!.fields.find((f) => f.key === 'ref')!.indexed = false));
      await builder.runPending();
      expect((await db.query(`SELECT 1 FROM pg_class WHERE relname = $1`, [req.index_name])).rowCount).toBe(0);
    } finally {
      await db.end();
    }
    expect(() => IndexBuilder.ddl({ op: 'create', tenant_id: t.tenantId, index_name: 'cfx_000000000000000000000000', field: "x'); DROP TABLE tenant; --" }, { table: 'ord_order', column: 'custom' })).toThrow(/unsafe/);
  });

  it('enforces plan limits on the data model', async () => {
    const small = await newTenant(p, 'ds-limit'); // trial: 2 custom entities
    await expect(
      p.database.withTenant(small.tenantId, async (tx) => {
        const draft = await openDraft(p, tx, small.tenantId, small.owner, cid());
        const def = Definition.parse(draft.definition);
        for (const k of ['a', 'b', 'c']) def.entities.push({ key: k, label: k, title_field: 'n', fields: [field('n')], rollups: [], rules: [] });
        const saved = await saveDraft(p, tx, small.tenantId, small.owner, def, draft.version, undefined, cid());
        return publishDraft(p, tx, small.tenantId, small.owner, saved.version, cid());
      }),
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/plan limit: at most 2 custom entities/) });
  });

  it('records cross-app links from manifest declarations', async () => {
    await runSaga(p, t, 'logistics');
    const o = await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 10 }] });
    await p.ports.eventBus.drain();
    const s = await cmd(p, t, 'logistics', 'shipment.create', { order_id: o.body.id, carrier: 'jne' });
    await p.ports.eventBus.drain();
    const l = await p.database.withTenant(t.tenantId, (tx) => linksFor(p, tx, t.owner, 'ordering::Order', o.body.id));
    expect(l.links).toContainEqual(expect.objectContaining({ direction: 'in', rel: 'ships', id: s.body.id, entity: 'shipment', title: String(s.body.tracking_no) }));
  });
});
