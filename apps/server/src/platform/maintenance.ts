import { CommandError } from '@aod/shared';
import { sql } from 'kysely';
import pg from 'pg';
import type { Tx } from '../db/database.ts';
import type { Platform } from './context.ts';
import { publishedDefinition, targetFor } from './datastudio.ts';
import { decryptValue, encryptValue, isEncrypted } from './fields.ts';
import { recordChange } from './record.ts';

/**
 * Work started by a Data studio publish: backfill jobs (pg-boss) and per-tenant
 * expression indexes built with CREATE INDEX CONCURRENTLY.
 */

const BATCH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9_]{0,40}$/;

export async function runBackfill(p: Platform, job: { tenantId: string; runId: string }) {
  const { tenantId, runId } = job;
  const run = await p.database.withTenant(tenantId, async (tx) => {
    const r = await tx.selectFrom('backfill_run').selectAll().where('id', '=', runId).executeTakeFirst();
    if (!r || r.status === 'done') return null;
    await tx.updateTable('backfill_run').set({ status: 'running' }).where('id', '=', runId).execute();
    return r;
  });
  if (!run) return;
  const t = targetFor(p, run.target);
  if (!t || !KEY.test(run.field)) throw new CommandError(500, 'bad_backfill', `invalid backfill target ${run.target}.${run.field}`);
  const col = sql.ref(t.column);
  const key = run.field as string;
  try {
    let after = '00000000-0000-0000-0000-000000000000';
    let processed = 0;
    for (;;) {
      const n = await p.database.withTenant(tenantId, async (tx) => {
        const field = await currentField(tx, run.target, key);
        let q = sql<{ id: string; v: unknown }>`SELECT id, ${col} -> ${key} AS v FROM ${sql.table(t.table)} WHERE id > ${after}`;
        if (t.entity) q = sql<{ id: string; v: unknown }>`${q} AND entity = ${t.entity}`;
        const rows = (await sql<{ id: string; v: unknown }>`${q} ORDER BY id LIMIT ${BATCH}`.execute(tx)).rows;
        for (const r of rows) {
          let next: unknown = undefined;
          if (run.kind === 'encrypt' && r.v !== null && r.v !== undefined && !isEncrypted(r.v)) next = encryptValue(p.ports.vault, tenantId, run.target, key, r.v);
          if (run.kind === 'decrypt' && isEncrypted(r.v)) next = decryptValue(p.ports.vault, tenantId, run.target, key, r.v);
          if (run.kind === 'set_default' && (r.v === null || r.v === undefined) && field?.default !== null && field?.default !== undefined) {
            next = field.pii ? encryptValue(p.ports.vault, tenantId, run.target, key, field.default) : field.default;
          }
          if (next !== undefined) {
            await sql`UPDATE ${sql.table(t.table)} SET ${col} = jsonb_set(${col}, ${sql.lit(`{${key}}`)}::text[], ${JSON.stringify(next)}::jsonb) WHERE id = ${r.id}`.execute(tx);
          }
        }
        if (rows.length) after = rows[rows.length - 1]!.id;
        await tx.updateTable('backfill_run').set({ processed: sql`processed + ${rows.length}` }).where('id', '=', runId).execute();
        return rows.length;
      });
      processed += n;
      if (n < BATCH) break;
    }
    await p.database.withTenant(tenantId, async (tx) => {
      await tx.updateTable('backfill_run').set({ status: 'done', finished_at: new Date() }).where('id', '=', runId).execute();
      await recordChange(p, tx, {
        tenantId,
        actor: { type: 'System', id: 'backfill' },
        action: 'platform:metadata.backfilled',
        resourceType: 'platform::Backfill',
        resourceId: runId,
        correlationId: `backfill:${runId}`,
        events: [{ type: 'metadata.backfill_completed', data: { run_id: runId, target: run.target, field: key, kind: run.kind, processed } }],
      });
    });
  } catch (e) {
    await p.database.withTenant(tenantId, (tx) => tx.updateTable('backfill_run').set({ status: 'failed', error: (e as Error).message }).where('id', '=', runId).execute());
    throw e;
  }
}

async function currentField(tx: Tx, target: string, key: string) {
  const { definition } = await publishedDefinition(tx);
  if (target.startsWith('custom:')) return definition.entities.find((e) => `custom:${e.key}` === target)?.fields.find((f) => f.key === key) ?? null;
  return definition.app_fields.find((s) => `${s.app}:${s.entity}` === target)?.fields.find((f) => f.key === key) ?? null;
}

/**
 * Builds and drops per-tenant expression indexes. CREATE INDEX CONCURRENTLY cannot run
 * in a transaction or a function and needs table ownership, so this one job uses the
 * owner connection (INDEX_DATABASE_URL). Every identifier in the DDL comes from the
 * catalog or is validated (uuid, field key), and only CREATE/DROP INDEX is ever issued.
 */
export class IndexBuilder {
  private readonly p: Platform;
  private readonly ownerUrl: string;
  constructor(p: Platform, ownerUrl: string) {
    this.p = p;
    this.ownerUrl = ownerUrl;
  }

  static ddl(r: { op: string; tenant_id: string; index_name: string; field: string }, t: { table: string; column: string; entity?: string | undefined }): string {
    if (!UUID.test(r.tenant_id) || !KEY.test(r.field) || !/^cfx_[0-9a-f]{24}$/.test(r.index_name) || !/^[a-z][a-z0-9_]*$/.test(t.table)) throw new Error('refusing unsafe index DDL');
    if (r.op === 'drop') return `DROP INDEX CONCURRENTLY IF EXISTS ${r.index_name}`;
    const where = `tenant_id = '${r.tenant_id}'${t.entity ? ` AND entity = '${t.entity.replace(/[^a-z0-9_]/g, '')}'` : ''}`;
    return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${r.index_name} ON ${t.table} ((${t.column} ->> '${r.field}')) WHERE ${where}`;
  }

  async runPending(): Promise<number> {
    const pending = (await sql<{ tenant_id: string; id: string }>`SELECT * FROM index_requests_pending(10)`.execute(this.p.database.db)).rows;
    for (const job of pending) {
      const r = await this.p.database.withTenant(job.tenant_id, async (tx) => {
        const row = await tx.updateTable('index_request').set({ status: 'building' }).where('id', '=', job.id).where('status', '=', 'pending').returningAll().executeTakeFirst();
        return (row as { id: string; op: string; tenant_id: string; index_name: string; field: string; target: string } | undefined) ?? null;
      });
      if (!r) continue;
      const client = new pg.Client({ connectionString: this.ownerUrl, application_name: 'aod-index-builder' });
      let status: 'ready' | 'failed' = 'ready';
      let error: string | null = null;
      try {
        const t = targetFor(this.p, r.target);
        if (!t) throw new Error(`unknown target ${r.target}`);
        await client.connect();
        await client.query(IndexBuilder.ddl(r, t));
        if (r.op === 'create') {
          const v = await client.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, [r.index_name]);
          if (!v.rows[0]?.indisvalid) {
            await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${r.index_name}`);
            throw new Error('index build left an invalid index; dropped');
          }
        }
      } catch (e) {
        status = 'failed';
        error = (e as Error).message;
      } finally {
        await client.end().catch((e: unknown) => this.p.log.warn({ err: String(e) }, 'index builder: closing the owner connection failed'));
      }
      await this.p.database.withTenant(job.tenant_id, (tx) => tx.updateTable('index_request').set({ status, error, finished_at: new Date() }).where('id', '=', r.id).execute());
    }
    return pending.length;
  }
}
