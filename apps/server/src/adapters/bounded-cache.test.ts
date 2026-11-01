import { describe, expect, it } from 'vitest';
import { BoundedCache } from './bounded-cache.ts';

describe('BoundedCache', () => {
  it('never grows past max (oldest evicted first)', () => {
    const c = new BoundedCache<number>({ max: 3, ttlMs: 60_000 });
    for (let i = 0; i < 1000; i++) c.set(`k${i}`, i);
    expect(c.size).toBe(3);
    expect(c.get('k0')).toBeUndefined();
    expect(c.get('k999')).toBe(999);
  });

  it('evicts expired entries on write, not only on read', () => {
    let now = 0;
    const c = new BoundedCache<string>({ max: 100, ttlMs: 1000, now: () => now });
    for (let i = 0; i < 50; i++) c.set(`k${i}`, 'v');
    expect(c.size).toBe(50);
    now = 1000;
    c.set('fresh', 'v');
    expect(c.size).toBe(1);
    expect(c.get('fresh')).toBe('v');
    now = 2500;
    expect(c.get('fresh')).toBeUndefined();
    expect(c.size).toBe(0);
  });
});
