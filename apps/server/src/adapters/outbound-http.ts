import { Agent, fetch, type Response } from 'undici';
import type { OutboundHttp, RateLimit, Realtime } from '../ports/index.ts';
import { BoundedCache } from './bounded-cache.ts';
import { checkHost, safeLookup, type SsrfPolicy } from './ssrf.ts';

const TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class ResponseTooLarge extends Error {
  constructor(maxBytes: number) {
    super(`the response is larger than ${maxBytes} bytes`);
    this.name = 'ResponseTooLarge';
  }
}

/** Reads a body up to `maxBytes`; a larger body fails instead of being held in memory. */
async function* capped(res: Response, maxBytes: number, cleanupFailed: (e: unknown) => void): AsyncIterable<Uint8Array> {
  if (!res.body) return;
  const reader = res.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.length;
      if (size > maxBytes) throw new ResponseTooLarge(maxBytes);
      yield value;
    }
  } finally {
    // Stops the transfer whether the consumer finished, stopped early or failed.
    await reader.cancel().catch(cleanupFailed);
  }
}

/**
 * API client for platform-configured services (Telegram, Google, Voyage). Same outbound
 * policy as Hub deliveries: https only (http for allow-listed dev/test hosts), every
 * connection resolved through the private-address check, redirects not followed,
 * connect/headers/body timeouts, and a byte cap on every response.
 */
export function createOutboundHttp(policy: SsrfPolicy, log: (msg: string, err: unknown) => void = (msg, err) => console.warn(msg, String(err))): OutboundHttp {
  // Cleanup failures never fail the call, but they are logged, not swallowed.
  const cleanupFailed = (e: unknown) => log('outbound http: cancelling a response body failed', e);
  // One agent (connection pool) per process.
  const agent = new Agent({ connect: { lookup: safeLookup(policy) as any, timeout: TIMEOUT_MS }, headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });
  const check = async (raw: string) => {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && policy.allow.has(u.hostname.toLowerCase()))) throw new Error('API URLs must use https');
    await checkHost(u.hostname, policy);
  };
  const call = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    await check(url);
    return fetch(url, { method: init.method ?? 'GET', headers: { 'user-agent': 'apps-on-demand/1', ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}), dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  };
  return {
    async json(req) {
      const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
      let body: string | undefined;
      if (req.form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(req.form).toString();
      } else if (req.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(req.body);
      }
      const res = await call(req.url, { method: req.method ?? (body === undefined ? 'GET' : 'POST'), headers, ...(body !== undefined ? { body } : {}) });
      const chunks: Uint8Array[] = [];
      for await (const c of capped(res, req.maxBytes ?? DEFAULT_MAX_BYTES, cleanupFailed)) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      const ra = Number(res.headers.get('retry-after'));
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: parsed, retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : null };
    },
    async stream(req) {
      const res = await call(req.url, { ...(req.headers ? { headers: req.headers } : {}) });
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: capped(res, req.maxBytes, cleanupFailed) };
    },
  };
}

/** Fixed-window counters in a bounded map: per-visitor and per-tenant widget limits. */
export function createRateLimit(now: () => number = Date.now): RateLimit {
  const windows = new BoundedCache<{ start: number; n: number }>({ max: 50_000, ttlMs: 10 * 60_000, now });
  return {
    take(key, limit, windowMs) {
      const t = now();
      const w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        windows.set(key, { start: t, n: 1 });
        return limit >= 1;
      }
      if (w.n >= limit) return false;
      w.n++;
      return true;
    },
  };
}

/**
 * In-process notifications for open SSE streams. Each topic has a version counter (bounded
 * and expiring); a waiter compares it with its stream's cursor, so a publish between two
 * waits is seen by the next wait. Waiters always time out and remove themselves, so an
 * abandoned stream leaves nothing behind.
 */
export function createRealtime(): Realtime {
  const waiters = new Map<string, Set<() => void>>();
  const versions = new BoundedCache<number>({ max: 100_000, ttlMs: 60 * 60_000 });
  return {
    publish(topic) {
      versions.set(topic, (versions.get(topic) ?? 0) + 1);
      const set = waiters.get(topic);
      if (!set) return;
      for (const wake of [...set]) wake();
    },
    wait(topics, timeoutMs, signal, cursor) {
      const moved = () => {
        let any = false;
        for (const t of topics) {
          const v = versions.get(t) ?? 0;
          if (cursor.has(t) && cursor.get(t) !== v) any = true;
          cursor.set(t, v);
        }
        return any;
      };
      return new Promise<boolean>((resolve) => {
        if (signal.aborted) return resolve(false);
        if (moved()) return resolve(true);
        let timer: NodeJS.Timeout | null = null;
        const done = (published: boolean) => {
          if (timer) clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          for (const t of topics) {
            const set = waiters.get(t);
            set?.delete(wake);
            if (set && set.size === 0) waiters.delete(t);
          }
          if (published) moved();
          resolve(published);
        };
        const wake = () => done(true);
        const onAbort = () => done(false);
        timer = setTimeout(() => done(false), timeoutMs);
        signal.addEventListener('abort', onAbort, { once: true });
        for (const t of topics) {
          if (!waiters.has(t)) waiters.set(t, new Set());
          waiters.get(t)!.add(wake);
        }
      });
    },
  };
}
