import { sql } from 'kysely';
import { newId, type Database, type Tx } from '../db/database.ts';
import { randomToken, sha256 } from './crypto.ts';

export const SESSION_COOKIE = 'aod_session';
const SESSION_TTL_MS = 12 * 3600_000;
const LOGIN_TOKEN_TTL_MS = { magic: 15 * 60_000, invite: 7 * 24 * 3600_000 };

const UUID = /^[0-9a-f-]{36}$/i;

/** Opaque compound token `<tenantId>.<secret>`; only sha256(secret) is stored. */
export function splitToken(value: string | undefined): { tenantId: string; secret: string } | null {
  if (!value) return null;
  const i = value.indexOf('.');
  if (i < 0) return null;
  const tenantId = value.slice(0, i);
  const secret = value.slice(i + 1);
  return UUID.test(tenantId) && secret.length >= 20 ? { tenantId, secret } : null;
}

export async function createSession(tx: Tx, tenantId: string, userId: string, method: string): Promise<{ cookie: string; expiresAt: Date }> {
  const secret = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await tx.insertInto('user_session').values({ id: newId(), tenant_id: tenantId, user_id: userId, token_hash: sha256(secret), method, expires_at: expiresAt }).execute();
  await tx.updateTable('app_user').set({ last_login_at: new Date(), status: 'active' }).where('id', '=', userId).where('status', '<>', 'disabled').execute();
  return { cookie: `${tenantId}.${secret}`, expiresAt };
}

export interface SessionUser {
  tenantId: string;
  sessionId: string;
  user: { id: string; email: string; name: string; role: string; version: number };
  tenant: { id: string; slug: string; name: string; status: string };
}

export async function readSession(database: Database, cookie: string | undefined): Promise<SessionUser | null> {
  const t = splitToken(cookie);
  if (!t) return null;
  return database.withTenant(t.tenantId, async (tx) => {
    const row = await tx
      .selectFrom('user_session as s')
      .innerJoin('app_user as u', 'u.id', 's.user_id')
      .innerJoin('tenant as t', 't.id', 's.tenant_id')
      .select(['s.id as sid', 'u.id', 'u.email', 'u.name', 'u.role', 'u.version', 'u.status as ustatus', 't.slug', 't.name as tname', 't.status as tstatus'])
      .where('s.token_hash', '=', sha256(t.secret))
      .where('s.revoked_at', 'is', null)
      .where('s.expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (!row || row.ustatus === 'disabled' || row.tstatus === 'deleted') return null;
    return {
      tenantId: t.tenantId,
      sessionId: row.sid,
      user: { id: row.id, email: row.email, name: row.name, role: row.role, version: row.version },
      tenant: { id: t.tenantId, slug: row.slug, name: row.tname, status: row.tstatus },
    };
  });
}

export async function revokeSession(database: Database, cookie: string | undefined) {
  const t = splitToken(cookie);
  if (!t) return;
  await database.withTenant(t.tenantId, (tx) => tx.updateTable('user_session').set({ revoked_at: new Date() }).where('token_hash', '=', sha256(t.secret)).execute());
}

export async function createLoginToken(tx: Tx, tenantId: string, userId: string, purpose: 'magic' | 'invite'): Promise<string> {
  const secret = randomToken();
  await tx
    .insertInto('login_token')
    .values({ id: newId(), tenant_id: tenantId, user_id: userId, token_hash: sha256(secret), purpose, expires_at: new Date(Date.now() + LOGIN_TOKEN_TTL_MS[purpose]) })
    .execute();
  return `${tenantId}.${secret}`;
}

/** Single-use: marks the token used and returns its user. */
export async function consumeLoginToken(tx: Tx, secret: string): Promise<{ userId: string; purpose: string } | null> {
  const row = await tx
    .updateTable('login_token')
    .set({ used_at: new Date() })
    .where('token_hash', '=', sha256(secret))
    .where('used_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .returning(['user_id', 'purpose'])
    .executeTakeFirst();
  return row ? { userId: row.user_id, purpose: row.purpose } : null;
}
