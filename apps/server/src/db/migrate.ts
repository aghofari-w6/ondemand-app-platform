import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { loadEnv, ROOT } from '../config.ts';
import { ALL_QUEUES } from '../platform/queues.ts';
import { TEMPLATES } from '../platform/templates.ts';

/**
 * Applies platform migrations, then every template's migrations (each template has
 * its own migrations table), installs the pg-boss schema and queues, and grants the
 * app role what it needs. Runs as the owner role; the app itself never runs DDL.
 */
export async function migrateAll(adminUrl: string, appUrl: string, log: (m: string) => void = console.log) {
  const quiet = { log: () => {}, info: () => {}, warn: (m: string) => log(m), error: (m: string) => log(m), debug: () => {} };
  const base = { databaseUrl: adminUrl, direction: 'up' as const, count: Infinity, checkOrder: true, logger: quiet, verbose: false };
  const done = await runner({ ...base, dir: `${ROOT}db/migrations`, migrationsTable: 'pgmigrations' });
  log(`platform: ${done.length} migration(s) applied`);
  for (const t of TEMPLATES) {
    const ran = await runner({ ...base, dir: `${t.dir}migrations`, migrationsTable: `pgmigrations_${t.id}` });
    log(`${t.id}: ${ran.length} migration(s) applied`);
  }

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const app = new URL(appUrl);
    if (decodeURIComponent(app.username) !== 'aod_app') throw new Error('DATABASE_URL must connect as aod_app');
    const password = decodeURIComponent(app.password);
    if (password) await client.query(`ALTER ROLE aod_app PASSWORD ${pg.escapeLiteral(password)}`);
    // pg-boss lives in its own schema owned by the app role: it creates partitions at
    // runtime, and the schema holds no tenant data.
    await client.query(`CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION aod_app`);
    await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM aod_app`);
    const r = await client.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'aod_app'`);
    if (r.rows[0]?.rolbypassrls || r.rows[0]?.rolsuper) throw new Error('aod_app must not have BYPASSRLS or SUPERUSER');
  } finally {
    await client.end();
  }

  const boss = new PgBoss({ connectionString: appUrl, schema: 'pgboss', createSchema: false, supervise: false, schedule: false });
  boss.on('error', (e) => log(`pg-boss: ${e.message}`));
  await boss.start();
  for (const q of ALL_QUEUES) {
    if (!(await boss.getQueue(q))) await boss.createQueue(q, { retryLimit: 2, retryDelay: 1, retryBackoff: true });
  }
  await boss.stop({ graceful: false });
  log('pg-boss: schema and queues ready');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  migrateAll(env.MIGRATION_DATABASE_URL, env.DATABASE_URL)
    .then(() => console.log('migrations complete'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
