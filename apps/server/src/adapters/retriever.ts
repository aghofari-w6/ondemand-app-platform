import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { newId, type Database } from '../db/database.ts';
import type { Embeddings, OutboundHttp, RetrievedChunk, Retriever } from '../ports/index.ts';

// ------------------------------------------------------------------ chunking

export const CHUNK_CHARS = 1200;
export const MAX_CHUNKS = 2000;

/** Splits text into chunks of about `size` characters on paragraph, then sentence, boundaries. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (const para of text.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const pieces = para.length > size ? (para.match(/[^.!?\n]+[.!?]*\s*/g) ?? [para]) : [para];
    for (let piece of pieces) {
      // A single run longer than a chunk (no sentence ends) is cut hard.
      while (piece.length > size) {
        push();
        out.push(piece.slice(0, size).trim());
        piece = piece.slice(size);
      }
      if (cur.length + piece.length + 2 > size) push();
      cur += (cur ? (pieces.length > 1 ? ' ' : '\n\n') : '') + piece.trim();
    }
    if (out.length >= MAX_CHUNKS) break;
  }
  push();
  return out.slice(0, MAX_CHUNKS);
}

// ------------------------------------------------------------------ embeddings

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

/**
 * Deterministic embedder for CI, e2e and local runs (plan decision 6: no live calls yet).
 * A hashed bag of words, L2-normalised: texts sharing words are close, so retrieval tests
 * are meaningful without a model.
 */
export function createFakeEmbeddings(dimension: number): Embeddings {
  const embed = (text: string) => {
    const v = new Array<number>(dimension).fill(0);
    for (const w of words(text)) {
      const h = createHash('sha256').update(w).digest();
      v[h.readUInt32BE(0) % dimension]! += 1;
      v[h.readUInt32BE(4) % dimension]! += 0.5;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  return {
    model: 'fake-hash',
    dimension,
    async embed(texts) {
      return { vectors: texts.map(embed), tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Voyage AI embeddings API client. Documents and queries use the matching `input_type`;
 * 429 and 5xx are retried with backoff (honouring `retry-after`) a bounded number of times.
 */
export function createVoyageEmbeddings(http: OutboundHttp, o: { apiKey: string | undefined; baseUrl: string; model: string; dimension: number; maxAttempts?: number; baseDelayMs?: number }): Embeddings {
  const maxAttempts = o.maxAttempts ?? 4;
  return {
    model: o.model,
    dimension: o.dimension,
    async embed(texts, inputType) {
      if (!o.apiKey) throw new Error('VOYAGE_API_KEY is not configured');
      for (let attempt = 1; ; attempt++) {
        const r = await http.json({
          url: `${o.baseUrl.replace(/\/$/, '')}/v1/embeddings`,
          headers: { authorization: `Bearer ${o.apiKey}` },
          body: { input: texts, model: o.model, input_type: inputType, output_dimension: o.dimension },
          // 64 texts × 1024 floats is about 1.5 MB of JSON; anything far larger is not an embeddings response
          maxBytes: 8 * 1024 * 1024,
        });
        if (r.ok) {
          const data = [...((r.body?.data ?? []) as { index: number; embedding: number[] }[])].sort((a, b) => a.index - b.index);
          if (data.length !== texts.length || data.some((d) => d.embedding.length !== o.dimension)) throw new Error(`Voyage returned ${data.length} embedding(s) of the wrong shape (expected ${texts.length} × ${o.dimension})`);
          return { vectors: data.map((d) => d.embedding), tokens: Number(r.body?.usage?.total_tokens ?? 0) };
        }
        const retryable = r.status === 429 || r.status >= 500;
        if (!retryable || attempt >= maxAttempts) throw new Error(`Voyage embeddings failed: HTTP ${r.status}`);
        await sleep(r.retryAfterMs ?? (o.baseDelayMs ?? 500) * 2 ** (attempt - 1));
      }
    },
  };
}

// ------------------------------------------------------------------ retriever

const BATCH = 64;
const vec = (v: number[]) => `[${v.join(',')}]`;

/**
 * Retriever port on PostgreSQL: pgvector cosine distance fused with full-text rank
 * (reciprocal-rank fusion, k = 60). Queries run in the tenant's transaction (RLS) and also
 * filter by `tenant_id` explicitly. With pgvector >= 0.8 the HNSW scan is iterative, so the
 * tenant filter does not cost recall; older versions fall back to an exact scan.
 */
export function createPgVectorRetriever(database: Database, embeddings: Embeddings, log: (msg: string, err: unknown) => void = () => undefined): Retriever {
  let ready: Promise<{ iterative: boolean }> | null = null;
  const prepare = () =>
    (ready ??= (async () => {
      const r = await database.withoutTenant(async (tx) => {
        const ext = await sql<{ extversion: string }>`SELECT extversion FROM pg_extension WHERE extname = 'vector'`.execute(tx);
        const col = await sql<{ dim: number }>`SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'doc_chunk'::regclass AND attname = 'embedding'`.execute(tx);
        return { version: ext.rows[0]?.extversion ?? '0', dim: col.rows[0]?.dim ?? 0 };
      });
      if (r.dim !== embeddings.dimension) throw new Error(`EMBEDDINGS_DIM is ${embeddings.dimension} but doc_chunk.embedding is vector(${r.dim}); they must match`);
      const [major = 0, minor = 0] = r.version.split('.').map(Number);
      return { iterative: major > 0 || minor >= 8 };
    })().catch((e) => {
      ready = null;
      throw e;
    }));

  async function embedRows(tenantId: string, rows: { id: string; text: string }[]) {
    let tokens = 0;
    let embedded = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const r = await embeddings.embed(batch.map((b) => b.text), 'document');
      tokens += r.tokens;
      await database.withTenant(tenantId, async (tx) => {
        for (const [j, row] of batch.entries()) {
          await sql`UPDATE doc_chunk SET embedding = ${vec(r.vectors[j]!)}::vector, embedding_model = ${embeddings.model} WHERE id = ${row.id} AND tenant_id = ${tenantId}`.execute(tx);
        }
      });
      embedded += batch.length;
    }
    return { embedded, tokens };
  }

  const refreshCounts = (tenantId: string, sourceId: string) =>
    database.withTenant(tenantId, async (tx) => {
      const r = await sql<{ n: number; missing: number }>`SELECT count(*)::int AS n, count(*) FILTER (WHERE embedding IS NULL)::int AS missing FROM doc_chunk WHERE source_id = ${sourceId}`.execute(tx);
      await tx.updateTable('doc_source').set({ chunk_count: r.rows[0]!.n, unembedded: r.rows[0]!.missing, updated_at: new Date() }).where('id', '=', sourceId).execute();
      return r.rows[0]!;
    });

  return {
    async index(tenantId, sourceId, text) {
      await prepare();
      const chunks = chunkText(text);
      // Chunks first (full-text search works at once), embeddings after, outside any transaction.
      const rows = await database.withTenant(tenantId, async (tx) => {
        const src = await tx.selectFrom('doc_source').select(['id', 'kind', 'public']).where('id', '=', sourceId).executeTakeFirst();
        if (!src) return null;
        await tx.deleteFrom('doc_chunk').where('source_id', '=', sourceId).where('tenant_id', '=', tenantId).execute();
        const values = chunks.map((c, seq) => ({ id: newId(), tenant_id: tenantId, source_id: sourceId, kind: src.kind, public: src.public, seq, text: c }));
        for (let i = 0; i < values.length; i += 200) await tx.insertInto('doc_chunk').values(values.slice(i, i + 200)).execute();
        return values.map((v) => ({ id: v.id, text: v.text }));
      });
      if (!rows) return { chunks: 0, embedded: 0, tokens: 0 };
      await refreshCounts(tenantId, sourceId);
      const r = await embedRows(tenantId, rows);
      await refreshCounts(tenantId, sourceId);
      return { chunks: rows.length, ...r };
    },

    async embedPending(tenantId, sourceId) {
      await prepare();
      const rows = await database.withTenant(tenantId, (tx) =>
        tx.selectFrom('doc_chunk').select(['id', 'text']).where('source_id', '=', sourceId).where((eb) => eb.or([eb('embedding', 'is', null), eb('embedding_model', '<>', embeddings.model)])).orderBy('seq').limit(BATCH * 8).execute(),
      );
      const r = rows.length ? await embedRows(tenantId, rows as { id: string; text: string }[]) : { embedded: 0, tokens: 0 };
      const counts = await refreshCounts(tenantId, sourceId);
      return { ...r, remaining: counts.missing };
    },

    async retrieve(tenantId, query, k, opts = {}) {
      const { iterative } = await prepare();
      const limit = Math.min(Math.max(k, 1), 20);
      const terms = [...new Set(words(query))].slice(0, 24);
      // Without embeddings (outage, rate limit) the full-text half still answers.
      let qvec: string | null = null;
      let tokens = 0;
      try {
        const e = await embeddings.embed([query], 'query');
        qvec = vec(e.vectors[0]!);
        tokens = e.tokens;
      } catch (e) {
        log('retriever: embedding the query failed; answering from full text only', e);
        qvec = null;
      }
      const kinds = opts.kinds?.length ? opts.kinds : ['document', 'help', 'record'];
      const tsq = terms.join(' | ');
      const publicOnly = opts.publicOnly === true;
      const hits = await database.withTenant(tenantId, async (tx) => {
        if (qvec && iterative) {
          await sql`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`.execute(tx);
          await sql`SET LOCAL hnsw.ef_search = 100`.execute(tx);
        }
        // pgvector < 0.8 filters after the index scan, which can starve a small tenant of
        // results; `+ 0` keeps the planner off the index so the scan is exact.
        const dist = iterative ? sql`c.embedding <=> ${qvec}::vector` : sql`(c.embedding <=> ${qvec}::vector) + 0`;
        const r = await sql<{ id: string; source_id: string; title: string; kind: RetrievedChunk['kind']; ref_type: string | null; ref_id: string | null; text: string; score: number }>`
          WITH v AS (
            SELECT c.id, row_number() OVER (ORDER BY ${dist}) AS r
            FROM doc_chunk c
            WHERE ${qvec !== null} AND c.tenant_id = ${tenantId} AND c.embedding IS NOT NULL AND c.kind = ANY(${kinds}) AND (c.public OR NOT ${publicOnly})
            ORDER BY ${dist}
            LIMIT 40
          ), f AS (
            SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC, c.id) AS r
            FROM doc_chunk c, to_tsquery('simple', ${tsq || 'zzzzzzzz'}) q
            WHERE ${terms.length > 0} AND c.tenant_id = ${tenantId} AND c.tsv @@ q AND c.kind = ANY(${kinds}) AND (c.public OR NOT ${publicOnly})
            ORDER BY ts_rank_cd(c.tsv, q) DESC, c.id
            LIMIT 40
          )
          SELECT c.id, c.source_id, s.title, c.kind, s.ref_type, s.ref_id, c.text,
                 (coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + f.r), 0))::float8 AS score
          FROM (SELECT id FROM v UNION SELECT id FROM f) u
          JOIN doc_chunk c ON c.id = u.id
          JOIN doc_source s ON s.id = c.source_id
          LEFT JOIN v ON v.id = c.id
          LEFT JOIN f ON f.id = c.id
          WHERE c.tenant_id = ${tenantId}
          ORDER BY score DESC, c.id
          LIMIT ${limit}`.execute(tx);
        return r.rows;
      });
      return { hits: hits.map((h) => ({ id: h.id, sourceId: h.source_id, title: h.title, kind: h.kind, ref: h.ref_type && h.ref_id ? { type: h.ref_type, id: h.ref_id } : null, text: h.text, score: Number(h.score) })), tokens };
    },
  };
}
