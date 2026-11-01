import { PgBoss } from 'pg-boss';
import type { Jobs } from '../ports/index.ts';

/** Jobs port on pg-boss (schema `pgboss`, created by the migrate script). */
export function createPgBossJobs(connectionString: string, log: (m: string) => void, opts: { pollingIntervalSeconds?: number } = {}): Jobs {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', createSchema: false, migrate: false, max: 4, application_name: 'aod-jobs' });
  boss.on('error', (e: Error) => log(`pg-boss: ${e.message}`));
  let started = false;
  return {
    async start() {
      if (!started) await boss.start();
      started = true;
    },
    async stop() {
      if (started) await boss.stop({ graceful: true, timeout: 5000 });
      started = false;
    },
    send: (queue, data, o = {}) => boss.send(queue, data, o),
    async work(queue, handler) {
      await boss.work<any>(queue, { batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 1 }, async (jobs: any[]) => {
        for (const job of jobs) await handler(job.data, { id: job.id, retryCount: job.retryCount ?? 0 });
      });
    },
    schedule: (queue, cron, data) => boss.schedule(queue, cron, data ?? {}),
  };
}
