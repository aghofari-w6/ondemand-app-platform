import { resumeConversation } from '../assistant/agent.ts';
import { handleBotTurn } from '../bot/runner.ts';
import type { Platform } from '../context.ts';
import { indexPending, indexSource } from '../knowledge.ts';
import { QUEUES } from '../queues.ts';
import { pollDueMailboxes } from './channels.ts';

/**
 * pg-boss workers for Milestone E: knowledge indexing (and its backfill sweep), assistant
 * continuations after an approval, bot turns, and Gmail polling.
 *
 * Gmail: pg-boss cron fires once a minute, so each firing queues one poll per
 * GMAIL_POLL_SECONDS across that minute (default every 30 s). A poll claims the mailboxes
 * that are due, so overlapping jobs never poll one mailbox twice.
 */
export async function registerConversationJobs(p: Platform, opts: { schedules: boolean }) {
  const { jobs } = p.ports;
  await jobs.work<{ tenantId: string; sourceId: string }>(QUEUES.knowledgeIndex, (d) => indexSource(p, d));
  await jobs.work(QUEUES.knowledgeSweep, async () => {
    await indexPending(p);
  });
  await jobs.work<{ tenantId: string; conversationId: string }>(QUEUES.assistantResume, async (d) => {
    await resumeConversation(p, d);
  });
  await jobs.work<{ tenantId: string; conversationId: string; messageId: string }>(QUEUES.botTurn, (d) => handleBotTurn(p, d));
  await jobs.work(QUEUES.gmailPoll, async () => {
    await pollDueMailboxes(p);
  });
  await jobs.work(QUEUES.gmailSchedule, async () => {
    const every = Math.min(Math.max(p.env.GMAIL_POLL_SECONDS, 1), 60);
    for (let at = 0; at < 60; at += every) await jobs.send(QUEUES.gmailPoll, {}, at ? { startAfter: at } : {});
  });
  if (!opts.schedules) return;
  await jobs.schedule(QUEUES.knowledgeSweep, '*/5 * * * *');
  await jobs.schedule(QUEUES.gmailSchedule, '* * * * *');
  // Do not wait for the first cron minute after a start.
  await jobs.send(QUEUES.gmailSchedule, {});
}
