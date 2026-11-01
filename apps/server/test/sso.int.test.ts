import { createSign, generateKeyPairSync } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.ts';
import { closePlatform, testPlatform } from './helpers.ts';

/**
 * OIDC sign-in against an in-process mock identity provider (discovery, JWKS and a
 * token endpoint issuing RS256 ID tokens), exercising openid-client for real.
 */
const p = testPlatform();
let app: FastifyInstance;
let idp: FastifyInstance;
let issuer = '';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const codes = new Map<string, { email: string }>();
let lastNonce = '';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims: Record<string, unknown>) {
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = b64(claims);
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

beforeAll(async () => {
  idp = Fastify();
  await idp.register(formbody);
  idp.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
  }));
  idp.get('/jwks', async () => ({ keys: [jwk] }));
  idp.post('/token', async (req) => {
    const body = req.body as Record<string, string>;
    const c = codes.get(body.code!);
    if (!c || body.client_id !== 'aod-client' || body.client_secret !== 'shh' || !body.code_verifier) return { error: 'invalid_grant' };
    const now = Math.floor(Date.now() / 1000);
    return { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken({ iss: issuer, sub: 'u-1', aud: 'aod-client', iat: now, exp: now + 300, nonce: lastNonce, email: c.email, email_verified: true }) };
  });
  issuer = (await idp.listen({ port: 0, host: '127.0.0.1' })).replace('127.0.0.1', 'localhost');
  app = await buildApp(p);
});
afterAll(async () => {
  await app.close();
  await idp.close();
  await closePlatform(p);
});

const json = (cookie?: string) => ({ 'content-type': 'application/json', ...(cookie ? { cookie } : {}) });

describe('single sign-on', () => {
  it('configures OIDC with a write-only encrypted secret, runs a test sign-in, then signs in', async () => {
    const slug = `sso-${Date.now().toString(36)}`;
    const email = `owner@${slug}.example`;
    const su = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: json(), payload: { workspaceName: 'SSO Co', slug, ownerName: 'O', email } });
    const token = decodeURIComponent(su.json().delivery.preview.link.split('token=')[1]);
    const v = await app.inject({ method: 'POST', url: '/api/auth/verify', headers: json(), payload: { token } });
    const cookie = String(v.headers['set-cookie']).split(';')[0]!;

    const put = await app.inject({ method: 'PUT', url: '/api/sso', headers: json(cookie), payload: { kind: 'oidc', issuer, clientId: 'aod-client', clientSecret: 'shh' } });
    expect(put.statusCode).toBe(200);
    const cfg = (await app.inject({ url: '/api/sso', headers: { cookie } })).json();
    expect(cfg.config).toMatchObject({ kind: 'oidc', issuer, hasSecret: true });
    expect(JSON.stringify(cfg)).not.toContain('shh');

    // Enforcing SSO requires an Owner password first (lock-out protection).
    expect((await app.inject({ method: 'PUT', url: '/api/sso', headers: json(cookie), payload: { kind: 'oidc', issuer, clientId: 'aod-client', enforce: true } })).statusCode).toBe(409);

    // Test sign-in: redirect URL carries state, nonce and a PKCE challenge.
    const t = (await app.inject({ method: 'POST', url: '/api/sso/test', headers: json(cookie), payload: {} })).json();
    const authUrl = new URL(t.url);
    expect(authUrl.origin + authUrl.pathname).toBe(`${issuer}/authorize`);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    lastNonce = authUrl.searchParams.get('nonce')!;
    codes.set('code-1', { email });
    const cb = await app.inject({ url: `/api/auth/oidc/callback?code=code-1&state=${encodeURIComponent(authUrl.searchParams.get('state')!)}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/settings?sso_test=done');
    expect((await app.inject({ url: '/api/sso', headers: { cookie } })).json().config.lastTestResult).toBe(`ok: signed in as ${email}`);

    // Real sign-in through the public start URL creates a session.
    const start = await app.inject({ url: `/api/auth/sso/${slug}/start` });
    const startUrl = new URL(String(start.headers.location));
    lastNonce = startUrl.searchParams.get('nonce')!;
    codes.set('code-2', { email });
    const done = await app.inject({ url: `/api/auth/oidc/callback?code=code-2&state=${encodeURIComponent(startUrl.searchParams.get('state')!)}` });
    expect(done.headers.location).toBe('/');
    const sso = String(done.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: sso } })).json().user.email).toBe(email);

    // A replayed state is rejected.
    const replay = await app.inject({ url: `/api/auth/oidc/callback?code=code-2&state=${encodeURIComponent(startUrl.searchParams.get('state')!)}` });
    expect(replay.statusCode).toBe(400);

    // Owner password fallback.
    expect((await app.inject({ method: 'POST', url: '/api/me/password', headers: json(cookie), payload: { password: 'correct horse battery' } })).statusCode).toBe(200);
    const pw = await app.inject({ method: 'POST', url: '/api/auth/password', headers: json(), payload: { slug, email, password: 'correct horse battery' } });
    expect(pw.statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/sso', headers: json(cookie), payload: { kind: 'oidc', issuer, clientId: 'aod-client', enforce: true } })).statusCode).toBe(200);
    const blocked = await app.inject({ method: 'POST', url: '/api/users/invite', headers: json(cookie), payload: { email: `m@${slug}.example`, name: 'M', role: 'Manager' } });
    expect(blocked.statusCode).toBe(201);
    const magic = await app.inject({ method: 'POST', url: '/api/auth/login', headers: json(), payload: { slug, email: `m@${slug}.example` } });
    expect(magic.json().error).toBe('sso_required');
  });

  it('builds a SAML AuthnRequest redirect for the configured IdP', async () => {
    const slug = `saml-${Date.now().toString(36)}`;
    const su = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: json(), payload: { workspaceName: 'SAML Co', slug, ownerName: 'O', email: `o@${slug}.example` } });
    const token = decodeURIComponent(su.json().delivery.preview.link.split('token=')[1]);
    const cookie = String((await app.inject({ method: 'POST', url: '/api/auth/verify', headers: json(), payload: { token } })).headers['set-cookie']).split(';')[0]!;
    const cert = (publicKey.export({ format: 'pem', type: 'spki' }) as string).replace(/-----[^-]+-----|\n/g, '');
    expect((await app.inject({ method: 'PUT', url: '/api/sso', headers: json(cookie), payload: { kind: 'saml', entryPoint: 'https://idp.example/sso', idpIssuer: 'https://idp.example', idpCert: cert } })).statusCode).toBe(200);
    const t = (await app.inject({ method: 'POST', url: '/api/sso/test', headers: json(cookie), payload: {} })).json();
    const u = new URL(t.url);
    expect(u.origin + u.pathname).toBe('https://idp.example/sso');
    expect(u.searchParams.get('SAMLRequest')).toBeTruthy();
    expect(u.searchParams.get('RelayState')).toMatch(/^[0-9a-f-]{36}\./);
  });
});
