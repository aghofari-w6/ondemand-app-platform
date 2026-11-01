import type { EventDraft, EventOrigin, Principal } from '@aod/shared';
import { newId, type Tx } from '../db/database.ts';
import { writeAudit } from './audit.ts';
import type { Platform } from './context.ts';
import { writeOutbox } from './outbox.ts';

/**
 * Platform-level writes (tenants, users, roles, apps) record their events and audit
 * entry exactly like app commands: outbox + audit in the caller's transaction.
 */
export async function recordChange(
  p: Platform,
  tx: Tx,
  c: {
    tenantId: string;
    actor: Pick<Principal, 'type' | 'id'>;
    action: string;
    resourceType: string;
    resourceId: string;
    correlationId: string;
    events?: Omit<EventDraft, 'aggregateType' | 'aggregateId'>[];
    data?: Record<string, unknown>;
    /** set by workflow runs: the events keep the run's origin, hop and chain */
    envelope?: { origin: EventOrigin; causationId?: string | null; workflowHop: number; workflowChain: string[] };
  },
) {
  await writeOutbox(
    tx,
    (c.events ?? []).map((e) => ({ ...e, aggregateType: c.resourceType, aggregateId: c.resourceId })),
    {
      tenantId: c.tenantId,
      app: 'platform',
      correlationId: c.correlationId,
      traceparent: p.ports.telemetry.traceparent(),
      origin: c.envelope?.origin ?? (c.actor.type === 'System' ? 'system' : 'user'),
      ...(c.envelope ? { causationId: c.envelope.causationId ?? null, workflowHop: c.envelope.workflowHop, workflowChain: c.envelope.workflowChain } : {}),
      newId,
    },
  );
  await writeAudit(tx, { tenantId: c.tenantId, actor: c.actor, action: c.action, resourceType: c.resourceType, resourceId: c.resourceId, correlationId: c.correlationId, data: c.data ?? {} });
}
