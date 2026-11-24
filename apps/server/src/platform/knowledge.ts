import { createHash } from 'node:crypto';
import { action, authorize, CommandError, customResource, type Principal } from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../db/database.ts';
import type { Consumer, RetrievedChunk } from '../ports/index.ts';
import { addUsage } from './assistant/usage.ts';
import type { Platform } from './context.ts';
import { publishedDefinition } from './datastudio.ts';
import { BOT_PACKAGE, packageEnabled, planLimit } from './packages.ts';
import { QUEUES } from './queues.ts';
import { recordChange } from './record.ts';
import { hiddenForPrincipal } from './records.ts';

/**
 * Knowledge the assistant and bots can quote: help articles (text kept here), tenant
 * documents (text files in the Files port) and custom records. Sources are chunked and
 * embedded by a job; every answer cites the chunks it used.
 */

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const RESOURCE = 'platform::KnowledgeSource';

export interface SourceInput {
  kind: 'help' | 'document';
  title: string;
  public: boolean;
  body?: string | undefined;
  file_id?: string | undefined;
}

export async function createSource(p: Platform, tx: Tx, tenantId: string, actor: Principal, input: SourceInput, correlationId: string) {
  const limit = await planLimit(p, tx, 'knowledge_sources');
  const count = await tx.selectFrom('doc_source').select(sql<number>`count(*)::int`.as('n')).where('kind', '<>', 'record').executeTakeFirstOrThrow();
  if (count.n >= limit) throw new CommandError(409, 'plan_limit', `your plan allows ${limit} documents and help articles`);
  if (input.kind === 'help' && !input.body?.trim()) throw new CommandError(422, 'invalid_input', 'a help article needs text');
  if (input.kind === 'document' && !input.file_id) throw new CommandError(422, 'invalid_input', 'a document needs a file');
  const id = newId();
  await tx.insertInto('doc_source').values({ id, tenant_id: tenantId, kind: input.kind, title: input.title, public: input.public, body: input.kind === 'help' ? input.body! : null, file_id: input.file_id ?? null, created_by: actor.id }).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:knowledge.source_added', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: 'knowledge.source_added', data: { source_id: id, kind: input.kind, public: input.public } }] });
  return { id };
}

export async function updateSource(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, patch: { title?: string | undefined; public?: boolean | undefined; body?: string | undefined }, correlationId: string) {
  const s = await tx.selectFrom('doc_source').selectAll().where('id', '=', id).executeTakeFirst();
  if (!s || s.kind === 'record') throw new CommandError(404, 'not_found', 'source not found');
  const set: Record<string, unknown> = { updated_at: new Date(), version: sql`version + 1` };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.public !== undefined) set.public = patch.public;
  const reindex = s.kind === 'help' && patch.body !== undefined && patch.body !== s.body;
  if (reindex) Object.assign(set, { body: patch.body, status: 'pending', attempts: 0 });
  await tx.updateTable('doc_source').set(set).where('id', '=', id).execute();
  if (patch.public !== undefined) await tx.updateTable('doc_chunk').set({ public: patch.public }).where('source_id', '=', id).where('tenant_id', '=', tenantId).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:knowledge.source_updated', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: 'knowledge.source_updated', data: { source_id: id, reindex } }] });
  return { reindex };
}

export async function deleteSource(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, correlationId: string) {
  const s = await tx.deleteFrom('doc_source').where('id', '=', id).where('tenant_id', '=', tenantId).where('kind', '<>', 'record').returning(['id', 'file_id']).executeTakeFirst();
  if (!s) throw new CommandError(404, 'not_found', 'source not found');
  await recordChange(p, tx, { tenantId, actor, action: 'platform:knowledge.source_removed', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: 'knowledge.source_removed', data: { source_id: id } }] });
  return { fileId: s.file_id as string | null };
}

export const listSources = (tx: Tx) =>
  tx.selectFrom('doc_source').select(['id', 'kind', 'title', 'public', 'status', 'chunk_count', 'unembedded', 'error', 'version', 'created_at', 'updated_at']).where('kind', '<>', 'record').orderBy('created_at', 'desc').limit(500).execute();

export const enqueueIndex = (p: Platform, tenantId: string, sourceId: string, delaySeconds = 0) =>
  p.ports.jobs.send(QUEUES.knowledgeIndex, { tenantId, sourceId }, delaySeconds ? { startAfter: delaySeconds } : {});

/** Reads a stored text document, refusing anything over the cap instead of holding it. */
async function fileText(p: Platform, tenantId: string, fileId: string): Promise<string | null> {
  const f = await p.ports.files.open(tenantId, fileId);
  if (!f) return null;
  if (f.size > MAX_DOCUMENT_BYTES) {
    f.stream.destroy();
    throw new Error(`the document is larger than ${MAX_DOCUMENT_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  for await (const c of f.stream) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Text of a custom record for retrieval: only fields every role may read and that are not
 * PII, so a chunk can never reveal a value its reader could not see on the record itself.
 */
async function recordText(tx: Tx, refType: string, refId: string): Promise<{ title: string; text: string } | null> {
  const { definition } = await publishedDefinition(tx);
  const entity = definition.entities.find((e) => customResource(e.key) === refType);
  if (!entity) return null;
  const row = await tx.selectFrom('custom_record').select('data').where('id', '=', refId).where('entity', '=', entity.key).executeTakeFirst();
  if (!row) return null;
  const restricted = new Set(definition.field_access.filter((a) => a.target === `custom:${entity.key}` && a.access !== 'write').map((a) => a.field));
  const data = row.data as Record<string, unknown>;
  const lines: string[] = [];
  for (const f of entity.fields) {
    if (f.pii || f.formula || restricted.has(f.key) || f.type === 'link') continue;
    const v = data[f.key];
    if (v === null || v === undefined || v === '') continue;
    lines.push(`${f.label}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  const titleField = entity.fields.find((f) => f.key === entity.title_field);
  const titleValue = titleField && !titleField.pii && !restricted.has(titleField.key) ? data[entity.title_field] : null;
  return { title: `${entity.label}: ${titleValue ?? refId.slice(0, 8)}`, text: lines.join('\n') };
}

/** Job: (re)index one source. Embedding failures leave the chunks searchable by text and are retried by the sweep. */
export async function indexSource(p: Platform, job: { tenantId: string; sourceId: string }) {
  const { tenantId, sourceId } = job;
  const src = await p.database.withTenant(tenantId, (tx) => tx.selectFrom('doc_source').selectAll().where('id', '=', sourceId).executeTakeFirst());
  if (!src) return;
  const fail = (error: string) => p.database.withTenant(tenantId, (tx) => tx.updateTable('doc_source').set({ status: 'failed', error: error.slice(0, 500), attempts: sql`attempts + 1`, updated_at: new Date() }).where('id', '=', sourceId).execute());
  let text: string | null;
  let title = src.title as string;
  try {
    if (src.kind === 'help') text = src.body as string;
    else if (src.kind === 'document') text = src.file_id ? await fileText(p, tenantId, src.file_id) : null;
    else {
      const r = await p.database.withTenant(tenantId, (tx) => recordText(tx, src.ref_type, src.ref_id));
      text = r?.text ?? null;
      if (r) title = r.title;
    }
  } catch (e) {
    await fail((e as Error).message);
    return;
  }
  if (text === null) {
    if (src.kind === 'record') await p.database.withTenant(tenantId, (tx) => tx.deleteFrom('doc_source').where('id', '=', sourceId).where('tenant_id', '=', tenantId).execute());
    else await fail('the source text is no longer available');
    return;
  }
  const hash = createHash('sha256').update(text).digest('hex');
  let tokens = 0;
  let error: string | null = null;
  try {
    if (src.content_hash !== hash || src.status !== 'indexed') tokens = (await p.ports.retriever.index(tenantId, sourceId, text)).tokens;
    else tokens = (await p.ports.retriever.embedPending(tenantId, sourceId)).tokens;
  } catch (e) {
    // Chunks are stored before embedding, so full-text search already answers.
    error = `embeddings pending: ${(e as Error).message}`.slice(0, 500);
    p.log.warn({ source: sourceId, err: String(e) }, 'knowledge: embedding failed; the sweep will retry');
  }
  await p.database.withTenant(tenantId, async (tx) => {
    await tx.updateTable('doc_source').set({ status: 'indexed', title, content_hash: hash, error, attempts: error ? sql`attempts + 1` : 0, updated_at: new Date() }).where('id', '=', sourceId).execute();
    await addUsage(tx, tenantId, { embedTokens: tokens });
  });
}

/** Scheduled sweep: sources stuck pending or with chunks still waiting for embeddings. */
export async function indexPending(p: Platform, limit = 50) {
  const due = await p.database.withoutTenant((tx) => sql<{ tenant_id: string; id: string }>`SELECT tenant_id, id FROM doc_sources_pending(${limit})`.execute(tx));
  for (const d of due.rows) {
    await indexSource(p, { tenantId: d.tenant_id, sourceId: d.id }).catch((e: unknown) => p.log.error({ err: String(e), source: d.id }, 'knowledge: indexing failed'));
  }
  return due.rows.length;
}

/** Keeps record sources in step with custom records (only while the Bot package is in the plan). */
export function knowledgeRecordsConsumer(p: Platform): Consumer {
  return {
    name: 'platform.knowledge_records',
    types: ['record.created', 'record.updated', 'record.deleted'],
    async handle(event, tx) {
      if (!(await packageEnabled(p, tx, BOT_PACKAGE))) return 'skipped';
      const entity = String(event.data.entity ?? '');
      const recordId = String(event.data.record_id ?? '');
      if (!entity || !recordId) return;
      const refType = customResource(entity);
      if (event.type === 'record.deleted') {
        await tx.deleteFrom('doc_source').where('tenant_id', '=', event.tenant_id).where('ref_type', '=', refType).where('ref_id', '=', recordId).execute();
        return;
      }
      const existing = await tx.selectFrom('doc_source').select('id').where('ref_type', '=', refType).where('ref_id', '=', recordId).executeTakeFirst();
      const id = existing?.id ?? newId();
      if (existing) await tx.updateTable('doc_source').set({ status: 'pending', attempts: 0, updated_at: new Date() }).where('id', '=', id).execute();
      else await tx.insertInto('doc_source').values({ id, tenant_id: event.tenant_id, kind: 'record', title: `${entity} ${recordId.slice(0, 8)}`, ref_type: refType, ref_id: recordId, created_by: 'system' }).execute();
      // After this transaction commits; the sweep covers a lost job.
      await enqueueIndex(p, event.tenant_id, id, 1);
    },
  };
}

export interface Passage {
  n: number;
  chunk_id: string;
  source_id: string;
  title: string;
  kind: RetrievedChunk['kind'];
  ref: RetrievedChunk['ref'];
  text: string;
}

/**
 * Retrieval for one reader. Customers (bots) only ever get public documents and help
 * articles; staff get everything, and record chunks only with `platform:records.read`.
 */
export async function searchKnowledge(p: Platform, tenantId: string, reader: { audience: 'customer' } | { audience: 'staff'; principal: Principal }, query: string, k = 5): Promise<Passage[]> {
  const kinds: RetrievedChunk['kind'][] = ['help', 'document'];
  if (reader.audience === 'staff' && authorize(reader.principal, action('platform:records.read'), { type: 'platform::Tenant', id: tenantId, tenantId }).decision === 'allow') kinds.push('record');
  const r = await p.ports.retriever.retrieve(tenantId, query, k + (kinds.includes('record') ? 5 : 0), { kinds, publicOnly: reader.audience === 'customer' });
  if (r.tokens) await p.database.withTenant(tenantId, (tx) => addUsage(tx, tenantId, { embedTokens: r.tokens }));
  let hits = r.hits;
  if (reader.audience === 'staff' && hits.some((h) => h.kind === 'record')) {
    // Field rules: a role that has any field of an entity hidden (by its own rules or by
    // Data studio's) gets no record passages of that entity at all, rather than a passage
    // that might hold the hidden value.
    const principal = reader.principal;
    const blocked = await p.database.withTenant(tenantId, async (tx) => {
      const { definition } = await publishedDefinition(tx);
      const out = new Set<string>();
      for (const e of definition.entities) {
        const d = authorize(principal, action('platform:records.read'), { type: customResource(e.key), id: '*', tenantId });
        if (d.decision === 'deny' || hiddenForPrincipal(principal, definition, e, d).size > 0) out.add(customResource(e.key));
      }
      return out;
    });
    hits = hits.filter((h) => h.kind !== 'record' || (h.ref !== null && !blocked.has(h.ref.type)));
  }
  return hits.slice(0, k).map((h, i) => ({ n: i + 1, chunk_id: h.id, source_id: h.sourceId, title: h.title, kind: h.kind, ref: h.ref, text: h.text }));
}
