import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.ts';
import { handleLifecycleJob, lifecycleSweep } from '../src/platform/tenants.ts';
import { admin, closePlatform, testPlatform } from './helpers.ts';

const p = testPlatform();
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp(p);
});
afterAll(async () => {
  await app.close();
  await closePlatform(p);
});

const json = (cookie?: string) => ({ 'content-type': 'application/json', ...(cookie ? { cookie } : {}) });
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;

async function signupAndLogin(slug: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: json(), payload: { workspaceName: 'Http Co', slug, ownerName: 'Olive', email: `olive@${slug}.example` } });
  expect(res.statusCode).toBe(201);
  const link = res.json().delivery.preview.link as string;
  const token = decodeURIComponent(link.split('token=')[1]!);
  const v = await app.inject({ method: 'POST', url: '/api/auth/verify', headers: json(), payload: { token } });
  expect(v.statusCode).toBe(200);
  expect(String(v.headers['set-cookie'])).toMatch(/HttpOnly/);
  expect(String(v.headers['set-cookie'])).toMatch(/SameSite=Lax/);
  // single-use
  expect((await app.inject({ method: 'POST', url: '/api/auth/verify', headers: json(), payload: { token } })).statusCode).toBe(400);
  return { cookie: cookieOf(v), tenantId: res.json().tenant.id as string };
}

describe('HTTP API', () => {
  it('signs up (tenant + Owner), shows the magic link in demo mode, and reads the tenant under RLS', async () => {
    const slug = `http-${Date.now().toString(36)}`;
    const { cookie } = await signupAndLogin(slug);
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ user: { name: 'Olive' }, role: { preset: 'Owner' }, tenant: { slug } });
    const t = await app.inject({ url: '/api/tenant', headers: { cookie } });
    expect(t.json()).toMatchObject({ tenant: { slug, status: 'trial' }, slots: { used: 0, total: 3 } });
    expect(t.json().onboarding.steps[0]).toMatchObject({ key: 'workspace', done: true });
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', headers: json(), payload: { workspaceName: 'Dup', slug, ownerName: 'X', email: 'x@y.example' } })).statusCode).toBe(409);
    expect((await app.inject({ url: '/api/tenant' })).statusCode).toBe(401);
  });

  it('invites with an on-screen link, keeps at least one Owner, previews roles', async () => {
    const { cookie } = await signupAndLogin(`inv-${Date.now().toString(36)}`);
    const inv = await app.inject({ method: 'POST', url: '/api/users/invite', headers: json(cookie), payload: { email: 'ben@x.example', name: 'Ben', role: 'Staff' } });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().delivery.preview.link).toContain('/auth/verify?token=');
    const users = (await app.inject({ url: '/api/users', headers: { cookie } })).json().users as any[];
    const owner = users.find((u) => u.role === 'Owner');
    const demote = await app.inject({ method: 'PATCH', url: `/api/users/${owner.id}/role`, headers: json(cookie), payload: { role: 'Admin', version: owner.version } });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error).toBe('last_owner');
    const ben = users.find((u) => u.email === 'ben@x.example');
    const promote = await app.inject({ method: 'PATCH', url: `/api/users/${ben.id}/role`, headers: json(cookie), payload: { role: 'Owner', version: ben.version } });
    expect(promote.statusCode).toBe(200);
    const stale = await app.inject({ method: 'PATCH', url: `/api/users/${ben.id}/role`, headers: json(cookie), payload: { role: 'Viewer', version: ben.version } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${owner.id}/role`, headers: json(cookie), payload: { role: 'Admin', version: owner.version } })).statusCode).toBe(200);

    const role = await app.inject({ method: 'POST', url: '/api/roles', headers: json(cookie), payload: { name: 'Cashier', permissions: ['pos:sale.ring', 'pos:sale.read'] } });
    expect(role.statusCode).toBe(201);
    const preview = (await app.inject({ url: `/api/roles/preview?role=${role.json().id}`, headers: { cookie } })).json();
    const pos = preview.groups.find((g: any) => g.app === 'pos');
    expect(pos.permissions.filter((x: any) => x.granted).map((x: any) => x.id).sort()).toEqual(['pos:sale.read', 'pos:sale.ring']);
    expect((await app.inject({ method: 'POST', url: '/api/roles', headers: json(cookie), payload: { name: 'Sneaky', permissions: ['platform:tenant.delete'] } })).statusCode).toBe(422);
  });

  it('requires JSON for state-changing calls', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'slug=a&email=b' });
    expect(res.statusCode).toBe(415);
  });

  it('accepts carrier callbacks with a token and maps them to shipment commands, idempotently', async () => {
    const { cookie, tenantId } = await signupAndLogin(`car-${Date.now().toString(36)}`);
    for (const a of ['ordering', 'logistics']) {
      const r = await app.inject({ method: 'POST', url: `/api/apps/${a}/provision`, headers: json(cookie), payload: {} });
      expect(r.statusCode).toBe(202);
      await p.jobs.runAll();
    }
    const order = await app.inject({ method: 'POST', url: '/api/apps/ordering/commands/order.create', headers: json(cookie), payload: { channel: 'web', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 1 }] } });
    await p.ports.eventBus.drain();
    const ship = await app.inject({ method: 'POST', url: '/api/apps/logistics/commands/shipment.create', headers: json(cookie), payload: { order_id: order.json().id, carrier: 'jne' } });
    expect(ship.statusCode).toBe(201);
    const token = (await app.inject({ method: 'POST', url: '/api/apps/logistics/commands/carrier.connect', headers: json(cookie), payload: { carrier: 'jne' } })).json().token;
    const url = `/v1/inbound/${tenantId}/logistics/carrier/jne`;
    const body = { event_id: 'evt-1', tracking_no: ship.json().tracking_no, status: 'picked_up' };
    expect((await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-carrier-token': 'wrong' }, payload: body })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-carrier-token': token }, payload: body });
    expect(ok.statusCode).toBe(202);
    const dup = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-carrier-token': token }, payload: body });
    expect(dup.json().replayed).toBe(true);
    for (const [i, status] of ['in_transit', 'exception', 'delivered'].entries()) {
      await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-carrier-token': token }, payload: { event_id: `evt-${i + 2}`, tracking_no: body.tracking_no, status, note: 'test' } });
    }
    const detail = (await app.inject({ url: `/api/apps/logistics/entities/shipment/${ship.json().id}`, headers: { cookie } })).json();
    expect(detail.item.status).toBe('delivered');
    expect(detail.events.map((e: any) => e.type)).toEqual(
      expect.arrayContaining(['shipment.created', 'shipment.status_changed', 'shipment.exception', 'shipment.delivered']),
    );
    expect(detail.events.find((e: any) => e.type === 'shipment.delivered').origin).toBe('carrier');
  });

  it('expires trials and purges deleted tenants through lifecycle jobs', async () => {
    const { cookie, tenantId } = await signupAndLogin(`life-${Date.now().toString(36)}`);
    const db = admin();
    try {
      await db.query(`UPDATE tenant SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, [tenantId]);
      await lifecycleSweep(p);
      await p.jobs.runAll();
      expect((await app.inject({ url: '/api/tenant', headers: { cookie } })).json().tenant.status).toBe('suspended');
      const del = await app.inject({ method: 'POST', url: '/api/tenant/lifecycle', headers: json(cookie), payload: { to: 'deleted', confirm: 'nope' } });
      expect(del.statusCode).toBe(422);
      const slug = (await db.query(`SELECT slug FROM tenant WHERE id = $1`, [tenantId])).rows[0].slug;
      expect((await app.inject({ method: 'POST', url: '/api/tenant/lifecycle', headers: json(cookie), payload: { to: 'deleted', confirm: slug } })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/tenant', headers: { cookie } })).statusCode).toBe(401); // sessions revoked
      await db.query(`UPDATE tenant SET purge_after = now() - interval '1 minute' WHERE id = $1`, [tenantId]);
      await handleLifecycleJob(p, { kind: 'purge_tenant', tenantId });
      expect((await db.query(`SELECT count(*)::int AS n FROM tenant WHERE id = $1`, [tenantId])).rows[0].n).toBe(0);
      expect((await db.query(`SELECT count(*)::int AS n FROM app_user WHERE tenant_id = $1`, [tenantId])).rows[0].n).toBe(0);
      expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1`, [tenantId])).rows[0].n).toBeGreaterThan(0);
    } finally {
      await db.end();
    }
  });

  it('streams the provisioning checklist over SSE', async () => {
    const { cookie } = await signupAndLogin(`sse-${Date.now().toString(36)}`);
    const r = await app.inject({ method: 'POST', url: '/api/apps/payments/provision', headers: json(cookie), payload: {} });
    await p.jobs.runAll();
    const sse = await app.inject({ url: `/api/provisioning/runs/${r.json().runId}/stream`, headers: { cookie } });
    expect(sse.headers['content-type']).toContain('text/event-stream');
    expect(sse.body).toContain('event: run');
    expect(sse.body).toContain('"status":"succeeded"');
  });

  it('uses a correlation id per request', async () => {
    const id = `corr-${randomUUID()}`;
    const res = await app.inject({ url: '/api/health', headers: { 'x-correlation-id': id } });
    expect(res.headers['x-correlation-id']).toBe(id);
  });
});
