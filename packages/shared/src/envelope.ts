import { z } from 'zod';

/**
 * Event envelope. Every event that leaves a command handler is wrapped in this shape
 * and stored in the outbox (Debezium outbox-router layout) in the same transaction
 * as the business write.
 */
export const EventOrigin = z.enum(['user', 'system', 'workflow', 'integration', 'assistant', 'carrier', 'pos-offline']);
export type EventOrigin = z.infer<typeof EventOrigin>;

export const EventEnvelope = z.object({
  id: z.uuid(),
  /** e.g. `order.created` */
  type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  /** schema version of `data` */
  version: z.int().positive(),
  tenant_id: z.uuid(),
  /** owning app, e.g. `ordering`, or `platform` */
  app: z.string().min(1),
  occurred_at: z.iso.datetime({ offset: true }),
  /** W3C trace context */
  traceparent: z.string().nullable(),
  correlation_id: z.string().min(1),
  causation_id: z.string().nullable(),
  origin: EventOrigin,
  /** number of workflow hops that led to this event (loop protection) */
  workflow_hop: z.int().nonnegative(),
  /** workflow ids traversed (loop protection) */
  workflow_chain: z.array(z.string()),
  data: z.record(z.string(), z.unknown()),
  /** e.g. `aod://ordering/order.created/v1` */
  schema_ref: z.string(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export interface EventDraft {
  type: string;
  version?: number;
  aggregateType: string;
  aggregateId: string;
  data: Record<string, unknown>;
}

export interface EnvelopeContext {
  tenantId: string;
  app: string;
  correlationId: string;
  causationId?: string | null;
  traceparent?: string | null;
  origin?: EventOrigin;
  workflowHop?: number;
  workflowChain?: string[];
  now?: () => Date;
  newId: () => string;
}

export const schemaRef = (app: string, type: string, version: number) => `aod://${app}/${type}/v${version}`;

export function buildEnvelope(draft: EventDraft, ctx: EnvelopeContext): EventEnvelope {
  const version = draft.version ?? 1;
  const env: EventEnvelope = {
    id: ctx.newId(),
    type: draft.type,
    version,
    tenant_id: ctx.tenantId,
    app: ctx.app,
    occurred_at: (ctx.now ? ctx.now() : new Date()).toISOString(),
    traceparent: ctx.traceparent ?? null,
    correlation_id: ctx.correlationId,
    causation_id: ctx.causationId ?? null,
    origin: ctx.origin ?? 'user',
    workflow_hop: ctx.workflowHop ?? 0,
    workflow_chain: ctx.workflowChain ?? [],
    data: draft.data,
    schema_ref: schemaRef(ctx.app, draft.type, version),
  };
  return EventEnvelope.parse(env);
}

/** Row layout of `outbox_event` (Debezium outbox event router + tenant_id, created_at). */
export interface OutboxRow {
  id: string;
  aggregatetype: string;
  aggregateid: string;
  type: string;
  payload: EventEnvelope;
  tenant_id: string;
}

export function toOutboxRow(env: EventEnvelope, draft: Pick<EventDraft, 'aggregateType' | 'aggregateId'>): OutboxRow {
  return {
    id: env.id,
    aggregatetype: draft.aggregateType,
    aggregateid: draft.aggregateId,
    type: env.type,
    payload: env,
    tenant_id: env.tenant_id,
  };
}
