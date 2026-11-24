/** pg-boss queues. Created by the migrate script (owner role) so the app needs no DDL. */
export const QUEUES = {
  provisionStep: 'provision-step',
  lifecycleSweep: 'lifecycle-sweep',
  tenantLifecycle: 'tenant-lifecycle',
  backfill: 'metadata-backfill',
  metricRebuild: 'analytics-metric-rebuild',
  metricReconcile: 'analytics-reconcile',
  reportSchedules: 'analytics-report-schedules',
  retention: 'governance-retention',
  filesCleanup: 'files-cleanup',
  knowledgeIndex: 'knowledge-index',
  knowledgeSweep: 'knowledge-sweep',
  assistantResume: 'assistant-resume',
  botTurn: 'bot-turn',
  gmailSchedule: 'gmail-schedule',
  gmailPoll: 'gmail-poll',
} as const;
export const ALL_QUEUES = Object.values(QUEUES);
