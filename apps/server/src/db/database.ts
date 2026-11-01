import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

// numeric -> number, int8 -> number (counts); timestamps stay Date
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = Kysely<any>;
export type Tx = Transaction<any>;

export interface Database {
  db: Db;
  pool: pg.Pool;
  /** Run `fn` in a transaction scoped to one tenant (`SET LOCAL app.tenant_id`). RLS does the rest. */
  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** A transaction with no tenant context: tenant tables read as empty. */
  withoutTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setTenant(tx: Tx, tenantId: string) {
  if (!UUID.test(tenantId)) throw new Error('invalid tenant id');
  await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
}

export function createDatabase(connectionString: string, opts: { max?: number; applicationName?: string } = {}): Database {
  const pool = new pg.Pool({ connectionString, max: opts.max ?? 10, application_name: opts.applicationName ?? 'aod' });
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    withTenant: (tenantId, fn) =>
      db.transaction().execute(async (tx) => {
        await setTenant(tx, tenantId);
        return fn(tx);
      }),
    withoutTenant: (fn) => db.transaction().execute(fn),
    close: () => db.destroy(),
  };
}

export const newId = () => randomUUID();
