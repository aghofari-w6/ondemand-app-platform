import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.ts';
import { closePlatform, testPlatform } from './helpers.ts';

const p = testPlatform();
let app: FastifyInstance;
let cookie = '';
let tenantId = '';
const json = (c?: string) => ({ 'content-type': 'application/json', ...(c ? { cookie: c } : {}) });
const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra });

beforeAll(async () => {
  app = await buildApp(p);
  const slug = `api-${Date.now().toString(36)}`;
  const su = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: json(), payload: { workspaceName: 'API Co', slug, ownerName: 'O', email: `o@${slug}.example` } });
  tenantId = su.json().tenant.id;
  const token = decodeURIComponent(su.json().delivery.preview.link.split('token=')[1]);
  cookie = String((await app.inject({ method: 'POST', url: '/api/auth/verify', headers: json(), payload: { token } })).headers['set-cookie']).split(';')[0]!;
  await app.inject({ method: 'POST', url: '/api/apps/ordering/provision', headers: json(cookie), payload: {} });
  await p.jobs.runAll();
  // A custom entity through the Data studio API.
  const draft = await app.inject({ method: 'POST', url: '/api/datastudio/draft', headers: json(cookie), payload: {} });
  const field = (key: string, extra = {}) => ({ key, label: key, type: 'text', ...extra });
  const definition = { app_fields: [], entities: [{ key: 'supplier', label: 'Supplier', title_field: 'name', fields: [field('name', { required: true }), field('email', { pii: true })] }], layouts: [], field_access: [] };
  const saved = await app.inject({ method: 'PUT', url: '/api/datastudio/draft', headers: json(cookie), payload: { definition, version: draft.json().version } });
  expect(saved.statusCode).toBe(200);
  const impact = await app.inject({ url: '/api/datastudio/draft/impact', headers: { cookie } });
  expect(impact.json().problems).toEqual([]);
  const pub = await app.inject({ method: 'POST', url: '/api/datastudio/draft/publish', headers: json(cookie), payload: { version: saved.json().version } });
  expect(pub.statusCode).toBe(200);
});
afterAll(async () => {
  await app.close();
  await closePlatform(p);
});

describe('public /v1 API', () => {
  it('issues scoped API keys shown once and enforces scopes', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/api-keys', headers: json(cookie), payload: { name: 'reader', scopes: ['records:read'] } });
    expect(created.statusCode).toBe(201);
    const key = created.json().key as string;
    expect(key).toMatch(new RegExp(`^aod_key\\.${tenantId}\\.`));
    const listed = await app.inject({ url: '/api/api-access', headers: { cookie } });
    expect(JSON.stringify(listed.json())).not.toContain(key.split('.')[2]);

    expect((await app.inject({ url: '/v1/records/supplier', headers: bearer(key) })).statusCode).toBe(200);
    const denied = await app.inject({ method: 'POST', url: '/v1/records/supplier', headers: bearer(key), payload: { values: { name: 'x' } } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('insufficient_scope');
    expect((await app.inject({ url: '/v1/records/supplier', headers: bearer(key.slice(0, -2) + 'xx') })).statusCode).toBe(401);
    // Cookies never authenticate /v1.
    expect((await app.inject({ url: '/v1/records/supplier', headers: { cookie } })).statusCode).toBe(401);

    await app.inject({ method: 'POST', url: `/api/api-access/keys/${created.json().id}/revoke`, headers: json(cookie), payload: {} });
    expect((await app.inject({ url: '/v1/records/supplier', headers: bearer(key) })).statusCode).toBe(401);
  });

  it('runs the OAuth client credentials grant and serves records and app data', async () => {
    const c = (await app.inject({ method: 'POST', url: '/api/oauth-clients', headers: json(cookie), payload: { name: 'erp', scopes: ['records:write', 'apps:read', 'apps:write'] } })).json();
    const basic = Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
    const bad = await app.inject({ method: 'POST', url: '/v1/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${c.client_id}:aod_cs.wrong`).toString('base64')}` }, payload: 'grant_type=client_credentials' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe('invalid_client');
    const tok = await app.inject({ method: 'POST', url: '/v1/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, payload: 'grant_type=client_credentials&scope=records:write apps:write' });
    expect(tok.statusCode).toBe(200);
    expect(tok.json()).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'records:write apps:write' });
    const at = tok.json().access_token;

    const r1 = await app.inject({ method: 'POST', url: '/v1/records/supplier', headers: bearer(at, { 'idempotency-key': 'erp-supplier-0001' }), payload: { values: { name: 'Kopi', email: 'k@kopi.example' } } });
    const r2 = await app.inject({ method: 'POST', url: '/v1/records/supplier', headers: bearer(at, { 'idempotency-key': 'erp-supplier-0001' }), payload: { values: { name: 'Kopi', email: 'k@kopi.example' } } });
    expect(r1.statusCode).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.json().id).toBe(r1.json().id);
    const upd = await app.inject({ method: 'PATCH', url: `/v1/records/supplier/${r1.json().id}`, headers: bearer(at), payload: { version: 1, values: { name: 'Kopi Ltd' } } });
    expect(upd.json().version).toBe(2);

    const cmd = await app.inject({ method: 'POST', url: '/v1/apps/ordering/commands/order.create', headers: bearer(at), payload: { channel: 'marketplace', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 1 }] } });
    expect(cmd.statusCode).toBe(201);
    // apps:read was not requested for this token
    expect((await app.inject({ url: '/v1/apps/ordering/order', headers: bearer(at) })).statusCode).toBe(403);
    const audit = (await app.inject({ url: '/api/audit?action=order.create', headers: { cookie } })).json().items;
    expect(audit[0].actor_type).toBe('ApiClient');
  });

  it('limits delegated tokens to the issuing user and the token scopes', async () => {
    const t = (await app.inject({ method: 'POST', url: '/api/tokens', headers: json(cookie), payload: { name: 'zapier', scopes: ['apps:read'], expires_in_minutes: 30 } })).json();
    expect(t.token).toMatch(/^aod_dt\./);
    expect((await app.inject({ url: '/v1/apps/ordering/order', headers: bearer(t.token) })).statusCode).toBe(200);
    const revoked = await app.inject({ method: 'POST', url: `/api/tokens/${t.id}/revoke`, headers: json(cookie), payload: {} });
    expect(revoked.statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/apps/ordering/order', headers: bearer(t.token) })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/audit?action=token.revoked', headers: { cookie } })).json().items).toHaveLength(1);
    const t2 = (await app.inject({ method: 'POST', url: '/api/tokens', headers: json(cookie), payload: { name: 'zapier2', scopes: ['apps:read'], expires_in_minutes: 30 } })).json();
    const write = await app.inject({ method: 'POST', url: '/v1/apps/ordering/commands/order.create', headers: bearer(t2.token), payload: { channel: 'web', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 1 }] } });
    expect(write.statusCode).toBe(403);
    // A Viewer's delegated token cannot write even with a write scope.
    const inv = await app.inject({ method: 'POST', url: '/api/users/invite', headers: json(cookie), payload: { email: 'viewer@x.example', name: 'V', role: 'Viewer' } });
    const vtoken = decodeURIComponent(inv.json().delivery.preview.link.split('token=')[1]);
    const vcookie = String((await app.inject({ method: 'POST', url: '/api/auth/verify', headers: json(), payload: { token: vtoken } })).headers['set-cookie']).split(';')[0]!;
    const vt = (await app.inject({ method: 'POST', url: '/api/tokens', headers: json(vcookie), payload: { name: 'v', scopes: ['apps:write', 'apps:read'] } })).json();
    expect((await app.inject({ method: 'POST', url: '/v1/apps/ordering/commands/order.create', headers: bearer(vt.token), payload: { channel: 'web', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 1 }] } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/v1/apps/ordering/order', headers: bearer(vt.token) })).statusCode).toBe(200);
  });

  it('serves a per-tenant OpenAPI document', async () => {
    const key = (await app.inject({ method: 'POST', url: '/api/api-keys', headers: json(cookie), payload: { name: 'docs', scopes: ['apps:read'] } })).json().key;
    const doc = (await app.inject({ url: '/v1/openapi.json', headers: bearer(key) })).json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/v1/apps/ordering/order', '/v1/apps/ordering/commands/order.create', '/v1/records/supplier', '/v1/records/supplier/{id}', '/v1/oauth/token', '/v1/sync/{syncId}']));
    expect(Object.keys(doc.paths).some((x) => x.includes('/pos/'))).toBe(false); // POS is not provisioned here
    expect(doc.components.schemas.CustomSupplierValues.required).toEqual(['name']);
    expect(doc.components.schemas.CustomSupplierValues.properties.email.description).toMatch(/PII/);
    expect(doc.paths['/v1/apps/ordering/commands/order.create'].post.requestBody.content['application/json'].schema.properties.lines.type).toBe('array');
    expect(doc.components.securitySchemes.oauth2.flows.clientCredentials.scopes).toHaveProperty('records:write');
  });
});
