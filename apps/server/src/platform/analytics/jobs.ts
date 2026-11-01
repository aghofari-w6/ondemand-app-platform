import { sql } from 'kysely';
import { recordChange } from '../record.ts';
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
    await purgeExpiredFiles(p);
  });
  await p.ports.jobs.schedule(QUEUES.filesCleanup, '29 4 * * *');
}

/**
 * Deletes expired files, tenant by tenant, in bounded batches; each batch is audited
 * (ids and purposes, no content). The definer function lists tenant ids only.
 */
export async function purgeExpiredFiles(p: Platform) {
  const tenants = (await sql<{ tenant_id: string }>`SELECT tenant_id FROM expired_file_tenants()`.execute(p.database.db)).rows;
  let total = 0;
  for (const { tenant_id: tenantId } of tenants) {
    for (let i = 0; i < 100; i++) {
      const n = await p.database.withTenant(tenantId, async (tx) => {
        const ids = await tx.selectFrom('file_object').select('id').where('expires_at', '<', new Date()).limit(500).execute();
        const gone = ids.length ? await tx.deleteFrom('file_object').where('id', 'in', ids.map((r) => r.id as string)).returning(['id', 'purpose']).execute() : [];
        if (gone.length) {
          await recordChange(p, tx, {
            tenantId,
            actor: { type: 'System', id: 'files' },
            action: 'platform:files.expired',
            resourceType: 'platform::File',
            resourceId: 'expired',
            correlationId: `files-cleanup:${tenantId}:${new Date().toISOString().slice(0, 10)}`,
            events: [{ type: 'files.expired', data: { files: gone.length } }],
            data: { files: gone.map((g) => ({ id: g.id, purpose: g.purpose })) },
          });
        }
        return gone.length;
      });
      total += n;
      if (n < 500) break;
    }
  }
  if (total) p.log.info({ files: total }, 'expired files deleted');
  return total;
}
