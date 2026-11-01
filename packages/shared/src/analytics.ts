import { z } from 'zod';
import { parse as parseExpr } from './expr/index.ts';

/**
 * Analytics: metrics are per-tenant hourly buckets fed by events.
 *
 * A metric names the entity it measures (so field rules and permissions can be applied to
 * whoever views it), the events that move it (each with a value expression over the
 * event's `data`), optional dimensions (store, channel) and, for reconciliation, the
 * filter that selects the same rows in the entity's table.
 */

const ident = z.string().regex(/^[a-z][a-z0-9_]*$/);
const eventType = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const expression = z.string().min(1).max(300);

export const DIMENSIONS = ['store', 'channel'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const MetricEvent = z.object({
  type: eventType,
  /** amount added to the metric (expression over event data); default 1 for count, the metric field for sum/avg */
  value: expression.optional(),
  /** when given, only events where this is true count */
  filter: expression.optional(),
  /** event time (expression over event data giving an ISO date); default: when the event occurred */
  time: expression.optional(),
});
export type MetricEvent = z.infer<typeof MetricEvent>;

export const MetricDims = z.object({ store: expression.optional(), channel: expression.optional() }).default({});

/** `analytics.metrics` in an app manifest. */
export const AnalyticsMetric = z.object({
  name: ident,
  label: z.string(),
  entity: ident,
  aggregate: z.enum(['count', 'sum', 'avg']),
  field: z.string().optional(),
  unit: z.enum(['count', 'money', 'number']).optional(),
  events: z.array(MetricEvent).default([]),
  dims: MetricDims,
  /** row filter on the entity table that matches what the events count (reconciliation) */
  where: z.record(z.string(), z.array(z.string())).default({}),
});
export type AnalyticsMetric = z.infer<typeof AnalyticsMetric>;

/** A metric defined in Data studio over a custom entity. */
export const CustomMetric = z.object({
  key: ident,
  label: z.string().trim().min(1).max(60),
  entity: ident,
  /** count: records created minus deleted; sum: the field's value when a record is created */
  aggregate: z.enum(['count', 'sum']),
  field: ident.optional(),
  /** custom-entity field keys used as dimensions */
  dims: z.object({ store: ident.optional(), channel: ident.optional() }).default({}),
});
export type CustomMetric = z.infer<typeof CustomMetric>;

/** A runtime metric: one compiled shape for manifest and Data studio metrics. */
export interface MetricSpec {
  /** `<app>:<name>` or `custom:<key>` */
  id: string;
  label: string;
  app: string;
  entity: string;
  /** resource type for authorize() (e.g. `ordering::Order`, `custom::supplier`) */
  resource: string;
  /** permission needed to read the underlying records */
  readPermission: string;
  aggregate: 'count' | 'sum' | 'avg';
  /** entity field the metric aggregates (field rules: a hidden field hides the metric) */
  field: string | null;
  unit: 'count' | 'money' | 'number';
  events: MetricEvent[];
  dims: Partial<Record<Dimension, string>>;
  /** how to recompute the same total from the source table; null if not reconcilable */
  reconcile: { table: string; column: 'plain' | 'data'; entity?: string; where: Record<string, string[]> } | null;
  /** stable hash of the definition: a change triggers a rebuild */
  version: string;
}

export function validateAnalyticsMetric(m: AnalyticsMetric, publishes: Set<string>, fields: Set<string>): string[] {
  const p: string[] = [];
  if (m.aggregate !== 'count' && (!m.field || !fields.has(m.field))) p.push(`metric ${m.name}: ${m.aggregate} needs a field of ${m.entity}`);
  for (const e of m.events) {
    if (!publishes.has(e.type)) p.push(`metric ${m.name}: event ${e.type} is not published by this app`);
    for (const [what, src] of [['value', e.value], ['filter', e.filter], ['time', e.time]] as const) {
      if (!src) continue;
      try {
        parseExpr(src);
      } catch (err) {
        p.push(`metric ${m.name}: ${what} of ${e.type}: ${(err as Error).message}`);
      }
    }
  }
  for (const [d, src] of Object.entries(m.dims)) {
    try {
      parseExpr(src!);
    } catch (err) {
      p.push(`metric ${m.name}: dimension ${d}: ${(err as Error).message}`);
    }
  }
  for (const k of Object.keys(m.where)) if (!fields.has(k)) p.push(`metric ${m.name}: where uses unknown field ${k}`);
  return p;
}

// ------------------------------------------------------------------ queries and widgets

export const Granularity = z.enum(['hour', 'day', 'week', 'month']);
export type Granularity = z.infer<typeof Granularity>;

/** Longest range a query may cover (memory-safe-code §7: bounded loops and reads). */
export const MAX_RANGE_DAYS = 400;

export const AnalyticsFilters = z.object({
  store: z.array(z.string().max(120)).max(50).optional(),
  channel: z.array(z.string().max(60)).max(20).optional(),
});
export type AnalyticsFilters = z.infer<typeof AnalyticsFilters>;

export const AnalyticsQuery = z
  .object({
    metric: z.string().min(3).max(120),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    granularity: Granularity.optional(),
    group_by: z.enum(DIMENSIONS).optional(),
    filters: AnalyticsFilters.default({}),
    /** compare with the previous period of the same length (KPI) */
    compare: z.boolean().default(false),
    /** top-N by value when grouping */
    limit: z.int().min(1).max(100).optional(),
  })
  .superRefine((q, ctx) => {
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    if (!(to > from)) ctx.addIssue({ code: 'custom', path: ['to'], message: 'must be after from' });
    else if (to - from > MAX_RANGE_DAYS * 86_400_000) ctx.addIssue({ code: 'custom', path: ['to'], message: `ranges are limited to ${MAX_RANGE_DAYS} days` });
    if (from < Date.parse('2000-01-01T00:00:00Z') || to > Date.parse('2100-01-01T00:00:00Z')) ctx.addIssue({ code: 'custom', path: ['from'], message: 'dates must be between 2000 and 2100' });
  });
export type AnalyticsQuery = z.infer<typeof AnalyticsQuery>;

export const WIDGET_KINDS = ['kpi', 'timeseries', 'bar', 'table'] as const;

export const Widget = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  kind: z.enum(WIDGET_KINDS),
  title: z.string().trim().min(1).max(80),
  metric: z.string().min(3).max(120),
  group_by: z.enum(DIMENSIONS).optional(),
  limit: z.int().min(1).max(50).optional(),
});
export type Widget = z.infer<typeof Widget>;

export const DashboardInput = z.object({
  name: z.string().trim().min(1).max(80),
  widgets: z.array(Widget).max(24),
  /** roles that can see the dashboard (preset names or custom role ids); empty = only its owner and Admins */
  shared_roles: z.array(z.string().min(1).max(60)).max(20).default([]),
});
export type DashboardInput = z.infer<typeof DashboardInput>;

/** Relative date ranges used by reports and dashboards. */
export const RELATIVE_RANGES = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month', 'last_month'] as const;
export type RelativeRange = (typeof RELATIVE_RANGES)[number];

export function resolveRange(r: RelativeRange, now = new Date()): { from: Date; to: Date } {
  const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const today = day(now);
  const add = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
  switch (r) {
    case 'today':
      return { from: today, to: add(today, 1) };
    case 'yesterday':
      return { from: add(today, -1), to: today };
    case 'last_7_days':
      return { from: add(today, -6), to: add(today, 1) };
    case 'last_30_days':
      return { from: add(today, -29), to: add(today, 1) };
    case 'this_month':
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: add(today, 1) };
    case 'last_month':
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) };
  }
}

// ------------------------------------------------------------------ reports

export const ReportQuery = z.object({
  metrics: z.array(z.string().min(3).max(120)).min(1).max(6),
  range: z.enum(RELATIVE_RANGES),
  granularity: z.enum(['none', 'hour', 'day', 'week', 'month']).default('day'),
  group_by: z.enum(DIMENSIONS).optional(),
  filters: AnalyticsFilters.default({}),
});
export type ReportQuery = z.infer<typeof ReportQuery>;

export const ReportSchedule = z
  .object({
    every: z.enum(['day', 'week', 'month']),
    /** hour of day, UTC */
    hour: z.int().min(0).max(23),
    /** for weekly schedules: 0 = Sunday */
    weekday: z.int().min(0).max(6).optional(),
    /** for monthly schedules */
    day: z.int().min(1).max(28).optional(),
    format: z.enum(['csv', 'pdf']),
    /** email delivery arrives with the Gmail channel (Milestone E); until then: a file */
    deliver: z.enum(['file']).default('file'),
  })
  .superRefine((s, ctx) => {
    if (s.every === 'week' && s.weekday === undefined) ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'weekly schedules need a weekday' });
    if (s.every === 'month' && s.day === undefined) ctx.addIssue({ code: 'custom', path: ['day'], message: 'monthly schedules need a day of the month' });
  });
export type ReportSchedule = z.infer<typeof ReportSchedule>;

export const ReportInput = z.object({
  name: z.string().trim().min(1).max(80),
  query: ReportQuery,
  schedule: ReportSchedule.nullable().default(null),
});
export type ReportInput = z.infer<typeof ReportInput>;

/** Next run strictly after `after` (UTC). */
export function nextRunAt(s: ReportSchedule, after: Date): Date {
  const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, s.hour, 0, 0));
  const y = after.getUTCFullYear();
  const m = after.getUTCMonth();
  const d = after.getUTCDate();
  if (s.every === 'day') {
    const today = at(y, m, d);
    return today > after ? today : at(y, m, d + 1);
  }
  if (s.every === 'week') {
    for (let i = 0; i < 8; i++) {
      const c = at(y, m, d + i);
      if (c.getUTCDay() === s.weekday && c > after) return c;
    }
  }
  const thisMonth = at(y, m, s.day!);
  return thisMonth > after ? thisMonth : at(y, m + 1, s.day!);
}
