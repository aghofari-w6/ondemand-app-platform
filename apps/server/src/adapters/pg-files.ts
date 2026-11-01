import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql } from 'kysely';
import type { Database } from '../db/database.ts';
import type { FileMeta, Files, Vault } from '../ports/index.ts';

/**
 * Files on PostgreSQL (S3 later). A file is a `file_object` row plus ordered
 * `file_chunk` rows (bytea), both tenant tables under forced RLS.
 *
 * Streaming both ways (memory-safe-code §1): `put` consumes the body chunk by chunk and
 * writes CHUNK_BYTES at a time; `open` reads one chunk per pull. Neither ever holds the
 * whole file. Large objects were considered and rejected: `pg_largeobject` is not covered
 * by row-level security, so tenant isolation would rest on application code alone.
 */
export const CHUNK_BYTES = 256 * 1024;

export class FileTooLarge extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`the file is larger than ${maxBytes} bytes`);
    this.maxBytes = maxBytes;
  }
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');

export function createPgFiles(database: Database, vault: Vault): Files {
  const purpose = 'file-download';
  return {
    async put(tenantId: string, meta: FileMeta, body: AsyncIterable<Uint8Array | string>, opts: { maxBytes: number }) {
      const id = randomUUID();
      const hash = createHash('sha256');
      let size = 0;
      let sha256 = '';
      await database.withTenant(tenantId, async (tx) => {
        await tx.insertInto('file_object').values({ id, tenant_id: tenantId, name: meta.name, content_type: meta.contentType, status: 'writing', purpose: meta.purpose, created_by: meta.createdBy, expires_at: meta.expiresAt ?? null }).execute();
        let seq = 0;
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        const flush = async (all: boolean) => {
          while (pendingBytes >= CHUNK_BYTES || (all && pendingBytes > 0)) {
            const joined = Buffer.concat(pending, pendingBytes);
            const chunk = joined.subarray(0, Math.min(CHUNK_BYTES, joined.length));
            const rest = joined.subarray(chunk.length);
            await tx.insertInto('file_chunk').values({ tenant_id: tenantId, file_id: id, seq: seq++, data: chunk }).execute();
            pending = rest.length ? [Buffer.from(rest)] : [];
            pendingBytes = rest.length;
          }
        };
        for await (const part of body) {
          const buf = typeof part === 'string' ? Buffer.from(part) : Buffer.from(part.buffer, part.byteOffset, part.byteLength);
          size += buf.length;
          // Reject as soon as the cap is passed: the transaction rolls back, nothing is kept.
          if (size > opts.maxBytes) throw new FileTooLarge(opts.maxBytes);
          hash.update(buf);
          pending.push(buf);
          pendingBytes += buf.length;
          await flush(false);
        }
        await flush(true);
        sha256 = hash.digest('hex');
        await tx.updateTable('file_object').set({ status: 'ready', size, sha256 }).where('id', '=', id).execute();
      });
      return { id, size, sha256 };
    },

    async open(tenantId: string, id: string) {
      const f = await database.withTenant(tenantId, (tx) =>
        tx.selectFrom('file_object').select(['name', 'content_type', 'size', 'status', 'expires_at']).where('id', '=', id).executeTakeFirst(),
      );
      if (!f || f.status !== 'ready' || (f.expires_at && new Date(f.expires_at) < new Date())) return null;
      let seq = 0;
      async function* chunks() {
        for (;;) {
          const row = await database.withTenant(tenantId, (tx) => tx.selectFrom('file_chunk').select('data').where('file_id', '=', id).where('seq', '=', seq).executeTakeFirst());
          if (!row) return;
          seq++;
          yield row.data as Buffer;
        }
      }
      return { stream: Readable.from(chunks(), { objectMode: false }), name: f.name, contentType: f.content_type, size: Number(f.size) };
    },

    async remove(tenantId: string, id: string) {
      await database.withTenant(tenantId, (tx) => tx.deleteFrom('file_object').where('id', '=', id).execute());
    },

    signToken(tenantId: string, id: string, ttlSeconds: number) {
      const payload = b64(JSON.stringify({ t: tenantId, f: id, e: Math.floor(Date.now() / 1000) + ttlSeconds }));
      return `${payload}.${vault.mac(payload, purpose)}`;
    },

    verifyToken(token: string) {
      const [payload, sig] = token.split('.');
      if (!payload || !sig) return null;
      const want = Buffer.from(vault.mac(payload, purpose));
      const got = Buffer.from(sig);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
      try {
        const p = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { t: string; f: string; e: number };
        if (typeof p.t !== 'string' || typeof p.f !== 'string' || !(p.e > Date.now() / 1000)) return null;
        return { tenantId: p.t, fileId: p.f };
      } catch {
        // malformed payload: not a token we issued
        return null;
      }
    },
  };
}

/** Deletes expired files across tenants (nightly). Uses the narrow definer function. */
export async function purgeExpiredFiles(database: Database): Promise<number> {
  const r = await sql<{ n: number }>`SELECT delete_expired_files() AS n`.execute(database.db);
  return Number(r.rows[0]?.n ?? 0);
}
