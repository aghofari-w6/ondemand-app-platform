import { describe, expect, it } from 'vitest';
import { AnalyticsQuery, nextRunAt, resolveRange } from './analytics.ts';

describe('analytics helpers', () => {
  it('computes the next scheduled run strictly after a time (UTC)', () => {
    const at = new Date('2026-11-04T07:30:00Z'); // a Wednesday
    expect(nextRunAt({ every: 'day', hour: 6, format: 'csv', deliver: 'file' }, at).toISOString()).toBe('2026-11-05T06:00:00.000Z');
    expect(nextRunAt({ every: 'day', hour: 9, format: 'csv', deliver: 'file' }, at).toISOString()).toBe('2026-11-04T09:00:00.000Z');
    expect(nextRunAt({ every: 'week', weekday: 1, hour: 6, format: 'pdf', deliver: 'file' }, at).toISOString()).toBe('2026-11-09T06:00:00.000Z');
    expect(nextRunAt({ every: 'month', day: 1, hour: 6, format: 'csv', deliver: 'file' }, at).toISOString()).toBe('2026-12-01T06:00:00.000Z');
    expect(nextRunAt({ every: 'month', day: 28, hour: 6, format: 'csv', deliver: 'file' }, new Date('2026-12-28T06:00:00Z')).toISOString()).toBe('2027-01-28T06:00:00.000Z');
  });

  it('resolves relative ranges with an exclusive end', () => {
    const now = new Date('2026-11-04T07:30:00Z');
    expect(resolveRange('today', now)).toEqual({ from: new Date('2026-11-04T00:00:00Z'), to: new Date('2026-11-05T00:00:00Z') });
    expect(resolveRange('last_7_days', now).from).toEqual(new Date('2026-10-29T00:00:00Z'));
    expect(resolveRange('last_month', now)).toEqual({ from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') });
  });

  it('caps query ranges (bounded reads) and rejects inverted or absurd dates', () => {
    const base = { metric: 'ordering:revenue', filters: {} };
    expect(AnalyticsQuery.safeParse({ ...base, from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }).success).toBe(true);
    expect(AnalyticsQuery.safeParse({ ...base, from: '2024-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }).success).toBe(false);
    expect(AnalyticsQuery.safeParse({ ...base, from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success).toBe(false);
    expect(AnalyticsQuery.safeParse({ ...base, from: '9998-01-01T00:00:00Z', to: '9999-01-01T00:00:00Z' }).success).toBe(false);
  });
});
