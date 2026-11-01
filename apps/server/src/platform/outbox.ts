import { buildEnvelope, toOutboxRow, type EnvelopeContext, type EventDraft, type EventEnvelope } from '@aod/shared';
import type { Tx } from '../db/database.ts';

/** Writes events to the outbox. Must be called inside the business transaction. */
export async function writeOutbox(tx: Tx, drafts: EventDraft[], ctx: EnvelopeContext): Promise<EventEnvelope[]> {
  if (!drafts.length) return [];
  const rows = drafts.map((d) => {
    const env = buildEnvelope(d, ctx);
    return { env, row: toOutboxRow(env, d) };
  });
  await tx
    .insertInto('outbox_event')
    .values(rows.map(({ row }) => ({ ...row, payload: JSON.stringify(row.payload) })))
    .execute();
  return rows.map((r) => r.env);
}
