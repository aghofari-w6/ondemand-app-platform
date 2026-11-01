import { action, authorize, CommandError, type AnalyticsQuery, type Dimension, type Granularity, type MetricSpec, type Principal } from '@aod/shared';
import type { Tx } from '../../db/database.ts';
import type { Platform } from '../context.ts';
import { analyticsEnabled, metricSpecs } from './metrics.ts';

/**
 * Reading metrics. Every query is authorized as the viewer:
 * - the plan must include Analytics;
 * - the viewer needs the read permission of the entity the metric measures;
 * - a metric whose field is hidden for the viewer cannot be shown, nor grouped by a
 *   dimension whose field is hidden (field rules apply to aggregates too).
 */

const plainField = (src: string | undefined) => {
  if (!src) return null;
  const m = /^(?:values\.)?([a-z][a-z0-9_]*)$/.exec(src.trim());
  return m ? m[1]! : null;
};

export function defaultGranularity(from: Date, to: Date): Granularity {
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  return days <= 2 ? 'hour' : days <= 92 ? 'day' : days <= 370 ? 'week' : 'month';
}

/** Throws unless the viewer may see this metric (optionally grouped by `dim`). */
export function assertCanView(spec: MetricSpec, principal: Principal, dim?: Dimension | null) {
  const d = authorize(principal, action(spec.readPermission), { type: spec.resource, id: '*', tenantId: principal.tenantId });
  if (d.decision === 'deny') throw new CommandError(403, 'forbidden', `missing permission ${spec.readPermission}`);
  if (spec.field && d.fields[spec.field] === 'hidden') throw new CommandError(403, 'field_hidden', `${spec.label} aggregates a field hidden for your role`);
  const dimField = dim ? plainField(spec.dims[dim]) : null;
  if (dimField && d.fields[dimField] === 'hidden') throw new CommandError(403, 'field_hidden', `${dim} is hidden for your role`);
}

/** Metrics the viewer may see (others are left out of pickers and default dashboards). */
export async function visibleMetrics(p: Platform, tx: Tx, principal: Principal) {
  if (!(await analyticsEnabled(p, tx))) return [];
  return (await metricSpecs(p, tx)).filter((s) => {
    try {
      assertCanView(s, principal);
      return true;
    } catch {
      return false;
    }
  });
}

export async function queryMetric(p: Platform, tx: Tx, principal: Principal, q: AnalyticsQuery) {
  if (!(await analyticsEnabled(p, tx))) throw new CommandError(403, 'not_in_plan', 'your plan does not include the Analytics package');
  const spec = (await metricSpecs(p, tx)).find((s) => s.id === q.metric);
  if (!spec) throw new CommandError(404, 'unknown_metric', `unknown metric ${q.metric}`);
  assertCanView(spec, principal, q.group_by ?? null);
  const from = new Date(q.from);
  const to = new Date(q.to);
  const state = await tx.selectFrom('metric_state').select(['status', 'version']).where('metric', '=', spec.id).executeTakeFirst();
  const run = async (f: Date, t: Date, granularity: Granularity | null, groupBy: Dimension | null) =>
    (await p.ports.analytics.query(tx, { metric: spec.id, from: f, to: t, granularity, groupBy, filters: q.filters, ...(q.limit ? { limit: q.limit } : {}) })).map((r) => ({
      ...r,
      value: spec.aggregate === 'avg' ? (r.count ? r.value / r.count : 0) : spec.aggregate === 'count' ? r.count : r.value,
    }));
  const granularity = q.group_by ? null : (q.granularity ?? defaultGranularity(from, to));
  const series = await run(from, to, granularity, q.group_by ?? null);
  const [total] = await run(from, to, null, null);
  let previous: number | null = null;
  if (q.compare) {
    const span = to.getTime() - from.getTime();
    const [prev] = await run(new Date(from.getTime() - span), from, null, null);
    previous = prev?.value ?? 0;
  }
  return {
    metric: { id: spec.id, label: spec.label, unit: spec.unit, aggregate: spec.aggregate, app: spec.app },
    granularity,
    group_by: q.group_by ?? null,
    series: series.map((r) => ({ bucket: r.bucket, key: r.key, value: r.value })),
    total: total?.value ?? 0,
    previous,
    // `rebuilding`: numbers are still being backfilled from history
    status: !state ? 'pending' : state.status,
  };
}
