/**
 * A Map with a maximum size and a time to live. Expired entries are evicted on write
 * (not only skipped on read), and the oldest entry is evicted when the cache is full,
 * so memory stays bounded whatever keys callers (or tenants) produce.
 */
export class BoundedCache<V> {
  private readonly entries = new Map<string, { at: number; value: V }>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { max: number; ttlMs: number; now?: () => number }) {
    if (opts.max < 1) throw new Error('max must be at least 1');
    this.max = opts.max;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V) {
    const now = this.now();
    this.entries.delete(key);
    for (const [k, e] of this.entries) if (now - e.at >= this.ttlMs) this.entries.delete(k);
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { at: now, value });
  }

  get size() {
    return this.entries.size;
  }
}
