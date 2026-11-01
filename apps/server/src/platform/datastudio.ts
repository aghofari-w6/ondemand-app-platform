import { createHash } from 'node:crypto';
import {
  CommandError,
  customResource,
  Definition,
  emptyDefinition,
  ROLE_PRESETS,
  validateDefinition,
  type DefinitionContext,
  type FieldDef,
  type Principal,
} from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../db/database.ts';
import type { Platform } from './context.ts';
import { QUEUES } from './queues.ts';
import { recordChange } from './record.ts';

/**
 * Data studio: versioned metadata. One draft per tenant; publishing validates it,
 * computes an impact summary against the published version, swaps the runtime
 * projections (field_definition, field_access_rule) in the same transaction, and
 * queues backfills and index builds. Rollback re-publishes an earlier version as a
 * new version, so history only ever grows.
 */

export interface Target {
  /** `<app>:<entity>` or `custom:<entity>` */
  id: string;
  table: string;
  column: 'custom' | 'data';
  /** extra predicate for custom records */
  entity?: string;
  resource: string;
}

const COMMON_COLUMNS = ['id', 'version', 'created_at', 'updated_at', 'custom'];

export function definitionContext(p: Platform, tx: Tx, plan: string): Promise<DefinitionContext> {
  return (async () => {
    const appEntities: Record<string, string[]> = {};
    const allAppEntities: Record<string, string[]> = {};
    for (const m of p.catalog.manifests()) {
      for (const e of m.entities) {
        const keys = [...e.fields.map((f) => f.key), ...COMMON_COLUMNS];
        allAppEntities[`${m.id}:${e.name}`] = keys;
        if (e.custom_fields) appEntities[`${m.id}:${e.name}`] = keys;
      }
    }
    const custom = await tx.selectFrom('custom_role').select('id').execute();
    const limits = p.ports.billing.plan(plan)?.limits ?? { custom_entities: 0, custom_fields: 0 };
    return { appEntities, allAppEntities, roles: [...ROLE_PRESETS, ...custom.map((r) => r.id as string)], limits };
  })();
}

export function targetFor(p: Platform, id: string): Target | null {
  const [scope, name] = id.split(':') as [string, string];
  if (scope === 'custom') return { id, table: 'custom_record', column: 'data', entity: name, resource: customResource(name) };
  const e = p.catalog.entity(scope, name);
  return e ? { id, table: e.table, column: 'custom', resource: e.resource } : null;
}

/** The published definition, or one synthesized from Milestone A field definitions. */
export async function publishedDefinition(tx: Tx): Promise<{ number: number; definition: Definition }> {
  const pub = await tx.selectFrom('metadata_version').select(['number', 'definition']).where('status', '=', 'published').executeTakeFirst();
  if (pub) return { number: pub.number, definition: Definition.parse(pub.definition) };
  const rows = await tx.selectFrom('field_definition').selectAll().orderBy('created_at').execute();
  const def = emptyDefinition();
  for (const r of rows) {
    let set = def.app_fields.find((s) => s.app === r.app && s.entity === r.entity);
    if (!set) def.app_fields.push((set = { app: r.app, entity: r.entity, fields: [] }));
    set.fields.push({ key: r.key, label: r.label, type: r.type, options: r.options ?? [], required: r.required, pii: r.pii ?? false, indexed: r.indexed ?? false, default: r.default_value ?? null });
  }
  return { number: 0, definition: def };
}

export async function getDraft(tx: Tx) {
  return tx.selectFrom('metadata_version').selectAll().where('status', '=', 'draft').executeTakeFirst();
}

export async function openDraft(p: Platform, tx: Tx, tenantId: string, actor: Principal, correlationId: string) {
  const existing = await getDraft(tx);
  if (existing) return existing;
  const pub = await publishedDefinition(tx);
  const max = await tx.selectFrom('metadata_version').select(sql<number>`coalesce(max(number), 0)`.as('n')).executeTakeFirstOrThrow();
  const row = await tx
    .insertInto('metadata_version')
    .values({ id: newId(), tenant_id: tenantId, number: Number(max.n) + 1, status: 'draft', definition: JSON.stringify(pub.definition), based_on: pub.number || null, created_by: actor.id })
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:metadata.draft_opened', resourceType: 'platform::Metadata', resourceId: String(row.number), correlationId });
  return row;
}

export async function saveDraft(p: Platform, tx: Tx, tenantId: string, actor: Principal, raw: unknown, expectedVersion: number, note: string | undefined, correlationId: string) {
  const parsed = Definition.safeParse(raw);
  if (!parsed.success) throw new CommandError(422, 'invalid_definition', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const draft = await openDraft(p, tx, tenantId, actor, correlationId);
  const row = await tx
    .updateTable('metadata_version')
    .set({ definition: JSON.stringify(parsed.data), version: sql`version + 1`, ...(note !== undefined ? { note } : {}) })
    .where('id', '=', draft.id)
    .where('version', '=', expectedVersion)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new CommandError(409, 'version_conflict', `the draft changed (expected version ${expectedVersion}, current ${draft.version})`);
  return row;
}

// ------------------------------------------------------------------ impact

export interface Impact {
  changes: { target: string; change: string; detail: string; records?: number }[];
  backfills: { target: string; field: string; kind: 'encrypt' | 'decrypt' | 'set_default'; records: number }[];
  indexes: { target: string; field: string; op: 'create' | 'drop' }[];
  blocking: string[];
  warnings: string[];
}

type FieldMap = Map<string, Map<string, FieldDef>>;
const fieldMap = (d: Definition): FieldMap => {
  const m: FieldMap = new Map();
  for (const s of d.app_fields) m.set(`${s.app}:${s.entity}`, new Map(s.fields.map((f) => [f.key, f])));
  for (const e of d.entities) m.set(`custom:${e.key}`, new Map(e.fields.map((f) => [f.key, f])));
  return m;
};

async function countWhere(tx: Tx, t: Target, predicate: ReturnType<typeof sql>): Promise<number> {
  const base = sql`SELECT count(*)::int AS n FROM ${sql.table(t.table)} WHERE ${predicate}`;
  const q = t.entity ? sql<{ n: number }>`${base} AND entity = ${t.entity}` : sql<{ n: number }>`${base}`;
  return (await q.execute(tx)).rows[0]!.n;
}

const typeMismatch = (col: string, f: FieldDef) => {
  const v = sql`${sql.ref(col)} -> ${f.key}`;
  switch (f.type) {
    case 'number':
      return sql`jsonb_typeof(${v}) NOT IN ('number', 'null')`;
    case 'boolean':
      return sql`jsonb_typeof(${v}) NOT IN ('boolean', 'null')`;
    case 'select':
      return sql`(${v}) IS NOT NULL AND jsonb_typeof(${v}) <> 'null' AND NOT ((${sql.ref(col)} ->> ${f.key}) = ANY(${f.options}::text[]))`;
    default:
      return sql`jsonb_typeof(${v}) NOT IN ('string', 'null')`;
  }
};

export async function computeImpact(p: Platform, tx: Tx, from: Definition, to: Definition): Promise<Impact> {
  const impact: Impact = { changes: [], backfills: [], indexes: [], blocking: [], warnings: [] };
  const before = fieldMap(from);
  const after = fieldMap(to);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const t = targetFor(p, id);
    if (!t) continue;
    const a = before.get(id) ?? new Map<string, FieldDef>();
    const b = after.get(id) ?? new Map<string, FieldDef>();
    const total = await countWhere(tx, t, sql`true`);
    if (id.startsWith('custom:') && !before.has(id)) impact.changes.push({ target: id, change: 'entity added', detail: to.entities.find((e) => `custom:${e.key}` === id)!.label });
    if (id.startsWith('custom:') && !after.has(id)) {
      impact.changes.push({ target: id, change: 'entity removed', detail: 'records are kept and hidden; rolling back restores them', records: total });
      if (total) impact.warnings.push(`${id}: ${total} record(s) will be hidden`);
      continue;
    }
    for (const [k, f] of b) {
      const old = a.get(k);
      const missing = () => countWhere(tx, t, sql`NOT (${sql.ref(t.column)} ? ${k}) OR ${sql.ref(t.column)} -> ${k} = 'null'::jsonb`);
      const present = () => countWhere(tx, t, sql`${sql.ref(t.column)} ? ${k}`);
      if (!old) {
        impact.changes.push({ target: id, change: 'field added', detail: `${f.label} (${f.type}${f.pii ? ', PII' : ''}${f.formula ? ', formula' : ''})` });
        if (f.default !== null && !f.formula && total) impact.backfills.push({ target: id, field: k, kind: 'set_default', records: total });
        else if (f.required && !f.formula && total) impact.blocking.push(`${id}.${k}: required field added without a default; ${total} existing record(s) would be invalid`);
        if (f.indexed) impact.indexes.push({ target: id, field: k, op: 'create' });
        continue;
      }
      if (old.type !== f.type || (f.type === 'select' && old.options.some((o) => !f.options.includes(o)))) {
        const bad = old.pii ? 0 : await countWhere(tx, t, typeMismatch(t.column, f));
        impact.changes.push({ target: id, change: 'field type changed', detail: `${old.type} → ${f.type}`, records: bad });
        if (bad) impact.blocking.push(`${id}.${k}: ${bad} record(s) hold values that are not valid ${f.type}${f.type === 'select' ? ` (${f.options.join(', ')})` : ''}`);
      }
      if (!old.required && f.required && !f.formula) {
        const n = await missing();
        if (n && f.default === null) impact.blocking.push(`${id}.${k}: now required but ${n} record(s) have no value; set a default`);
        if (n && f.default !== null) impact.backfills.push({ target: id, field: k, kind: 'set_default', records: n });
      }
      if (!old.pii && f.pii) {
        const n = await present();
        impact.changes.push({ target: id, change: 'marked PII', detail: `${f.label} will be encrypted at rest`, records: n });
        if (n) impact.backfills.push({ target: id, field: k, kind: 'encrypt', records: n });
      }
      if (old.pii && !f.pii) {
        const n = await present();
        impact.changes.push({ target: id, change: 'PII removed', detail: `${f.label} will be stored in clear text`, records: n });
        if (n) impact.backfills.push({ target: id, field: k, kind: 'decrypt', records: n });
      }
      if (!old.indexed && f.indexed) impact.indexes.push({ target: id, field: k, op: 'create' });
      if (old.indexed && !f.indexed) impact.indexes.push({ target: id, field: k, op: 'drop' });
      if (old.label !== f.label) impact.changes.push({ target: id, change: 'field renamed', detail: `${old.label} → ${f.label}` });
      if ((old.formula ?? '') !== (f.formula ?? '')) impact.changes.push({ target: id, change: 'formula changed', detail: f.formula ?? '(none)' });
    }
    for (const [k, f] of a) {
      if (b.has(k)) continue;
      const n = await countWhere(tx, t, sql`${sql.ref(t.column)} ? ${k}`);
      impact.changes.push({ target: id, change: 'field removed', detail: `${f.label}: values are kept and hidden`, records: n });
      if (f.indexed) impact.indexes.push({ target: id, field: k, op: 'drop' });
    }
  }
  const ruleKey = (d: Definition) => new Map(d.entities.map((e) => [e.key, JSON.stringify([e.rules, e.rollups, e.title_field])]));
  const ra = ruleKey(from);
  for (const [k, v] of ruleKey(to)) if (ra.has(k) && ra.get(k) !== v) impact.changes.push({ target: `custom:${k}`, change: 'rules, rollups or title changed', detail: 'applies to new writes' });
  if (JSON.stringify(from.layouts) !== JSON.stringify(to.layouts)) impact.changes.push({ target: '*', change: 'layouts changed', detail: `${to.layouts.length} layout(s)` });
  if (JSON.stringify(from.field_access) !== JSON.stringify(to.field_access)) impact.changes.push({ target: '*', change: 'field access changed', detail: `${to.field_access.length} rule(s); takes effect on next request` });
  return impact;
}

// ------------------------------------------------------------------ publish / rollback

export const indexName = (tenantId: string, target: string, field: string) => `cfx_${createHash('sha256').update(`${tenantId}|${target}|${field}`).digest('hex').slice(0, 24)}`;

async function applyProjections(p: Platform, tx: Tx, tenantId: string, def: Definition, number: number) {
  await tx.deleteFrom('field_definition').where('tenant_id', '=', tenantId).execute();
  const rows = def.app_fields.flatMap((s) =>
    s.fields.map((f) => ({
      id: newId(),
      tenant_id: tenantId,
      app: s.app,
      entity: s.entity,
      key: f.key,
      label: f.label,
      type: f.type,
      options: f.options,
      required: f.required,
      pii: f.pii,
      indexed: f.indexed,
      default_value: f.default === null ? null : JSON.stringify(f.default),
      metadata_number: number,
    })),
  );
  if (rows.length) await tx.insertInto('field_definition').values(rows).execute();
  await tx.deleteFrom('field_access_rule').where('tenant_id', '=', tenantId).execute();
  const access = def.field_access.map((a) => ({ tenant_id: tenantId, role: a.role, resource: targetFor(p, a.target)!.resource, field: a.field, access: a.access }));
  if (access.length) await tx.insertInto('field_access_rule').values(access).onConflict((oc) => oc.doNothing()).execute();
}

async function plan(tx: Tx) {
  return (await tx.selectFrom('tenant').select('plan').executeTakeFirstOrThrow()).plan as string;
}

export async function validateForPublish(p: Platform, tx: Tx, def: Definition) {
  const problems = validateDefinition(def, await definitionContext(p, tx, await plan(tx)));
  if (problems.length) throw Object.assign(new CommandError(422, 'invalid_definition', problems.join('; ')), { details: { problems } });
}

/** Publishes `def` as version `number` (the draft's number, or a fresh one for rollback). */
async function publishDefinition(p: Platform, tx: Tx, tenantId: string, actor: Principal, def: Definition, number: number, draftId: string | null, correlationId: string, rollbackOf?: number) {
  await validateForPublish(p, tx, def);
  const current = await publishedDefinition(tx);
  const impact = await computeImpact(p, tx, current.definition, def);
  if (impact.blocking.length) throw Object.assign(new CommandError(409, 'publish_blocked', impact.blocking.join('; ')), { details: { impact } });

  await tx.updateTable('metadata_version').set({ status: 'superseded' }).where('status', '=', 'published').execute();
  if (draftId) {
    await tx.updateTable('metadata_version').set({ status: 'published', impact: JSON.stringify(impact), published_by: actor.id, published_at: new Date(), definition: JSON.stringify(def), version: sql`version + 1` }).where('id', '=', draftId).execute();
  } else {
    await tx
      .insertInto('metadata_version')
      .values({ id: newId(), tenant_id: tenantId, number, status: 'published', definition: JSON.stringify(def), based_on: rollbackOf ?? current.number, note: `rollback to version ${rollbackOf}`, impact: JSON.stringify(impact), created_by: actor.id, published_by: actor.id, published_at: new Date() })
      .execute();
  }
  await applyProjections(p, tx, tenantId, def, number);

  const jobs: { queue: string; data: object }[] = [];
  for (const b of impact.backfills) {
    const id = newId();
    await tx.insertInto('backfill_run').values({ id, tenant_id: tenantId, metadata_number: number, target: b.target, field: b.field, kind: b.kind }).execute();
    jobs.push({ queue: QUEUES.backfill, data: { tenantId, runId: id } });
  }
  for (const ix of impact.indexes) {
    const id = newId();
    await tx.insertInto('index_request').values({ id, tenant_id: tenantId, op: ix.op, target: ix.target, field: ix.field, index_name: indexName(tenantId, ix.target, ix.field) }).execute();
  }
  await recordChange(p, tx, {
    tenantId,
    actor,
    action: rollbackOf ? 'platform:metadata.rolled_back' : 'platform:metadata.published',
    resourceType: 'platform::Metadata',
    resourceId: String(number),
    correlationId,
    events: [{ type: rollbackOf ? 'metadata.rolled_back' : 'metadata.published', data: { number, rollback_of: rollbackOf ?? null, changes: impact.changes.length, backfills: impact.backfills.length, indexes: impact.indexes.length } }],
  });
  return { number, impact, jobs };
}

export async function publishDraft(p: Platform, tx: Tx, tenantId: string, actor: Principal, expectedVersion: number, correlationId: string) {
  const draft = await getDraft(tx);
  if (!draft) throw new CommandError(404, 'no_draft', 'there is no draft to publish');
  if (draft.version !== expectedVersion) throw new CommandError(409, 'version_conflict', `the draft changed (expected version ${expectedVersion}, current ${draft.version})`);
  return publishDefinition(p, tx, tenantId, actor, Definition.parse(draft.definition), draft.number, draft.id, correlationId);
}

export async function rollbackTo(p: Platform, tx: Tx, tenantId: string, actor: Principal, number: number, correlationId: string) {
  if (await getDraft(tx)) throw new CommandError(409, 'draft_open', 'publish or discard the open draft before rolling back');
  const target = await tx.selectFrom('metadata_version').select(['definition', 'status']).where('number', '=', number).executeTakeFirst();
  if (!target || target.status === 'draft' || target.status === 'discarded') throw new CommandError(404, 'not_found', `version ${number} cannot be restored`);
  if (target.status === 'published') throw new CommandError(409, 'already_published', `version ${number} is already published`);
  const max = await tx.selectFrom('metadata_version').select(sql<number>`max(number)`.as('n')).executeTakeFirstOrThrow();
  return publishDefinition(p, tx, tenantId, actor, Definition.parse(target.definition), Number(max.n) + 1, null, correlationId, number);
}

export async function discardDraft(p: Platform, tx: Tx, tenantId: string, actor: Principal, correlationId: string) {
  const draft = await getDraft(tx);
  if (!draft) throw new CommandError(404, 'no_draft', 'there is no draft');
  await tx.updateTable('metadata_version').set({ status: 'discarded' }).where('id', '=', draft.id).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:metadata.draft_discarded', resourceType: 'platform::Metadata', resourceId: String(draft.number), correlationId });
}

export async function sendJobs(p: Platform, jobs: { queue: string; data: object }[]) {
  for (const j of jobs) await p.ports.jobs.send(j.queue, j.data);
}

// ------------------------------------------------------------------ helpers for runtime readers

export async function customEntity(tx: Tx, key: string) {
  const { definition } = await publishedDefinition(tx);
  return { definition, entity: definition.entities.find((e) => e.key === key) ?? null };
}
