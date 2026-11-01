import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgEventBus } from '../src/adapters/pg-event-bus.ts';
import { createMetrics } from '../src/adapters/index.ts';
import { createDatabase } from '../src/db/database.ts';
import { APP_URL } from './env.ts';
import { SINK_SCHEMA, sinkConsumer } from './fixtures/sink.ts';
import { admin, closePlatform, silent, testPlatform } from './helpers.ts';

const p = testPlatform();
p.ports.eventBus.subscribe(sinkConsumer);
let db: pg.Pool;
const tenants = [randomUUID(), randomUUID()];

beforeAll(async () => {
  db = admin();
  await db.query(SINK_SCHEMA);
});

afterAll(async () => {
  await db.query('DROP SCHEMA IF EXISTS outbox_test CASCADE');
  await db.end();
  await closePlatform(p);
});

function runWriterAndKill(minWrites: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/outbox-writer.ts', import.meta.url))], {
      env: { ...process.env, APP_URL, TENANTS: tenants.join(',') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let writes = 0;
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d: Buffer) => {
      writes += d.length;
      // Kill at an arbitrary point after enough traffic: mid-transaction, mid-relay or mid-delivery.
      if (writes >= minWrites && !child.killed) child.kill('SIGKILL');
    });
    child.on('exit', (code, signal) => (signal === 'SIGKILL' ? resolve(writes) : reject(new Error(`writer exited ${code}: ${err}`))));
  });
}

describe('outbox + dispatcher', () => {
  it('a process killed mid-write neither loses nor duplicates events', async () => {
    const writes = await runWriterAndKill(300 + Math.floor(Math.random() * 300));
    expect(writes).toBeGreaterThan(300);

    // A fresh instance takes over the relay lock (released when the killed session dropped).
    for (let i = 0; ; i++) {
      try {
        await p.ports.eventBus.drain();
        break;
      } catch (e) {
        if (i > 50) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const q = async (s: string) => Number((await db.query(s, [tenants])).rows[0].n);
    const source = await q(`SELECT count(*) AS n FROM outbox_test.source WHERE tenant_id = ANY($1)`);
    const outbox = await q(`SELECT count(*) AS n FROM outbox_event o JOIN outbox_test.source s ON s.id::text = o.aggregateid WHERE o.tenant_id = ANY($1)`);
    const orphanOutbox = await q(`SELECT count(*) AS n FROM outbox_event o WHERE o.type = 'test.written' AND o.tenant_id = ANY($1) AND NOT EXISTS (SELECT 1 FROM outbox_test.source s WHERE s.id::text = o.aggregateid)`);
    const pending = await q(`SELECT count(*) AS n FROM outbox_event WHERE tenant_id = ANY($1) AND relayed_at IS NULL`);
    const logged = await q(`SELECT count(*) AS n FROM event_log WHERE type = 'test.written' AND tenant_id = ANY($1)`);
    const delivered = await q(`SELECT count(*) AS n FROM outbox_test.sink WHERE tenant_id = ANY($1)`);
    const distinct = await q(`SELECT count(DISTINCT event_id) AS n FROM outbox_test.sink WHERE tenant_id = ANY($1)`);
    const processed = await q(`SELECT count(*) AS n FROM processed_event WHERE consumer = 'test.sink' AND tenant_id = ANY($1)`);

    expect(source).toBeGreaterThan(200);
    expect({ outbox, orphanOutbox, pending, logged, delivered, distinct, processed }).toEqual({ outbox: source, orphanOutbox: 0, pending: 0, logged: source, delivered: source, distinct: source, processed: source });
    // The log is gap-free in commit order per relay: seq is strictly increasing with no duplicates.
    const dupSeq = await q(`SELECT count(*) AS n FROM (SELECT seq FROM event_log WHERE tenant_id = ANY($1) GROUP BY seq HAVING count(*) > 1) x`);
    expect(dupSeq).toBe(0);
  }, 60_000);

  it('a second instance stays idle while the first holds the relay lock', async () => {
    const mk = () => new PgEventBus({ database: p.database, metrics: createMetrics(), log: silent, intervalMs: 20 });
    const first = mk();
    const second = mk();
    try {
      // The suite's own bus took the lock in drain(): newcomers must stay idle.
      expect(p.ports.eventBus.isLeader()).toBe(true);
      await first.start();
      expect(first.isLeader()).toBe(false);
      await p.ports.eventBus.stop();
      await new Promise((r) => setTimeout(r, 150));
      expect(first.isLeader()).toBe(true);
      await second.start();
      await new Promise((r) => setTimeout(r, 100));
      expect(second.isLeader()).toBe(false);
      await first.stop();
      await new Promise((r) => setTimeout(r, 150));
      expect(second.isLeader()).toBe(true);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it('gives a broken relay-lock connection back to the pool instead of leaking the slot', async () => {
    const database = createDatabase(APP_URL, { max: 2 });
    const bus = new PgEventBus({ database, metrics: createMetrics(), log: silent, intervalMs: 20 });
    try {
      expect(await (bus as any).tryLead()).toBe(true);
      expect(database.pool.totalCount).toBe(1);
      (bus as any).lockClient.emit('error', new Error('connection lost'));
      expect(bus.isLeader()).toBe(false);
      expect(database.pool.totalCount).toBe(0); // destroyed, not held forever
      expect(await (bus as any).tryLead()).toBe(true); // the lock died with the session
      expect(database.pool.totalCount).toBe(1);
    } finally {
      await bus.stop();
      await database.close();
    }
  });
});
