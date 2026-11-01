import { action, authorize, CommandError, maskFields, type Decision, type Entity, type Principal } from '@aod/shared';
import { sql, type SelectQueryBuilder } from 'kysely';
import type { Tx } from '../db/database.ts';
import type { Platform } from './context.ts';

/**
 * Generic list/detail over any manifest entity: facets, full-text search through the
 * Search port, sort over declared sortable fields, keyset (cursor) paging, field
 * masking from authorize(). Column names only ever come from the manifest.
 */

export interface ListQuery {
  q?: string;
  sort?: string;
  cursor?: string;
  limit?: number;
  view?: string;
  filters: Record<string, string[]>;
}

export interface Cursor {
  v: string | number | null;
  id: string;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (typeof c?.id !== 'string') throw new Error();
    return c;
  } catch {
    throw new CommandError(400, 'invalid_cursor', 'invalid cursor');
  }
}

export function readPermission(app: string, entity: Entity) {
  return entity.read_permission ?? `${app}:${entity.name}.read`;
}

export function entityFor(p: Platform, app: string, name: string): Entity {
  const e = p.catalog.entity(app, name);
  if (!e || !e.workspace) throw new CommandError(404, 'unknown_entity', `unknown entity ${app}/${name}`);
  return e;
}

export function authorizeRead(principal: Principal, app: string, entity: Entity, id = '*'): Decision {
  const d = authorize(principal, action(readPermission(app, entity)), { type: entity.resource, id, tenantId: principal.tenantId });
  if (d.decision === 'deny') throw new CommandError(403, 'forbidden', `missing permission ${readPermission(app, entity)}`);
  return d;
}

const toValue = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | number | null));

export async function listEntity(p: Platform, tx: Tx, principal: Principal, app: string, entityName: string, q: ListQuery) {
  const entity = entityFor(p, app, entityName);
  const decision = authorizeRead(principal, app, entity);
  const manifest = p.catalog.get(app)!.manifest;
  const view = q.view ? manifest.views.find((v) => v.entity === entity.name && v.name === q.view) : undefined;
  if (q.view && !view) throw new CommandError(404, 'unknown_view', `unknown view ${q.view}`);

  const facetFields = entity.fields.filter((f) => f.facet);
  const filters: Record<string, string[]> = { ...(view?.filter ?? {}) };
  for (const [k, vals] of Object.entries(q.filters)) {
    if (!facetFields.some((f) => f.key === k)) throw new CommandError(400, 'invalid_filter', `${k} is not a facet`);
    if (vals.length) filters[k] = vals;
  }

  const sortSpec = q.sort ?? view?.sort ?? entity.default_sort ?? '-created_at';
  const desc = sortSpec.startsWith('-');
  const sortKey = sortSpec.replace(/^-/, '');
  if (!entity.fields.some((f) => f.key === sortKey && (f.sortable || sortKey === entity.default_sort?.replace(/^-/, ''))) && sortKey !== 'created_at') {
    throw new CommandError(400, 'invalid_sort', `${sortKey} is not sortable`);
  }
  if (decision.fields[sortKey] === 'hidden') throw new CommandError(403, 'forbidden', `you cannot sort by ${sortKey}`);
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);

  const applyFilters = <Q extends SelectQueryBuilder<any, any, any>>(qb: Q, except?: string): Q => {
    let out = qb;
    for (const [k, vals] of Object.entries(filters)) {
      if (k === except) continue;
      const field = entity.fields.find((f) => f.key === k)!;
      if (field.type === 'boolean') out = out.where(sql.ref(k), 'in', vals.map((v) => v === 'true')) as Q;
      else out = out.where(sql.ref(k), 'in', vals) as Q;
    }
    if (q.q?.trim()) out = out.where(p.ports.search.match('search', q.q)) as Q;
    return out;
  };

  let qb = applyFilters(tx.selectFrom(entity.table).selectAll());
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    const col = sql.ref(sortKey);
    const cmp = desc ? sql.raw('<') : sql.raw('>');
    qb = qb.where(
      c.v === null
        ? sql<boolean>`(${col} IS NULL AND id ${cmp} ${c.id})`
        : sql<boolean>`((${col} ${cmp} ${c.v}) OR (${col} = ${c.v} AND id ${cmp} ${c.id}) OR ${col} IS NULL)`,
    );
  }
  const dir = desc ? sql.raw('DESC') : sql.raw('ASC');
  const rows = await qb
    .orderBy(sql`${sql.ref(sortKey)} ${dir} NULLS LAST`)
    .orderBy('id', desc ? 'desc' : 'asc')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor({ v: toValue(last[sortKey]), id: last.id }) : null;

  const facets: Record<string, { value: string; count: number }[]> = {};
  for (const f of facetFields) {
    if (decision.fields[f.key] === 'hidden') continue;
    const counts = await applyFilters(tx.selectFrom(entity.table), f.key)
      .select([sql<string>`${sql.ref(f.key)}::text`.as('value'), sql<number>`count(*)`.as('count')])
      .groupBy(sql.ref(f.key))
      .orderBy('count', 'desc')
      .limit(50)
      .execute();
    facets[f.key] = counts.filter((c) => c.value !== null).map((c) => ({ value: c.value, count: Number(c.count) }));
  }

  return {
    items: page.map((r) => maskFields(clean(r), decision)),
    nextCursor,
    facets,
    applied: { filters, sort: sortSpec, q: q.q ?? '' },
    hiddenFields: Object.entries(decision.fields).filter(([, a]) => a === 'hidden').map(([f]) => f),
  };
}

function clean(row: Record<string, unknown>) {
  const { search: _search, tenant_id: _t, ...rest } = row;
  return rest;
}

export async function getEntity(p: Platform, tx: Tx, principal: Principal, app: string, entityName: string, id: string) {
  const entity = entityFor(p, app, entityName);
  const decision = authorizeRead(principal, app, entity, id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CommandError(404, 'not_found', 'not found');
  const row = await tx.selectFrom(entity.table).selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw new CommandError(404, 'not_found', `${entity.label} not found`);
  // Events for this aggregate: relayed (event_log) plus not-yet-relayed (outbox).
  const events = await sql<{ id: string; type: string; payload: any; created_at: Date; pending: boolean }>`
    SELECT id, type, payload, created_at, false AS pending FROM event_log WHERE aggregateid = ${id}
    UNION ALL
    SELECT id, type, payload, created_at, true AS pending FROM outbox_event WHERE aggregateid = ${id} AND relayed_at IS NULL
    ORDER BY created_at, id`.execute(tx);
  return {
    item: maskFields(clean(row), decision),
    events: events.rows.map((e) => ({
      id: e.id,
      type: e.type,
      occurred_at: e.payload.occurred_at,
      origin: e.payload.origin,
      correlation_id: e.payload.correlation_id,
      causation_id: e.payload.causation_id,
      pending: e.pending,
      data: e.payload.data,
    })),
    hiddenFields: Object.entries(decision.fields).filter(([, a]) => a === 'hidden').map(([f]) => f),
  };
}
