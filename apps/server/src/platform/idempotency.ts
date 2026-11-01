import { CommandError } from '@aod/shared';
import { sql } from 'kysely';
import type { Tx } from '../db/database.ts';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;

export function assertIdempotencyKey(key: string | undefined) {
  if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
    throw new CommandError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8–200 characters of [A-Za-z0-9_.:-]');
  }
}

/**
 * Claims an Idempotency-Key inside the write transaction (kept 24 h). Returns the stored
 * response when the same request was already completed; 422 when the key was used for
 * a different request. A concurrent request with the same key waits on the row lock.
 */
export async function claimIdempotencyKey(tx: Tx, tenantId: string, key: string, scope: string, hash: string): Promise<{ status: number; body: any } | null> {
  await tx.deleteFrom('idempotency_key').where('key', '=', key).where('expires_at', '<', sql<Date>`now()`).execute();
  const inserted = await tx
    .insertInto('idempotency_key')
    .values({ tenant_id: tenantId, key, scope, request_hash: hash })
    .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();
  if (inserted) return null;
  const prior = await tx.selectFrom('idempotency_key').selectAll().where('key', '=', key).executeTakeFirstOrThrow();
  if (prior.request_hash !== hash || prior.scope !== scope) throw new CommandError(422, 'idempotency_key_reused', 'this Idempotency-Key was used for a different request');
  if (prior.response) return { status: prior.status_code, body: prior.response };
  throw new CommandError(409, 'idempotency_in_progress', 'a request with this Idempotency-Key is still in progress');
}

export async function storeIdempotentResponse(tx: Tx, key: string, status: number, body: unknown) {
  await tx.updateTable('idempotency_key').set({ status_code: status, response: JSON.stringify(body) }).where('key', '=', key).execute();
}
