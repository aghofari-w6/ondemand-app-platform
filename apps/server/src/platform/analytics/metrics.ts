import { createHash } from 'node:crypto';
import { customResource, expr, type EventEnvelope, type MetricSpec } from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../../db/database.ts';
import { BoundedCache } from '../../adapters/bounded-cache.ts';
import type { Consumer, MetricPoint } from '../../ports/index.ts';
import { activeApps } from '../commands.ts';
import type { Platform } from '../context.ts';
import { publishedDefinition } from '../datastudio.ts';
import { QUEUES } from '../queues.ts';
import { readPermission } from '../workspace.ts';

/**
 * Metrics pipeline.
 *
 * - Specs: manifest `analytics.metrics` of active apps + Data studio metrics over custom
 *   entities, compiled to one `MetricSpec` shape with a version hash.
 * - Consumer `platform.metrics`: each event adds points to the hourly buckets of the
 *   metrics it moves, in the transaction that marks the event processed (exactly once).
 * - Rebuild (job): reset a metric's buckets and replay `event_log` in batches up to the
 *   seq recorded at the start; the consumer covers everything after that seq. Runs when
 *   a metric is new or its definition changed.
 * - Reconciliation (nightly job): bucket totals vs the source table; a drift triggers one
 *   rebuild a day, and a drift that survives a rebuild is recorded as such.
 */

export const ANALYTICS_PACKAGE = 'Analytics';
const BATCH = 500;

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

export async function analyticsEnabled(p: Platform, tx: Tx): Promise<boolean> {
  // A deleted tenant has no row: not enabled. Never throw here — the metrics consumer
  // sees every event, and a thrown error would stall it on that event (head-of-line).
  const t = await tx.selectFrom('tenant').select(['plan', 'status']).executeTakeFirst();
  if (!t || t.status === 'deleted') return false;
  return p.ports.billing.plan(t.plan)?.packages.includes(ANALYTICS_PACKAGE) ?? false;
}

export async function metricSpecs(p: Platform, tx: Tx): Promise<MetricSpec[]> {
  const out: MetricSpec[] = [];
  const active = new Set(await activeApps(tx));
  for (const m of p.catalog.manifests()) {
    if (!active.has(m.id)) continue;
    for (const a of m.analytics.metrics) {
      const ent = m.entities.find((e) => e.name === a.entity)!;
      const base = {
        id: `${m.id}:${a.name}`,
        label: a.label,
        app: m.id,
        entity: a.entity,
        resource: ent.resource,
        readPermission: readPermission(m.id, ent),
        aggregate: a.aggregate,
        field: a.field ?? null,
        unit: a.unit ?? (a.aggregate === 'count' ? 'count' : 'number'),
        events: a.events,
        dims: a.dims,
        reconcile: { table: ent.table, column: 'plain' as const, where: a.where },
      };
      out.push({ ...base, version: hash(base) });
    }
  }
  const { definition } = await publishedDefinition(tx);
  for (const c of definition.metrics) {
    const ent = definition.entities.find((e) => e.key === c.entity);
    if (!ent) continue;
    const dims = Object.fromEntries(Object.entries(c.dims).map(([d, k]) => [d, `values.${k}`]));
    const filter = `entity == '${c.entity}'`;
    const base = {
      id: `custom:${c.key}`,
      label: c.label,
      app: 'custom',
      entity: c.entity,
      resource: customResource(c.entity),
      readPermission: 'platform:records.read',
      aggregate: c.aggregate,
      field: c.field ?? null,
      unit: (c.aggregate === 'count' ? 'count' : 'number') as MetricSpec['unit'],
      events:
        c.aggregate === 'count'
          ? [
              { type: 'record.created', filter },
              { type: 'record.deleted', filter, value: '-1' },
            ]
          : [{ type: 'record.created', filter, value: `values.${c.field}` }],
      dims,
      // A sum is taken when records are created, so it cannot be recomputed from the
      // current rows; counts can.
      reconcile: c.aggregate === 'count' ? { table: 'custom_record', column: 'data' as const, entity: c.entity, where: {} } : null,
    };
    out.push({ ...base, version: hash(base) });
  }
  return out;
}

/**
 * Specs per tenant for the consumer, keyed by a fingerprint of everything that defines
 * them (installed apps + their versions and status, the published Data studio version).
 * One cheap query per event; a change takes effect on the very next event (a plain TTL
 * cache dropped events while an app was being activated). Bounded: memory-safe-code §5.
 */
const specCache = new BoundedCache<MetricSpec[]>({ max: 2000, ttlMs: 10 * 60_000 });
/** Kept for callers that change metrics outside the fingerprint; the fingerprint covers the rest. */
export const forgetSpecs = (tenantId: string) => specCache.delete(tenantId);

async function cachedSpecs(p: Platform, tx: Tx, tenantId: string) {
  const fp = await sql<{ f: string | null }>`
    SELECT concat_ws('|',
      (SELECT string_agg(app || ':' || version || ':' || status, ',' ORDER BY app) FROM installed_app),
      (SELECT max(number)::text FROM metadata_version WHERE status = 'published')) AS f`.execute(tx);
  const key = `${tenantId}|${fp.rows[0]?.f ?? ''}`;
  const hit = specCache.get(key);
  if (hit) return hit;
  const specs = await metricSpecs(p, tx);
  specCache.set(key, specs);
  return specs;
}

const evalExpr = (src: string, ctx: Record<string, unknown>) => expr.evaluate(expr.parse(src), ctx, { maxSteps: 2000 });

/** The points one event adds to one metric (empty when it does not apply). */
export function pointsFor(spec: MetricSpec, event: EventEnvelope): MetricPoint[] {
  const out: MetricPoint[] = [];
  const ctx = event.data as Record<string, unknown>;
  for (const m of spec.events) {
    if (m.type !== event.type) continue;
    try {
      if (m.filter && !expr.truthy(evalExpr(m.filter, ctx))) continue;
      const raw = m.value !== undefined ? evalExpr(m.value, ctx) : spec.aggregate === 'count' ? 1 : spec.field ? (ctx[spec.field] as number) : 1;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const time = m.time ? new Date(String(evalExpr(m.time, ctx))) : new Date(event.occurred_at);
      const at = Number.isNaN(time.getTime()) ? new Date(event.occurred_at) : time;
      const dim = (d: 'store' | 'channel') => {
        const src = spec.dims[d];
        if (!src) return '';
        const v = evalExpr(src, ctx);
        return v === null || v === undefined ? '' : String(v).slice(0, 120);
      };
      // count moves by ±1 with the value's sign, so avg = value / count stays right after reversals
      out.push({ tenantId: event.tenant_id, metric: spec.id, at, store: dim('store'), channel: dim('channel'), value, count: spec.aggregate === 'count' ? value : Math.sign(value) || 1 });
    } catch {
      // Bad data in one event never stalls the pipeline; reconciliation shows the drift.
      continue;
    }
  }
  return out;
}

async function eventSeq(tx: Tx, id: string): Promise<number> {
  const r = await tx.selectFrom('event_log').select('seq').where('id', '=', id).executeTakeFirst();
  return Number(r?.seq ?? 0);
}

/**
 * Consumer adds and rebuild starts are serialized per tenant + metric with an advisory
 * lock (shared for adds, exclusive for a rebuild's reset), so a reset can never interleave
 * with an add in flight, even before the metric has a state row.
 */
const lockKey = (tenantId: string, metric: string) => sql`hashtextextended(${`metric:${tenantId}:${metric}`}, 0)`;

async function requestRebuild(p: Platform, tenantId: string, metric: string) {
  await p.ports.jobs.send(QUEUES.metricRebuild, { tenantId, metric }, { singletonKey: `${tenantId}:${metric}` });
}

export function metricsConsumer(p: Platform): Consumer {
  return {
    name: 'platform.metrics',
    types: ['*'],
    async handle(event, tx) {
      if (event.type.startsWith('workflow.') || event.type.startsWith('approval.')) return;
      if (!(await analyticsEnabled(p, tx))) return 'skipped';
      const specs = (await cachedSpecs(p, tx, event.tenant_id)).filter((s) => s.events.some((e) => e.type === event.type));
      if (!specs.length) return;
      for (const spec of specs.sort((a, b) => a.id.localeCompare(b.id))) await sql`SELECT pg_advisory_xact_lock_shared(${lockKey(event.tenant_id, spec.id)})`.execute(tx);
      const states = await tx.selectFrom('metric_state').selectAll().where('metric', 'in', specs.map((s) => s.id)).execute();
      const seq = await eventSeq(tx, event.id);
      const points: MetricPoint[] = [];
      for (const spec of specs) {
        const st = states.find((s) => s.metric === spec.id);
        // A rebuild that has started covers every event up to its `through_seq`.
        if (st && st.version === spec.version && st.status === 'rebuilding' && seq <= Number(st.through_seq)) continue;
        // New or changed definition: count the event now and ask for a rebuild; the rebuild
        // resets and replays (under the exclusive lock), so nothing is lost or doubled.
        if (!st || st.version !== spec.version) await requestRebuild(p, event.tenant_id, spec.id);
        points.push(...pointsFor(spec, event));
      }
      if (points.length) await p.ports.analytics.add(tx, points);
      return undefined;
    },
  };
}

/** Rebuilds one metric's buckets from the event log (job). */
export async function rebuildMetric(p: Platform, data: { tenantId: string; metric: string }) {
  const { tenantId, metric } = data;
  for (let attempt = 0; attempt < 3; attempt++) {
    const start = await p.database.withTenant(tenantId, async (tx) => {
      const spec = (await metricSpecs(p, tx)).find((s) => s.id === metric);
      if (!spec) {
        // The metric no longer exists (app removed, Data studio change): drop its data.
        await p.ports.analytics.reset(tx, metric);
        await tx.deleteFrom('metric_state').where('metric', '=', metric).execute();
        return null;
      }
      await sql`SELECT pg_advisory_xact_lock(${lockKey(tenantId, metric)})`.execute(tx);
      const max = await tx.selectFrom('event_log').select(sql<string>`coalesce(max(seq), 0)`.as('m')).executeTakeFirstOrThrow();
      await p.ports.analytics.reset(tx, metric);
      await tx
        .insertInto('metric_state')
        .values({ tenant_id: tenantId, metric, version: spec.version, status: 'rebuilding', through_seq: Number(max.m), cursor_seq: 0 })
        .onConflict((oc) => oc.columns(['tenant_id', 'metric']).doUpdateSet({ version: spec.version, status: 'rebuilding', through_seq: Number(max.m), cursor_seq: 0, updated_at: new Date() }))
        .execute();
      return { spec, through: Number(max.m) };
    });
    if (!start) return;
    const types = [...new Set(start.spec.events.map((e) => e.type))];
    let cursor = 0;
    for (;;) {
      const n = await p.database.withTenant(tenantId, async (tx) => {
        const batch = await tx.selectFrom('event_log').select(['seq', 'payload']).where('type', 'in', types).where('seq', '>', cursor).where('seq', '<=', start.through).orderBy('seq').limit(BATCH).execute();
        const points = batch.flatMap((r) => pointsFor(start.spec, r.payload as EventEnvelope));
        if (points.length) await p.ports.analytics.add(tx, points);
        if (batch.length) cursor = Number(batch.at(-1)!.seq);
        await tx.updateTable('metric_state').set({ cursor_seq: cursor, updated_at: new Date() }).where('metric', '=', metric).execute();
        return batch.length;
      });
      if (n < BATCH) break;
    }
    const done = await p.database.withTenant(tenantId, async (tx) => {
      const spec = (await metricSpecs(p, tx)).find((s) => s.id === metric);
      // Changed again while rebuilding: start over.
      if (spec && spec.version !== start.spec.version) return false;
      await tx.updateTable('metric_state').set({ status: 'ready', rebuilt_at: new Date(), updated_at: new Date() }).where('metric', '=', metric).execute();
      return true;
    });
    if (done) return;
  }
}

/** Starts rebuilds for metrics that are new or whose definition changed. */
export async function ensureMetrics(p: Platform, tenantId: string) {
  const stale = await p.database.withTenant(tenantId, async (tx) => {
    if (!(await analyticsEnabled(p, tx))) return [];
    const specs = await metricSpecs(p, tx);
    const states = await tx.selectFrom('metric_state').select(['metric', 'version']).execute();
    const gone = states.filter((s) => !specs.some((x) => x.id === s.metric)).map((s) => s.metric);
    return [...specs.filter((s) => states.find((x) => x.metric === s.id)?.version !== s.version).map((s) => s.id), ...gone];
  });
  for (const m of stale) await requestRebuild(p, tenantId, m);
  return stale;
}

/** Recomputes a metric's total from its source table. */
async function sourceTotal(tx: Tx, spec: MetricSpec): Promise<number> {
  const r = spec.reconcile!;
  if (r.column === 'data') {
    const row = await tx.selectFrom('custom_record').select(sql<string>`count(*)`.as('v')).where('entity', '=', r.entity!).executeTakeFirstOrThrow();
    return Number(row.v);
  }
  // Table and column names come from the manifest (validated), never from user input.
  let q = tx.selectFrom(r.table).select(spec.aggregate === 'count' ? sql<string>`count(*)`.as('v') : sql<string>`coalesce(sum(${sql.ref(spec.field!)}), 0)`.as('v'));
  for (const [col, values] of Object.entries(r.where)) q = q.where(sql.ref(col), 'in', values);
  const row = await q.executeTakeFirstOrThrow();
  return Number(row.v);
}

/** Nightly reconciliation for one tenant. */
export async function reconcileTenant(p: Platform, tenantId: string) {
  await ensureMetrics(p, tenantId);
  const rebuild = await p.database.withTenant(tenantId, async (tx) => {
    const specs = await metricSpecs(p, tx);
    const states = await tx.selectFrom('metric_state').selectAll().execute();
    const out: string[] = [];
    for (const spec of specs) {
      const st = states.find((s) => s.metric === spec.id);
      if (!spec.reconcile || !st || st.status !== 'ready' || st.version !== spec.version) continue;
      const bucket = await p.ports.analytics.total(tx, spec.id);
      const source = await sourceTotal(tx, spec);
      const bucketValue = spec.aggregate === 'count' ? bucket.count : bucket.value;
      const ok = Math.abs(bucketValue - source) < 0.005;
      const recentRebuild = st.rebuilt_at && Date.now() - new Date(st.rebuilt_at).getTime() < 20 * 3600_000;
      const action = ok ? 'none' : recentRebuild ? 'drift_persists' : 'rebuild';
      await tx.insertInto('metric_check').values({ id: newId(), tenant_id: tenantId, metric: spec.id, bucket_value: bucketValue, source_value: source, ok, action }).execute();
      if (action === 'rebuild') out.push(spec.id);
    }
    return out;
  });
  for (const m of rebuild) await requestRebuild(p, tenantId, m);
  return rebuild;
}

/** The nightly job: every tenant with metrics (narrow definer function lists ids only). */
export async function reconcileAll(p: Platform) {
  const tenants = (await sql<{ tenant_id: string }>`SELECT tenant_id FROM metric_tenants()`.execute(p.database.db)).rows;
  for (const t of tenants) await reconcileTenant(p, t.tenant_id).catch((e: unknown) => p.log.error({ err: String(e), tenant: t.tenant_id }, 'metric reconciliation failed'));
}
