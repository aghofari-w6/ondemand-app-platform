import pg from 'pg';
import { migrateAll } from '../src/db/migrate.ts';
import { ADMIN_URL, ADMIN_URL_ROOT, APP_URL, TEST_DB } from './env.ts';

/** Fresh test database, migrated exactly like production (owner role runs DDL). */
export default async function setup() {
  const c = new pg.Client({ connectionString: ADMIN_URL_ROOT });
  await c.connect();
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [TEST_DB]);
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.query(`CREATE DATABASE ${TEST_DB}`);
  await c.end();
  await migrateAll(ADMIN_URL, APP_URL, () => {});
}
