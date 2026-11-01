import { randomUUID } from 'node:crypto';
import { Definition, EndpointInput, type FieldDef } from '@aod/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhook } from '../src/adapters/delivery.ts';
import { newId } from '../src/db/database.ts';
import { openDraft, publishDraft, saveDraft } from '../src/platform/datastudio.ts';
import { applyInbound, endpointView, replayDeliveries, saveEndpoint } from '../src/platform/hub.ts';
import { writeOutbox } from '../src/platform/outbox.ts';
import { executeRecordWrite } from '../src/platform/records.ts';
import { admin, closePlatform, cmd, newTenant, runSaga, setPlan, testPlatform, type TestTenant } from './helpers.ts';

const p = testPlatform();
let t: TestTenant;
let rx: FastifyInstance;
let base = '';
const cid = () => randomUUID();
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

/** Programmable receiver: per path, a list of status codes to answer with (last one repeats). */
const plan = new Map<string, number[]>();
const seen: { path: string; headers: Record<string, string | undefined>; body: string }[] = [];
const received = (path: string) => seen.filter((s) => s.path === path);

const field = (key: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: key, type: 'text', options: [], required: false, pii: false, indexed: false, default: null, ...extra });
const endpoint = (input: unknown) => p.database.withTenant(t.tenantId, (tx) => saveEndpoint(p, tx, t.tenantId, t.owner, EndpointInput.parse(input), cid()));
const deliveries = (endpointId: string) => p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('hub_delivery').selectAll().where('endpoint_id', '=', endpointId).orderBy('created_at').execute());
const attempts = (deliveryId: string) => p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('hub_delivery_attempt').selectAll().where('delivery_id', '=', deliveryId).orderBy('attempt').execute());
const order = (total = 50) => cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: total }] });
const pump = async () => {
  await p.ports.eventBus.drain();
  await p.workers.hub.drain();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Pump until `check` passes (backoff timers are a few ms in tests). */
async function until(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await pump();
    if (await check()) return;
    await sleep(20);
  }
  throw new Error('condition not reached');
}

beforeAll(async () => {
  rx = Fastify();
  rx.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, b, done) => done(null, b));
  rx.all('/*', async (req, reply) => {
    const path = req.url;
    seen.push({ path, headers: req.headers as Record<string, string | undefined>, body: String(req.body ?? '') });
    const codes = plan.get(path) ?? [200];
    const code = codes.length > 1 ? codes.shift()! : codes[0]!;
    if (path.startsWith('/erp')) {
      const b = JSON.parse(String(req.body));
      return reply.code(code).send({ external_id: `ERP-${String(b.local_id).slice(0, 8)}` });
    }
    return reply.code(code).send({ ok: code < 300 });
  });
  base = (await rx.listen({ port: 0, host: '127.0.0.1' })).replace('localhost', '127.0.0.1');
  t = await newTenant(p, 'hub');
  await setPlan(p, t, 'growth');
  expect((await runSaga(p, t, 'ordering')).status).toBe('succeeded');
});
afterAll(async () => {
  await rx.close();
  await closePlatform(p);
});

describe('Integration Hub', () => {
  it('delivers signed webhooks (Standard Webhooks) and keeps secrets write-only', async () => {
    const ep = await endpoint({ kind: 'webhook', name: 'signed', event_types: ['order.created'], config: { url: `${base}/signed` } });
    expect(ep.signingSecret).toMatch(/^whsec_/);
    const o = await order();
    await pump();
    const [hit] = received('/signed');
    expect(hit).toBeDefined();
    expect(verifyWebhook(ep.signingSecret!, hit!.headers, hit!.body)).toBe(true);
    expect(verifyWebhook('whsec_' + Buffer.alloc(24).toString('base64'), hit!.headers, hit!.body)).toBe(false);
    const env = JSON.parse(hit!.body);
    expect(env).toMatchObject({ type: 'order.created', data: { order_id: o.body.id } });
    expect(hit!.headers['webhook-id']).toBe(env.id);
    const view = await p.database.withTenant(t.tenantId, async (tx) => endpointView(await tx.selectFrom('hub_endpoint').selectAll().where('id', '=', ep.id).executeTakeFirstOrThrow()));
    expect(JSON.stringify(view)).not.toContain('whsec_');
    expect(view.has_signing_secret).toBe(true);
  });

  it('retries with backoff and jitter, logs every attempt, then succeeds', async () => {
    plan.set('/flaky', [500, 503, 200]);
    const ep = await endpoint({ kind: 'webhook', name: 'flaky', event_types: ['order.created'], config: { url: `${base}/flaky` } });
    await order();
    await until(async () => (await deliveries(ep.id))[0]?.status === 'succeeded');
    const [d] = await deliveries(ep.id);
    const log = await attempts(d!.id);
    expect(log.map((a) => [a.ok, a.status_code])).toEqual([[false, 500], [false, 503], [true, 200]]);
    expect(new Set(received('/flaky').map((r) => r.headers['webhook-id'])).size).toBe(1); // same event id on every retry
  });

  it('dead-letters after the last attempt and replays with the original event id', async () => {
    plan.set('/down', [500]);
    const ep = await endpoint({ kind: 'webhook', name: 'down', event_types: ['order.created', 'hub.*'], config: { url: `${base}/down` } });
    await order();
    await until(async () => (await deliveries(ep.id))[0]?.status === 'dead');
    const [dead] = await deliveries(ep.id);
    expect(dead!.attempts).toBe(3);
    // The dead-letter event about this endpoint is never queued to the endpoint itself.
    expect((await deliveries(ep.id)).map((d) => d.event_type)).toEqual(['order.created']);
    const orders = () => received('/down').filter((r) => JSON.parse(r.body).type === 'order.created');
    const firstId = orders()[0]!.headers['webhook-id'];
    plan.set('/down', [200]);
    const n = await p.database.withTenant(t.tenantId, (tx) => replayDeliveries(p, tx, t.tenantId, t.owner, { ids: [dead!.id] }, cid()));
    expect(n).toBe(1);
    await until(async () => (await deliveries(ep.id))[0]?.status === 'succeeded');
    expect(orders().at(-1)!.headers['webhook-id']).toBe(firstId);
    expect((await deliveries(ep.id))[0]!.replays).toBe(1);
  });

  it('opens the circuit breaker after consecutive failures and closes it after a successful trial', async () => {
    plan.set('/breaker', [500]);
    const ep = await endpoint({ kind: 'webhook', name: 'breaker', event_types: ['order.created'], config: { url: `${base}/breaker` } });
    for (let i = 0; i < 3; i++) await order();
    await p.ports.eventBus.drain();
    await p.workers.hub.tick();
    const state = () => p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('hub_endpoint').select(['circuit_state', 'consecutive_failures']).where('id', '=', ep.id).executeTakeFirstOrThrow());
    expect(await state()).toMatchObject({ circuit_state: 'open', consecutive_failures: 3 });
    const before = received('/breaker').length;
    await order();
    await pump(); // deferred while open: no new request, no attempt spent
    expect(received('/breaker').length).toBe(before);
    expect((await deliveries(ep.id)).at(-1)!.attempts).toBe(0);
    plan.set('/breaker', [200]);
    await sleep(250); // cool-down (200 ms in tests)
    await until(async () => (await deliveries(ep.id)).every((d) => d.status === 'succeeded'), 8000);
    expect(await state()).toMatchObject({ circuit_state: 'closed', consecutive_failures: 0 });
  });

  it('bulk-replays the dead letter queue of an endpoint', async () => {
    plan.set('/bulk', [500]);
    const ep = await endpoint({ kind: 'webhook', name: 'bulk', event_types: ['order.created'], config: { url: `${base}/bulk` } });
    await order();
    await order();
    await until(async () => (await deliveries(ep.id)).every((d) => d.status === 'dead') && (await deliveries(ep.id)).length === 2);
    plan.set('/bulk', [200]);
    const n = await p.database.withTenant(t.tenantId, (tx) => replayDeliveries(p, tx, t.tenantId, t.owner, { endpointId: ep.id }, cid()));
    expect(n).toBe(2);
    await until(async () => (await deliveries(ep.id)).every((d) => d.status === 'succeeded'));
  });

  it('applies filters and schema version pins', async () => {
    const big = await endpoint({ kind: 'webhook', name: 'big', event_types: ['order.created'], filter: 'data.total > 100', config: { url: `${base}/big` } });
    expect(big.schema_pins).toEqual({ 'order.created': 1 });
    await order(50);
    await order(500);
    await pump();
    expect(received('/big').map((r) => JSON.parse(r.body).data.total)).toEqual([500]);

    // A v2 event (not yet published by Ordering) is skipped for an endpoint pinned to v1.
    await p.database.withTenant(t.tenantId, (tx) =>
      writeOutbox(tx, [{ type: 'order.created', version: 2, aggregateType: 'order', aggregateId: randomUUID(), data: { total: 900 } }], { tenantId: t.tenantId, app: 'ordering', correlationId: cid(), newId }),
    );
    await pump();
    const skipped = (await deliveries(big.id)).filter((d) => d.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.last_error).toMatch(/pinned version 1/);
  });

  it('refuses private, loopback, link-local and metadata addresses (SSRF)', async () => {
    for (const url of ['http://10.0.0.5/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://[::ffff:127.0.0.1]/x', 'http://192.168.1.10/x', 'https://100.64.0.1/x']) {
      await expect(endpoint({ kind: 'webhook', name: `ssrf-${randomUUID().slice(0, 6)}`, event_types: ['order.created'], config: { url } })).rejects.toMatchObject({ status: 422, code: 'endpoint_rejected' });
    }
    await expect(endpoint({ kind: 'redis_stream', name: 'ssrf-redis', event_types: ['order.created'], config: { url: 'redis://10.1.2.3:6379', stream: 's' } })).rejects.toMatchObject({ code: 'endpoint_rejected' });
    await expect(endpoint({ kind: 'webhook', name: 'creds-in-url', event_types: ['order.created'], config: { url: 'https://user:pw@93.184.216.34/x' } })).rejects.toMatchObject({ code: 'endpoint_rejected' });
    await expect(endpoint({ kind: 'redis_stream', name: 'redis-pw', event_types: ['order.created'], config: { url: 'redis://:hunter2@93.184.216.34:6379', stream: 's' } })).rejects.toThrow(/credentials field/);
    await expect(endpoint({ kind: 'sqs', name: 'sqs-ambient', event_types: ['order.created'], config: { queue_url: 'https://93.184.216.34/1/q', region: 'us-east-1' } })).rejects.toThrow();
  });

  it('pushes REST with write-only encrypted credentials', async () => {
    const ep = await endpoint({ kind: 'rest_push', name: 'rest', event_types: ['order.created'], config: { url: `${base}/rest`, method: 'PUT' }, credentials: { type: 'bearer', token: 'tok_super_secret' } });
    await order();
    await pump();
    expect(received('/rest').at(-1)!.headers.authorization).toBe('Bearer tok_super_secret');
    const db = admin();
    try {
      const row = (await db.query(`SELECT credentials_enc FROM hub_endpoint WHERE id = $1`, [ep.id])).rows[0];
      expect(row.credentials_enc).toMatch(/^v1\./);
      expect(row.credentials_enc).not.toContain('tok_super_secret');
    } finally {
      await db.end();
    }
  });

  it('runs custom connectors with sandboxed code steps', async () => {
    const id = newId();
    await p.database.withTenant(t.tenantId, (tx) =>
      tx
        .insertInto('hub_connector')
        .values({
          id,
          tenant_id: t.tenantId,
          name: 'shape',
          spec: JSON.stringify({
            steps: [
              { kind: 'map', fields: { n: 'data.number', total: 'data.total' } },
              { kind: 'code', source: 'function transform(i) { return { orderNo: "ORD-" + i.n, cents: i.total * 100, sandboxed: typeof process === "undefined" && typeof require === "undefined" }; }', timeout_ms: 200, memory_mb: 16 },
              { kind: 'http', url: `${base}/connector`, method: 'POST' },
            ],
          }),
        })
        .execute(),
    );
    await endpoint({ kind: 'custom', name: 'custom', event_types: ['order.created'], config: { connector_id: id } });
    const o = await order(70);
    await pump();
    expect(JSON.parse(received('/connector').at(-1)!.body)).toEqual({ orderNo: `ORD-${o.body.number}`, cents: 7000, sandboxed: true });
    await expect(p.ports.sandbox.run('function transform() { while (true) {} }', {}, { timeoutMs: 50, memoryMb: 16 })).rejects.toThrow(/timed out/i);
    await expect(p.ports.sandbox.run('function transform() { return globalThis.fetch ? "net" : (typeof process) }', {}, { timeoutMs: 100, memoryMb: 16 })).resolves.toBe('undefined');
  });

  it('appends to a Redis Stream', async () => {
    const stream = `aod-test-${randomUUID().slice(0, 8)}`;
    const ep = await endpoint({ kind: 'redis_stream', name: 'redis', event_types: ['order.created'], config: { url: `${REDIS_URL}/0`, stream } });
    await order();
    await until(async () => (await deliveries(ep.id))[0]?.status === 'succeeded');
    const r = new Redis(REDIS_URL);
    try {
      const entries = await r.xrange(stream, '-', '+');
      expect(entries).toHaveLength(1);
      const fields = Object.fromEntries(entries[0]![1].reduce<string[][]>((acc, v, i, a) => (i % 2 ? acc : [...acc, [v, a[i + 1]!]]), []));
      expect(fields.type).toBe('order.created');
      expect(JSON.parse(fields.body!).id).toBe(fields.event_id);
      await r.del(stream);
    } finally {
      r.disconnect();
    }
  });

  it('syncs custom records both ways with an external id map, conflict rules and loop prevention', async () => {
    await p.database.withTenant(t.tenantId, async (tx) => {
      const draft = await openDraft(p, tx, t.tenantId, t.owner, cid());
      const def = Definition.parse(draft.definition);
      def.entities.push({ key: 'supplier', label: 'Supplier', title_field: 'name', fields: [field('name', { required: true }), field('city')], rollups: [], rules: [] });
      const s = await saveDraft(p, tx, t.tenantId, t.owner, def, draft.version, undefined, cid());
      await publishDraft(p, tx, t.tenantId, t.owner, s.version, cid());
    });
    const ep = await endpoint({ kind: 'webhook', name: 'erp', event_types: ['record.*'], config: { url: `${base}/erp` } });
    const syncId = newId();
    await p.database.withTenant(t.tenantId, (tx) => tx.insertInto('hub_sync').values({ id: syncId, tenant_id: t.tenantId, name: 'erp', entity: 'supplier', endpoint_id: ep.id, conflict_rule: 'platform_wins', field_map: JSON.stringify({ name: 'company_name' }) }).execute());
    const write = (op: 'create' | 'update', rest: object) => executeRecordWrite(p, { tenantId: t.tenantId, principal: t.owner, entity: 'supplier', op, correlationId: cid(), ...rest } as any);

    // Outbound: a local create reaches the ERP with mapped fields; the ERP's id is recorded.
    const local = await write('create', { values: { name: 'Kopi Nusantara', city: 'Bandung' } });
    await pump();
    const out = JSON.parse(received('/erp').at(-1)!.body);
    expect(out).toMatchObject({ sync: 'erp', op: 'created', local_id: local.body.id, external_id: null, data: { company_name: 'Kopi Nusantara', city: 'Bandung' } });
    const extId = `ERP-${local.body.id.slice(0, 8)}`;
    const mapRow = () => p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('external_id_map').selectAll().where('sync_id', '=', syncId).executeTakeFirstOrThrow());
    expect((await mapRow()).external_id).toBe(extId);

    // Inbound: an ERP change is applied and NOT echoed back to the ERP.
    const sent = received('/erp').length;
    const t1 = new Date(Date.now() + 1000).toISOString();
    expect(await applyInbound(p, t.tenantId, t.owner, syncId, { external_id: extId, updated_at: t1, data: { company_name: 'Kopi Nusantara Ltd' }, deleted: false }, 'a')).toMatchObject({ result: 'updated' });
    await pump();
    expect(received('/erp').length).toBe(sent);
    expect(await applyInbound(p, t.tenantId, t.owner, syncId, { external_id: extId, updated_at: new Date(Date.now() - 60_000).toISOString(), data: { company_name: 'old' }, deleted: false }, 'b')).toMatchObject({ result: 'stale' });

    // Conflict: both sides changed since the last sync. platform_wins keeps the local value.
    const cur = (await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('custom_record').select('version').where('id', '=', local.body.id).executeTakeFirstOrThrow())).version;
    await write('update', { id: local.body.id, version: cur, values: { city: 'Jakarta' } }); // not yet delivered
    const c1 = await applyInbound(p, t.tenantId, t.owner, syncId, { external_id: extId, updated_at: new Date(Date.now() + 2000).toISOString(), data: { city: 'Surabaya' }, deleted: false }, 'c');
    expect(c1).toMatchObject({ result: 'conflict', winner: 'platform' });
    const city = async () => (await p.database.withTenant(t.tenantId, (tx) => tx.selectFrom('custom_record').select('data').where('id', '=', local.body.id).executeTakeFirstOrThrow())).data.city;
    expect(await city()).toBe('Jakarta');

    // remote_wins applies the remote side of a conflict.
    await p.database.withTenant(t.tenantId, (tx) => tx.updateTable('hub_sync').set({ conflict_rule: 'remote_wins' }).where('id', '=', syncId).execute());
    const c2 = await applyInbound(p, t.tenantId, t.owner, syncId, { external_id: extId, updated_at: new Date(Date.now() + 3000).toISOString(), data: { city: 'Medan' }, deleted: false }, 'd');
    expect(c2).toMatchObject({ result: 'conflict', winner: 'remote' });
    expect(await city()).toBe('Medan');

    // A new record created remotely gets a local twin.
    const created = await applyInbound(p, t.tenantId, t.owner, syncId, { external_id: 'ERP-NEW', updated_at: new Date().toISOString(), data: { company_name: 'Teh Jawa' }, deleted: false }, 'e');
    expect(created).toMatchObject({ result: 'created' });
  });
});
