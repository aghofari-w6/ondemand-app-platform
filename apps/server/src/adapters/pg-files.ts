import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
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
      // No transaction is held while the body is produced (the producer may itself read
      // the database): the file row and each chunk are written in short transactions, and
      // the file only becomes readable when it is complete. An abandoned upload stays
      // `writing` with a one-day expiry, so the nightly cleanup removes it.
      await database.withTenant(tenantId, (tx) =>
        tx.insertInto('file_object').values({ id, tenant_id: tenantId, name: meta.name, content_type: meta.contentType, status: 'writing', purpose: meta.purpose, created_by: meta.createdBy, expires_at: new Date(Date.now() + 86_400_000) }).execute(),
      );
      try {
        let seq = 0;
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        const flush = async (all: boolean) => {
          while (pendingBytes >= CHUNK_BYTES || (all && pendingBytes > 0)) {
            const joined = Buffer.concat(pending, pendingBytes);
            const chunk = Buffer.from(joined.subarray(0, Math.min(CHUNK_BYTES, joined.length)));
            const rest = joined.subarray(chunk.length);
            const n = seq++;
            await database.withTenant(tenantId, (tx) => tx.insertInto('file_chunk').values({ tenant_id: tenantId, file_id: id, seq: n, data: chunk }).execute());
            pending = rest.length ? [Buffer.from(rest)] : [];
            pendingBytes = rest.length;
          }
        };
        for await (const part of body) {
          const buf = typeof part === 'string' ? Buffer.from(part) : Buffer.from(part.buffer, part.byteOffset, part.byteLength);
          size += buf.length;
          // Reject as soon as the cap is passed; the partial file is removed below.
          if (size > opts.maxBytes) throw new FileTooLarge(opts.maxBytes);
          hash.update(buf);
          pending.push(buf);
          pendingBytes += buf.length;
          await flush(false);
        }
        await flush(true);
      } catch (e) {
        await database.withTenant(tenantId, (tx) => tx.deleteFrom('file_object').where('id', '=', id).execute());
        throw e;
      }
      const sha256 = hash.digest('hex');
      await database.withTenant(tenantId, (tx) => tx.updateTable('file_object').set({ status: 'ready', size, sha256, expires_at: meta.expiresAt ?? null }).where('id', '=', id).execute());
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
