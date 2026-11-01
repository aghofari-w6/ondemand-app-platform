import { createHash } from 'node:crypto';
import { action, authorize, CommandError, customResource, expr, readonlyFields, type CustomEntity, type Decision, type Definition, type EventOrigin, type Principal } from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../db/database.ts';
import { assertWritableTenant } from './commands.ts';
import type { Platform } from './context.ts';
import { publishedDefinition } from './datastudio.ts';
import { decryptAll, encryptPii, validateCustomValues, type FieldDefinition } from './fields.ts';
import { assertIdempotencyKey, claimIdempotencyKey, storeIdempotentResponse } from './idempotency.ts';
import { writeAudit } from './audit.ts';
import { writeOutbox } from './outbox.ts';

/**
 * Custom entity records. Shape comes from the published Data studio version; writes
 * follow the same contract as app commands (authorize, Idempotency-Key, version check,
 * outbox + audit in one transaction). Formulas and rollups are computed on read; rules
 * are evaluated on every write with the expression language.
 */

export const recordTarget = (entity: string) => `custom:${entity}`;

export async function loadEntity(tx: Tx, key: string): Promise<{ definition: Definition; entity: CustomEntity }> {
  const { definition } = await publishedDefinition(tx);
  const entity = definition.entities.find((e) => e.key === key);
  if (!entity) throw new CommandError(404, 'unknown_entity', `unknown custom entity ${key}`);
  return { definition, entity };
}

export function authorizeRecords(principal: Principal, entity: string, mode: 'read' | 'write', id = '*'): Decision {
  const perm = mode === 'read' ? 'platform:records.read' : 'platform:records.write';
  const d = authorize(principal, action(perm), { type: customResource(entity), id, tenantId: principal.tenantId });
  if (d.decision === 'deny') throw new CommandError(403, 'forbidden', `missing permission ${perm}`);
  return d;
}

const asDefs = (e: CustomEntity): FieldDefinition[] => e.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, required: f.required, pii: f.pii, formula: f.formula }));

// ------------------------------------------------------------------ computed values

export async function rollupsFor(tx: Tx, def: Definition, entity: CustomEntity, ids: string[]): Promise<Map<string, Record<string, number | null>>> {
  const out = new Map<string, Record<string, number | null>>(ids.map((id) => [id, {}]));
  if (!ids.length) return out;
  for (const r of entity.rollups) {
    const child = def.entities.find((e) => e.key === r.from);
    if (!child) continue;
    const agg =
      r.aggregate === 'count'
        ? sql<number>`count(*)`
        : sql<number>`${sql.raw(r.aggregate)}((data ->> ${r.field!})::numeric)`;
    const rows = await sql<{ parent: string; v: number | null }>`
      SELECT data ->> ${r.via} AS parent, ${agg} AS v FROM custom_record
      WHERE entity = ${r.from} AND data ->> ${r.via} = ANY(${ids}::text[]) GROUP BY 1`.execute(tx);
    for (const id of ids) out.get(id)![r.key] = r.aggregate === 'count' ? 0 : null;
    for (const row of rows.rows) out.get(row.parent)![r.key] = row.v === null ? null : Number(row.v);
  }
  return out;
}

/** Formula values, in definition order (a formula may use earlier formulas). Errors yield null. */
export function computeFormulas(entity: CustomEntity, values: Record<string, unknown>): { values: Record<string, unknown>; errors: Record<string, string> } {
  const ctx: Record<string, unknown> = { ...values };
  const errors: Record<string, string> = {};
  for (const f of entity.fields.filter((x) => x.formula)) {
    try {
      ctx[f.key] = expr.evaluate(expr.parse(f.formula!), ctx, { maxSteps: 5000 });
    } catch (e) {
      ctx[f.key] = null;
      errors[f.key] = (e as Error).message;
    }
  }
  return { values: ctx, errors };
}

export function evaluateRules(entity: CustomEntity, values: Record<string, unknown>): string[] {
  const failed: string[] = [];
  for (const r of entity.rules) {
    try {
      if (r.when && !expr.truthy(expr.evaluate(expr.parse(r.when), values, { maxSteps: 5000 }))) continue;
      if (!expr.truthy(expr.evaluate(expr.parse(r.condition), values, { maxSteps: 5000 }))) failed.push(r.message);
    } catch (e) {
      failed.push(`${r.message} (${(e as Error).message})`);
    }
  }
  return failed;
}

function present(p: Platform, tenantId: string, entity: CustomEntity, row: any, rollups: Record<string, unknown>, decision: Decision) {
  const data = decryptAll(p.ports.vault, tenantId, recordTarget(entity.key), row.data);
  const { values, errors } = computeFormulas(entity, { ...data, ...rollups, id: row.id, created_at: new Date(row.created_at).toISOString() });
  const known = new Set([...entity.fields.map((f) => f.key), ...entity.rollups.map((r) => r.key)]);
  const shown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (known.has(k) && decision.fields[k] !== 'hidden') shown[k] = v;
  return { id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at, values: shown, title: shown[entity.title_field] ?? null, formula_errors: errors };
}

// ------------------------------------------------------------------ read

export interface RecordQuery {
  q?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
  filters: Record<string, string[]>;
}

export async function listRecords(p: Platform, tx: Tx, principal: Principal, key: string, q: RecordQuery) {
  const { definition, entity } = await loadEntity(tx, key);
  const decision = authorizeRecords(principal, key, 'read');
  const fields = new Map(entity.fields.map((f) => [f.key, f]));
  const facetable = entity.fields.filter((f) => (f.type === 'select' || f.type === 'boolean') && !f.pii && decision.fields[f.key] !== 'hidden');
  for (const k of Object.keys(q.filters)) if (!facetable.some((f) => f.key === k)) throw new CommandError(400, 'invalid_filter', `${k} is not filterable`);

  const sortSpec = q.sort ?? '-created_at';
  const desc = sortSpec.startsWith('-');
  const sortKey = sortSpec.replace(/^-/, '');
  const sf = fields.get(sortKey);
  if (sortKey !== 'created_at' && (!sf || sf.pii || sf.formula || sf.type === 'link' || decision.fields[sortKey] === 'hidden')) throw new CommandError(400, 'invalid_sort', `${sortKey} is not sortable`);
  const sortExpr = sortKey === 'created_at' ? sql`created_at` : sf!.type === 'number' ? sql`(data ->> ${sortKey})::numeric` : sql`(data ->> ${sortKey})`;
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 200);

  const where = (except?: string) => {
    const parts = [sql`entity = ${key}`];
    for (const [k, vals] of Object.entries(q.filters)) if (k !== except && vals.length) parts.push(sql`(data ->> ${k}) = ANY(${vals}::text[])`);
    if (q.q?.trim()) parts.push(p.ports.search.match('search', q.q));
    return sql.join(parts, sql` AND `);
  };
  let cursorCond = sql`true`;
  if (q.cursor) {
    let c: { v: string | number | null; id: string };
    try {
      c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
    } catch {
      throw new CommandError(400, 'invalid_cursor', 'invalid cursor');
    }
    const cmp = sql.raw(desc ? '<' : '>');
    const v = sortKey === 'created_at' ? sql`${c.v}::timestamptz` : sf?.type === 'number' ? sql`${c.v}::numeric` : sql`${c.v}`;
    cursorCond = c.v === null ? sql`(${sortExpr} IS NULL AND id ${cmp} ${c.id})` : sql`((${sortExpr} ${cmp} ${v}) OR (${sortExpr} = ${v} AND id ${cmp} ${c.id}) OR ${sortExpr} IS NULL)`;
  }
  const dir = sql.raw(desc ? 'DESC' : 'ASC');
  const rows = (await sql<any>`SELECT * FROM custom_record WHERE ${where()} AND ${cursorCond} ORDER BY ${sortExpr} ${dir} NULLS LAST, id ${dir} LIMIT ${limit + 1}`.execute(tx)).rows;
  const page = rows.slice(0, limit);
  const rollups = await rollupsFor(tx, definition, entity, page.map((r) => r.id));
  const last = page[page.length - 1];
  const sortValue = (r: any) => (sortKey === 'created_at' ? new Date(r.created_at).toISOString() : (r.data?.[sortKey] ?? null));
  const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ v: sortValue(last), id: last.id })).toString('base64url') : null;
  const facets: Record<string, { value: string; count: number }[]> = {};
  for (const f of facetable) {
    const r = await sql<{ value: string; count: number }>`SELECT data ->> ${f.key} AS value, count(*)::int AS count FROM custom_record WHERE ${where(f.key)} GROUP BY 1 ORDER BY 2 DESC LIMIT 50`.execute(tx);
    facets[f.key] = r.rows.filter((x) => x.value !== null);
  }
  return {
    entity,
    items: page.map((r) => present(p, principal.tenantId, entity, r, rollups.get(r.id) ?? {}, decision)),
    nextCursor,
    facets,
    hiddenFields: Object.entries(decision.fields).filter(([, a]) => a === 'hidden').map(([f]) => f),
    layouts: definition.layouts.filter((l) => l.target === recordTarget(key)),
  };
}

export async function getRecord(p: Platform, tx: Tx, principal: Principal, key: string, id: string) {
  const { definition, entity } = await loadEntity(tx, key);
  const decision = authorizeRecords(principal, key, 'read', id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CommandError(404, 'not_found', 'not found');
  const row = await tx.selectFrom('custom_record').selectAll().where('id', '=', id).where('entity', '=', key).executeTakeFirst();
  if (!row) throw new CommandError(404, 'not_found', `${entity.label} not found`);
  const rollups = await rollupsFor(tx, definition, entity, [id]);
  const events = await sql<{ id: string; type: string; payload: any; pending: boolean }>`
    SELECT id, type, payload, false AS pending FROM event_log WHERE aggregateid = ${id}
    UNION ALL SELECT id, type, payload, true FROM outbox_event WHERE aggregateid = ${id} AND relayed_at IS NULL
    ORDER BY 1`.execute(tx);
  return {
    entity,
    item: present(p, principal.tenantId, entity, row, rollups.get(id) ?? {}, decision),
    events: events.rows
      .map((e) => ({ id: e.id, type: e.type, occurred_at: e.payload.occurred_at, origin: e.payload.origin, pending: e.pending }))
      .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at))),
    layouts: definition.layouts.filter((l) => l.target === recordTarget(key)),
    hiddenFields: Object.entries(decision.fields).filter(([, a]) => a === 'hidden').map(([f]) => f),
  };
}

// ------------------------------------------------------------------ write

export interface RecordWrite {
  tenantId: string;
  principal: Principal;
  entity: string;
  op: 'create' | 'update' | 'delete';
  id?: string;
  version?: number;
  values?: Record<string, unknown>;
  idempotencyKey?: string | undefined;
  origin?: EventOrigin;
  correlationId: string;
  causationId?: string | null;
}

const targetResource = (p: Platform, link: string) => {
  const [scope, name] = link.split(':') as [string, string];
  return scope === 'custom' ? customResource(name) : (p.catalog.entity(scope, name)?.resource ?? link);
};

async function assertLinkTargets(p: Platform, tx: Tx, entity: CustomEntity, values: Record<string, unknown>) {
  for (const f of entity.fields.filter((x) => x.type === 'link' && typeof values[x.key] === 'string')) {
    const id = values[f.key] as string;
    const [scope, name] = f.link!.split(':') as [string, string];
    const exists =
      scope === 'custom'
        ? await tx.selectFrom('custom_record').select('id').where('id', '=', id).where('entity', '=', name).executeTakeFirst()
        : await tx.selectFrom(p.catalog.entity(scope, name)!.table).select('id').where('id', '=', id).executeTakeFirst();
    if (!exists) throw new CommandError(422, 'invalid_link', `${f.key}: linked record not found`);
  }
}

async function syncLinks(p: Platform, tx: Tx, tenantId: string, entity: CustomEntity, id: string, values: Record<string, unknown> | null, eventId: string | null) {
  const from = customResource(entity.key);
  await tx.deleteFrom('record_link').where('from_type', '=', from).where('from_id', '=', id).execute();
  if (!values) {
    await tx.deleteFrom('record_link').where('to_type', '=', from).where('to_id', '=', id).execute();
    return;
  }
  const rows = entity.fields
    .filter((f) => f.type === 'link' && typeof values[f.key] === 'string')
    .map((f) => ({ tenant_id: tenantId, from_type: from, from_id: id, rel: f.key, to_type: targetResource(p, f.link!), to_id: values[f.key] as string, source_event: eventId }));
  if (rows.length) await tx.insertInto('record_link').values(rows).onConflict((oc) => oc.doNothing()).execute();
}

/** Event data never carries PII values. */
const publicData = (entity: CustomEntity, values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).filter(([k]) => !entity.fields.find((f) => f.key === k)?.pii));

export async function executeRecordWrite(p: Platform, req: RecordWrite, existingTx?: Tx): Promise<{ status: number; body: any; replayed: boolean }> {
  assertIdempotencyKey(req.idempotencyKey);
  const run = async (tx: Tx) => {
    await assertWritableTenant(tx);
    const { definition, entity } = await loadEntity(tx, req.entity);
    const decision = authorizeRecords(req.principal, req.entity, 'write', req.id ?? 'new');
    const hash = createHash('sha256').update(JSON.stringify([req.entity, req.op, req.id ?? null, req.version ?? null, req.values ?? null])).digest('hex');
    if (req.idempotencyKey) {
      const prior = await claimIdempotencyKey(tx, req.tenantId, req.idempotencyKey, `records/${req.entity}/${req.op}`, hash);
      if (prior) return { status: prior.status, body: prior.body, replayed: true };
    }
    const target = recordTarget(req.entity);
    const defs = asDefs(entity);
    const locked = readonlyFields(decision);
    const touched = Object.keys(req.values ?? {}).filter((k) => locked.includes(k));
    if (touched.length) throw new CommandError(403, 'field_forbidden', `you may not change: ${touched.join(', ')}`);

    let id = req.id ?? newId();
    let version = 1;
    let stored: Record<string, unknown> | null = null;
    let eventType: string;
    if (req.op === 'create') {
      if (req.id && (await tx.selectFrom('custom_record').select('id').where('id', '=', req.id).executeTakeFirst())) throw new CommandError(409, 'exists', 'a record with this id exists');
      const values = validateCustomValues(defs, req.values ?? {});
      await assertLinkTargets(p, tx, entity, values);
      const failed = evaluateRules(entity, computeFormulas(entity, { ...values, ...((await rollupsFor(tx, definition, entity, [id])).get(id) ?? {}), id }).values);
      if (failed.length) throw Object.assign(new CommandError(422, 'rule_failed', failed.join('; ')), { details: { rules: failed } });
      stored = encryptPii(p.ports.vault, req.tenantId, target, defs, values);
      await tx.insertInto('custom_record').values({ id, tenant_id: req.tenantId, entity: req.entity, data: JSON.stringify(stored), created_by: req.principal.id }).execute();
      eventType = 'record.created';
    } else {
      if (!req.id || !req.version) throw new CommandError(422, 'invalid_input', 'id and version are required');
      const cur = await tx.selectFrom('custom_record').selectAll().where('id', '=', req.id).where('entity', '=', req.entity).executeTakeFirst();
      if (!cur) throw new CommandError(404, 'not_found', `${entity.label} not found`);
      if (cur.version !== req.version) throw new CommandError(409, 'version_conflict', `expected version ${req.version}, current version is ${cur.version}`);
      id = cur.id;
      if (req.op === 'delete') {
        await tx.deleteFrom('custom_record').where('id', '=', id).execute();
        eventType = 'record.deleted';
      } else {
        const existing = decryptAll(p.ports.vault, req.tenantId, target, cur.data);
        const values = validateCustomValues(defs, req.values ?? {}, existing);
        await assertLinkTargets(p, tx, entity, values);
        const failed = evaluateRules(entity, computeFormulas(entity, { ...values, ...((await rollupsFor(tx, definition, entity, [id])).get(id) ?? {}), id }).values);
        if (failed.length) throw Object.assign(new CommandError(422, 'rule_failed', failed.join('; ')), { details: { rules: failed } });
        stored = encryptPii(p.ports.vault, req.tenantId, target, defs, values);
        const row = await tx
          .updateTable('custom_record')
          .set({ data: JSON.stringify(stored), version: sql`version + 1`, updated_at: new Date() })
          .where('id', '=', id)
          .where('version', '=', req.version)
          .returning('version')
          .executeTakeFirst();
        if (!row) throw new CommandError(409, 'version_conflict', 'the record changed');
        version = row.version;
        eventType = 'record.updated';
      }
    }
    const plain = stored ? decryptAll(p.ports.vault, req.tenantId, target, stored) : null;
    const [env] = await writeOutbox(
      tx,
      [{ type: eventType, aggregateType: target, aggregateId: id, data: { entity: req.entity, record_id: id, version: req.op === 'delete' ? null : version, values: plain ? publicData(entity, plain) : null, changed: Object.keys(req.values ?? {}) } }],
      { tenantId: req.tenantId, app: 'custom', correlationId: req.correlationId, causationId: req.causationId ?? null, traceparent: p.ports.telemetry.traceparent(), origin: req.origin ?? 'user', newId },
    );
    await syncLinks(p, tx, req.tenantId, entity, id, req.op === 'delete' ? null : plain, env!.id);
    await writeAudit(tx, { tenantId: req.tenantId, actor: req.principal, action: `custom:${req.entity}.${req.op}`, resourceType: customResource(req.entity), resourceId: id, correlationId: req.correlationId, data: { fields: Object.keys(req.values ?? {}), origin: req.origin ?? 'user' } });
    const status = req.op === 'create' ? 201 : 200;
    const body = { id, version: req.op === 'delete' ? null : version };
    if (req.idempotencyKey) await storeIdempotentResponse(tx, req.idempotencyKey, status, body);
    return { status, body, replayed: false };
  };
  return existingTx ? run(existingTx) : p.database.withTenant(req.tenantId, run);
}
