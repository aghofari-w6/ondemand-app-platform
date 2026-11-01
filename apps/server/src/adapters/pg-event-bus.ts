import type { EventEnvelope } from '@aod/shared';
import { sql } from 'kysely';
import type pg from 'pg';
import type { Database } from '../db/database.ts';
import type { Consumer, EventBus, Metrics } from '../ports/index.ts';

/** Advisory lock key held by the single active dispatcher ("relay leader"). */
export const RELAY_LOCK_KEY = 0x414f44; // 'AOD'

interface Options {
  database: Database;
  metrics: Metrics;
  log: { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  intervalMs: number;
  batchSize?: number;
}

/**
 * EventBus on PostgreSQL.
 *
 * 1. Relay: committed `outbox_event` rows are moved into `event_log` (FOR UPDATE SKIP
 *    LOCKED) by exactly one process — the holder of a session advisory lock. Other
 *    instances stay idle and retry the lock.
 * 2. Delivery: each consumer has a cursor in `consumer_cursor`. For every event it
 *    inserts into `processed_event` (dedup), runs the handler, and advances its cursor
 *    in ONE tenant-scoped transaction, so a crash at any point neither loses nor
 *    duplicates effects.
 */
export class PgEventBus implements EventBus {
  private consumers: Consumer[] = [];
  private lockClient: pg.PoolClient | null = null;
  /** lock clients already returned to the pool (a client may error after we released it) */
  private released = new WeakSet<pg.PoolClient>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking: Promise<void> | null = null;
  private failures = new Map<string, number>();
  private readonly o: Options;

  constructor(o: Options) {
    this.o = o;
  }

  subscribe(c: Consumer) {
    if (this.consumers.some((x) => x.name === c.name)) throw new Error(`consumer ${c.name} already subscribed`);
    this.consumers.push(c);
  }

  isLeader() {
    return this.lockClient !== null;
  }

  async start() {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      this.ticking = this.tick().catch((e) => this.o.log.error({ err: e }, 'event bus tick failed'));
      await this.ticking;
      this.ticking = null;
      if (this.running) this.timer = setTimeout(() => {
          loop().catch((e) => this.o.log.error({ err: e }, 'event bus loop failed'));
        }, this.o.intervalMs);
    };
    await loop();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.ticking) await this.ticking;
    await this.releaseLock();
  }

  async drain() {
    for (let i = 0; i < 100; i++) {
      if (!(await this.tryLead())) throw new Error('another instance holds the relay lock');
      const moved = await this.relay();
      const delivered = await this.deliverAll();
      if (moved === 0 && delivered === 0) return;
    }
  }

  private async tryLead(): Promise<boolean> {
    if (this.lockClient) return true;
    const client = await this.o.database.pool.connect();
    try {
      const r = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [RELAY_LOCK_KEY]);
      if (r.rows[0]?.ok) {
        // A broken lock connection is given back to the pool (destroyed), never just
        // forgotten: forgetting it would leak one pool slot per lost connection.
        client.on('error', (err) => {
          if (this.lockClient === client) this.lockClient = null;
          this.dropClient(client, err);
        });
        this.lockClient = client;
        this.o.log.info({}, 'event bus: acquired relay lock (leader)');
        return true;
      }
    } catch (e) {
      client.release(true);
      throw e;
    }
    client.release();
    return false;
  }

  /** Returns a lock client to the pool exactly once (`err` destroys the connection). */
  private dropClient(c: pg.PoolClient, err?: Error | boolean) {
    if (this.released.has(c)) return;
    this.released.add(c);
    c.release(err);
  }

  private async releaseLock() {
    const c = this.lockClient;
    this.lockClient = null;
    if (!c) return;
    try {
      await c.query('SELECT pg_advisory_unlock($1)', [RELAY_LOCK_KEY]);
      this.dropClient(c);
    } catch {
      this.dropClient(c, true);
    }
  }

  private async tick() {
    if (!(await this.tryLead())) return;
    // Verify the lock connection is alive; if not, give up leadership.
    try {
      await this.lockClient!.query('SELECT 1');
    } catch {
      const c = this.lockClient;
      this.lockClient = null;
      if (c) this.dropClient(c, true);
      return;
    }
    await this.relay();
    await this.deliverAll();
  }

  private async relay(): Promise<number> {
    let total = 0;
    for (;;) {
      const r = await sql<{ n: number }>`SELECT outbox_relay(${this.o.batchSize ?? 500}) AS n`.execute(this.o.database.db);
      const n = Number(r.rows[0]?.n ?? 0);
      total += n;
      if (n < (this.o.batchSize ?? 500)) break;
    }
    if (total) this.o.metrics.increment('aod_events_relayed_total', {}, total);
    return total;
  }

  private async deliverAll(): Promise<number> {
    let n = 0;
    for (const c of this.consumers) n += await this.deliver(c);
    return n;
  }

  private async deliver(c: Consumer): Promise<number> {
    const { db } = this.o.database;
    await db.insertInto('consumer_cursor').values({ consumer: c.name, last_seq: 0 }).onConflict((oc) => oc.column('consumer').doNothing()).execute();
    const cur = await db.selectFrom('consumer_cursor').select('last_seq').where('consumer', '=', c.name).executeTakeFirstOrThrow();
    let last = Number(cur.last_seq);
    let handled = 0;
    const rows = await sql<{ seq: number; id: string; tenant_id: string; type: string; payload: EventEnvelope }>`
      SELECT * FROM event_log_after(${last}, 200)`.execute(db);
    for (const ev of rows.rows) {
      if (!c.types.includes(ev.type) && !c.types.includes('*')) {
        last = ev.seq;
        continue;
      }
      // Advance past skipped (non-matching) events first, then handle this one atomically.
      try {
        await this.o.database.withTenant(ev.tenant_id, async (tx) => {
          const fresh = await tx
            .insertInto('processed_event')
            .values({ consumer: c.name, event_id: ev.id, tenant_id: ev.tenant_id })
            .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
            .returning('event_id')
            .executeTakeFirst();
          if (fresh && (await c.handle(ev.payload, tx)) === 'skipped') {
            await tx.deleteFrom('processed_event').where('consumer', '=', c.name).where('event_id', '=', ev.id).execute();
          }
          await tx.updateTable('consumer_cursor').set({ last_seq: ev.seq, updated_at: new Date() }).where('consumer', '=', c.name).execute();
        });
        this.failures.delete(`${c.name}:${ev.id}`);
        last = ev.seq;
        handled++;
      } catch (e) {
        const k = `${c.name}:${ev.id}`;
        const n = (this.failures.get(k) ?? 0) + 1;
        this.failures.set(k, n);
        this.o.metrics.increment('aod_consumer_failures_total', { consumer: c.name });
        this.o.log.error({ err: e, consumer: c.name, event: ev.id, type: ev.type, attempt: n }, 'consumer failed; will retry');
        // Head-of-line: stop this consumer for this tick, retry next tick.
        await this.saveCursor(c.name, last);
        return handled;
      }
    }
    await this.saveCursor(c.name, last);
    return handled;
  }

  private async saveCursor(consumer: string, last: number) {
    await this.o.database.db
      .updateTable('consumer_cursor')
      .set({ last_seq: last, updated_at: new Date() })
      .where('consumer', '=', consumer)
      .where('last_seq', '<', last)
      .execute();
  }
}
