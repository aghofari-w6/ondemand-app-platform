import type { EventEnvelope, MetricSpec } from '@aod/shared';
import { describe, expect, it } from 'vitest';
import { csvLines } from './reports.ts';
import { pointsFor } from './metrics.ts';

const spec: MetricSpec = {
  id: 'pos:takings', label: 'Takings', app: 'pos', entity: 'sale', resource: 'pos::Sale', readPermission: 'pos:sale.read', aggregate: 'sum', field: 'total', unit: 'money',
  events: [{ type: 'sale.completed', value: 'total', time: 'sold_at' }, { type: 'sale.voided', value: '-total' }],
  dims: { store: 'store', channel: "'pos'" }, reconcile: null, version: 'v',
};
const ev = (type: string, data: Record<string, unknown>) => ({ id: 'e', type, tenant_id: 't', occurred_at: '2026-11-04T10:15:00Z', data }) as unknown as EventEnvelope;

describe('metric points', () => {
  it('maps events to points with value, time and dimensions', () => {
    expect(pointsFor(spec, ev('sale.completed', { total: 50, store: 'Kemang', sold_at: '2026-11-03T22:00:00Z' }))).toEqual([
      { tenantId: 't', metric: 'pos:takings', at: new Date('2026-11-03T22:00:00Z'), store: 'Kemang', channel: 'pos', value: 50, count: 1 },
    ]);
    const v = pointsFor(spec, ev('sale.voided', { total: 50, store: 'Kemang' }))[0]!;
    expect([v.value, v.count, v.at.toISOString()]).toEqual([-50, -1, '2026-11-04T10:15:00.000Z']);
    expect(pointsFor(spec, ev('order.created', { total: 1 }))).toEqual([]);
  });

  it('skips events whose data does not fit instead of failing the pipeline', () => {
    expect(pointsFor(spec, ev('sale.completed', { total: 'abc', store: 'K' }))).toEqual([]);
    expect(pointsFor(spec, ev('sale.completed', { total: 5, sold_at: 'not a date' }))[0]!.at.toISOString()).toBe('2026-11-04T10:15:00.000Z');
  });
});

describe('CSV export', () => {
  it('quotes cells and neutralises spreadsheet formulas', async () => {
    const out: string[] = [];
    for await (const l of csvLines({ columns: ['Store', 'Revenue'], rows: [['=HYPERLINK("x")', 5], ['A, "B"', -3]] })) out.push(l);
    expect(out.join('')).toBe('Store,Revenue\r\n"\'=HYPERLINK(""x"")",5\r\n"A, ""B""",-3\r\n');
  });
});
