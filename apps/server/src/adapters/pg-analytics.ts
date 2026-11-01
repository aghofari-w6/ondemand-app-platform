import { sql } from 'kysely';
import type { Analytics, MetricPoint } from '../ports/index.ts';

/**
 * Analytics on PostgreSQL: hourly `metric_bucket` rows per tenant, metric, store and
 * channel (ClickHouse later behind the same port). Points are merged with an upsert, so
 * adding is commutative and a rebuild is reset + replay.
 */
const hour = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);

export const pgAnalytics: Analytics = {
  async add(tx, points: MetricPoint[]) {
    // Merge points that land in the same bucket first (one upsert per bucket).
    const merged = new Map<string, MetricPoint>();
    for (const p of points) {
      const at = hour(p.at);
      const k = `${p.metric}|${at.toISOString()}|${p.store}|${p.channel}`;
      const cur = merged.get(k);
      if (cur) {
        cur.value += p.value;
        cur.count += p.count;
      } else merged.set(k, { ...p, at });
    }
    const rows = [...merged.values()];
    for (let i = 0; i < rows.length; i += 500) {
      await tx
        .insertInto('metric_bucket')
        .values(rows.slice(i, i + 500).map((p) => ({ tenant_id: p.tenantId, metric: p.metric, bucket: p.at, store: p.store, channel: p.channel, value: p.value, count: p.count })))
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'metric', 'bucket', 'store', 'channel']).doUpdateSet({
            value: sql`metric_bucket.value + excluded.value`,
            count: sql`metric_bucket.count + excluded.count`,
          }),
        )
        .execute();
    }
  },

  async reset(tx, metric) {
    await tx.deleteFrom('metric_bucket').where('metric', '=', metric).execute();
  },

  async query(tx, q) {
    // Granularity and dimension come from fixed enums, never from free input.
    const trunc = q.granularity ? sql.lit(q.granularity) : null;
    const dim = q.groupBy === 'store' ? sql.ref('store') : q.groupBy === 'channel' ? sql.ref('channel') : null;
    let s = tx
      .selectFrom('metric_bucket')
      .select([
        (trunc ? sql<string | null>`date_trunc(${trunc}, bucket AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` : sql<string | null>`NULL`).as('bucket'),
        (dim ? sql<string | null>`${dim}` : sql<string | null>`NULL`).as('key'),
        sql<string>`sum(value)`.as('value'),
        sql<string>`sum(count)`.as('count'),
      ])
      .where('metric', '=', q.metric)
      .where('bucket', '>=', q.from)
      .where('bucket', '<', q.to);
    if (q.filters.store?.length) s = s.where('store', 'in', q.filters.store);
    if (q.filters.channel?.length) s = s.where('channel', 'in', q.filters.channel);
    if (trunc) s = s.groupBy(sql`1`);
    if (dim) s = s.groupBy(sql`2`);
    if (trunc) s = s.orderBy(sql`1`);
    else if (dim) s = s.orderBy(sql`3`, 'desc');
    // Bounded: a 400-day range by hour is ~9600 rows; grouped tables are capped by `limit`.
    s = s.limit(q.limit ?? 10_000);
    const rows = await s.execute();
    return rows.map((r) => ({ bucket: r.bucket ? new Date(r.bucket).toISOString() : null, key: r.key ?? null, value: Number(r.value), count: Number(r.count) }));
  },

  async total(tx, metric) {
    const r = await tx.selectFrom('metric_bucket').select([sql<string>`coalesce(sum(value), 0)`.as('v'), sql<string>`coalesce(sum(count), 0)`.as('c')]).where('metric', '=', metric).executeTakeFirstOrThrow();
    return { value: Number(r.v), count: Number(r.c) };
  },
};
