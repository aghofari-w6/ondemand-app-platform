import { purgeExpiredFiles } from '../../adapters/pg-files.ts';
import type { Platform } from '../context.ts';
import { retentionAll } from '../governance.ts';
import { QUEUES } from '../queues.ts';
import { rebuildMetric, reconcileAll } from './metrics.ts';
import { runDueSchedules } from './reports.ts';

/** pg-boss workers and schedules for analytics, reports, retention and file expiry. */
export async function registerAnalyticsJobs(p: Platform) {
  await p.ports.jobs.work<{ tenantId: string; metric: string }>(QUEUES.metricRebuild, (data) => rebuildMetric(p, data));
  await p.ports.jobs.work(QUEUES.metricReconcile, () => reconcileAll(p));
  await p.ports.jobs.schedule(QUEUES.metricReconcile, '17 2 * * *');
  await p.ports.jobs.work(QUEUES.reportSchedules, async () => {
    await runDueSchedules(p);
  });
  await p.ports.jobs.schedule(QUEUES.reportSchedules, '* * * * *');
  await p.ports.jobs.work(QUEUES.retention, () => retentionAll(p));
  await p.ports.jobs.schedule(QUEUES.retention, '43 3 * * *');
  await p.ports.jobs.work(QUEUES.filesCleanup, async () => {
    const n = await purgeExpiredFiles(p.database);
    if (n) p.log.info({ files: n }, 'expired files deleted');
  });
  await p.ports.jobs.schedule(QUEUES.filesCleanup, '29 4 * * *');
}
