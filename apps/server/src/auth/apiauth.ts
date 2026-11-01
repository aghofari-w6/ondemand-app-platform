import { CommandError, type ApiScope, type Principal, type ResolvedRole } from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../db/database.ts';
import type { Catalog } from '../platform/catalog.ts';
import type { Platform } from '../platform/context.ts';
import { recordChange } from '../platform/record.ts';
import { randomToken, sha256 } from './crypto.ts';
import { principalFor } from './principal.ts';

/**
 * Public API credentials. Only SHA-256 hashes are stored; the secret is shown once.
 * Every credential embeds its tenant id so it can be resolved under RLS:
 *   API key            aod_key.<tenant>.<secret>
 *   OAuth client id    aod_client.<tenant>.<client uuid>   (secret: aod_cs.<secret>)
 *   OAuth access token aod_at.<tenant>.<secret>            (client credentials, 1 h)
 *   Delegated token    aod_dt.<tenant>.<secret>            (acts for a user, never beyond that user)
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OAUTH_TTL_S = 3600;

/** Scope -> permissions. App scopes never reach admin-level permissions. */
export function scopePermissions(catalog: Catalog, scopes: string[]): string[] {
  const out = new Set<string>();
  for (const s of scopes as ApiScope[]) {
    for (const perm of catalog.permissions) {
      const app = perm.id.split(':')[0];
      if (app === 'platform') continue;
      if (s === 'apps:read' && perm.level === 'read') out.add(perm.id);
      if (s === 'apps:write' && (perm.level === 'operate' || perm.level === 'manage')) out.add(perm.id);
    }
    if (s === 'records:read') out.add('platform:records.read');
    if (s === 'records:write' || s === 'sync:write') {
      out.add('platform:records.read');
      out.add('platform:records.write');
    }
  }
  return [...out];
}

export interface BearerContext {
  tenantId: string;
  principal: Principal;
  scopes: string[];
  kind: 'api_key' | 'oauth' | 'delegated';
}

function split(token: string, prefix: string) {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix || !UUID.test(parts[1]!) || parts[2]!.length < 20) return null;
  return { tenantId: parts[1]!, secret: parts[2]! };
}

const apiRole = (name: string, permissions: string[]): ResolvedRole => ({ name, preset: null, permissions, fieldRules: [] });

/** Resolves `Authorization: Bearer ...` into a tenant and a scoped principal. */
export async function resolveBearer(p: Platform, header: string | undefined): Promise<BearerContext> {
  const fail = () => new CommandError(401, 'invalid_token', 'missing or invalid bearer token');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw fail();
  const prefix = token.split('.')[0];
  const kind = prefix === 'aod_key' ? 'api_key' : prefix === 'aod_at' ? 'oauth' : prefix === 'aod_dt' ? 'delegated' : null;
  const t = kind ? split(token, prefix!) : null;
  if (!kind || !t) throw fail();
  return p.database.withTenant(t.tenantId, async (tx) => {
    const tenant = await tx.selectFrom('tenant').select('status').executeTakeFirst();
    if (!tenant || tenant.status === 'deleted' || tenant.status === 'suspended') throw new CommandError(403, 'tenant_unavailable', 'this workspace is not available');
    const now = sql<Date>`now()`;
    if (kind === 'api_key') {
      const k = await tx.selectFrom('api_key').select(['id', 'scopes', 'expires_at']).where('key_hash', '=', sha256(t.secret)).where('revoked_at', 'is', null).executeTakeFirst();
      if (!k || (k.expires_at && new Date(k.expires_at) < new Date())) throw fail();
      await tx.updateTable('api_key').set({ last_used_at: now }).where('id', '=', k.id).execute();
      return { tenantId: t.tenantId, scopes: k.scopes, kind, principal: { type: 'ApiClient', id: `key:${k.id}`, tenantId: t.tenantId, roles: [apiRole('api key', scopePermissions(p.catalog, k.scopes))] } };
    }
    const row = await tx.selectFrom('access_token').selectAll().where('token_hash', '=', sha256(t.secret)).where('kind', '=', kind).where('revoked_at', 'is', null).where('expires_at', '>', now).executeTakeFirst();
    if (!row) throw fail();
    if (kind === 'oauth') {
      const c = await tx.selectFrom('oauth_client').select('revoked_at').where('id', '=', row.client_id).executeTakeFirst();
      if (!c || c.revoked_at) throw fail();
      return { tenantId: t.tenantId, scopes: row.scopes, kind, principal: { type: 'ApiClient', id: `client:${row.client_id}`, tenantId: t.tenantId, roles: [apiRole('oauth client', scopePermissions(p.catalog, row.scopes))] } };
    }
    // Delegated: the intersection of the user's current role and the token's scopes.
    const u = await tx.selectFrom('app_user').select(['id', 'role', 'status']).where('id', '=', row.user_id).executeTakeFirst();
    if (!u || u.status === 'disabled') throw fail();
    const user = await principalFor(tx, p.catalog, t.tenantId, { id: u.id, role: u.role });
    const allowed = new Set(scopePermissions(p.catalog, row.scopes));
    const role = user.roles[0];
    const userPerms = role?.preset === 'Owner' ? p.catalog.permissions.map((x) => x.id) : (role?.permissions ?? []);
    return {
      tenantId: t.tenantId,
      scopes: row.scopes,
      kind,
      principal: { type: 'User', id: u.id, tenantId: t.tenantId, roles: [{ name: `delegated:${role?.name ?? 'none'}`, preset: null, permissions: userPerms.filter((x) => allowed.has(x)), fieldRules: role?.fieldRules ?? [] }] },
    };
  });
}

async function limitCheck(p: Platform, tx: Tx) {
  const t = await tx.selectFrom('tenant').select('plan').executeTakeFirstOrThrow();
  const limit = p.ports.billing.plan(t.plan)?.limits.api_keys ?? 0;
  const n = await tx.selectFrom('api_key').select(sql<number>`count(*)::int`.as('n')).where('revoked_at', 'is', null).executeTakeFirstOrThrow();
  if (n.n >= limit) throw new CommandError(409, 'plan_limit', `your plan allows ${limit} active API keys`);
}

export async function createApiKey(p: Platform, tx: Tx, tenantId: string, actor: Principal, input: { name: string; scopes: string[]; expires_in_days?: number | undefined }, correlationId: string) {
  await limitCheck(p, tx);
  const secret = randomToken(32);
  const id = newId();
  await tx
    .insertInto('api_key')
    .values({ id, tenant_id: tenantId, name: input.name, key_hash: sha256(secret), hint: secret.slice(-4), scopes: input.scopes, created_by: actor.id, expires_at: input.expires_in_days ? new Date(Date.now() + input.expires_in_days * 86_400_000) : null })
    .execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:apikey.created', resourceType: 'platform::ApiKey', resourceId: id, correlationId, events: [{ type: 'apikey.created', data: { key_id: id, scopes: input.scopes } }] });
  return { id, key: `aod_key.${tenantId}.${secret}` };
}

export async function createOAuthClient(p: Platform, tx: Tx, tenantId: string, actor: Principal, input: { name: string; scopes: string[] }, correlationId: string) {
  const secret = randomToken(32);
  const id = newId();
  await tx.insertInto('oauth_client').values({ id, tenant_id: tenantId, name: input.name, secret_hash: sha256(secret), scopes: input.scopes, created_by: actor.id }).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:oauth_client.created', resourceType: 'platform::OAuthClient', resourceId: id, correlationId, events: [{ type: 'oauth_client.created', data: { client_id: id, scopes: input.scopes } }] });
  return { id, client_id: `aod_client.${tenantId}.${id}`, client_secret: `aod_cs.${secret}` };
}

/** OAuth 2.0 client credentials grant (RFC 6749 §4.4). */
export async function clientCredentialsGrant(p: Platform, clientId: string, clientSecret: string, requested?: string) {
  const parts = clientId.split('.');
  const invalid = () => Object.assign(new CommandError(401, 'invalid_client', 'client authentication failed'), { oauth: true });
  if (parts.length !== 3 || parts[0] !== 'aod_client' || !UUID.test(parts[1]!) || !UUID.test(parts[2]!) || !clientSecret.startsWith('aod_cs.')) throw invalid();
  const [, tenantId, id] = parts as [string, string, string];
  return p.database.withTenant(tenantId, async (tx) => {
    const c = await tx.selectFrom('oauth_client').selectAll().where('id', '=', id).executeTakeFirst();
    if (!c || c.revoked_at || c.secret_hash !== sha256(clientSecret.slice(7))) throw invalid();
    const scopes = requested ? requested.split(' ').filter(Boolean) : c.scopes;
    const extra = scopes.filter((s: string) => !c.scopes.includes(s));
    if (extra.length) throw Object.assign(new CommandError(400, 'invalid_scope', `not granted: ${extra.join(' ')}`), { oauth: true });
    const secret = randomToken(32);
    await tx.insertInto('access_token').values({ id: newId(), tenant_id: tenantId, kind: 'oauth', token_hash: sha256(secret), client_id: id, scopes, expires_at: new Date(Date.now() + OAUTH_TTL_S * 1000) }).execute();
    return { access_token: `aod_at.${tenantId}.${secret}`, token_type: 'Bearer', expires_in: OAUTH_TTL_S, scope: scopes.join(' ') };
  });
}

export async function createDelegatedToken(p: Platform, tx: Tx, tenantId: string, user: Principal, input: { name: string; scopes: string[]; expires_in_minutes: number }, correlationId: string) {
  const secret = randomToken(32);
  const id = newId();
  const expires = new Date(Date.now() + input.expires_in_minutes * 60_000);
  await tx.insertInto('access_token').values({ id, tenant_id: tenantId, kind: 'delegated', token_hash: sha256(secret), user_id: user.id, name: input.name, scopes: input.scopes, expires_at: expires }).execute();
  await recordChange(p, tx, { tenantId, actor: user, action: 'platform:token.delegated', resourceType: 'platform::AccessToken', resourceId: id, correlationId, events: [{ type: 'token.delegated', data: { token_id: id, scopes: input.scopes, expires_at: expires.toISOString() } }] });
  return { id, token: `aod_dt.${tenantId}.${secret}`, expires_at: expires.toISOString() };
}
