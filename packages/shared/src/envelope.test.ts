import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildEnvelope, toOutboxRow } from './envelope.ts';

describe('event envelope', () => {
  it('fills every envelope field and maps to the Debezium outbox layout', () => {
    const tenantId = randomUUID();
    const env = buildEnvelope(
      { type: 'order.created', aggregateType: 'order', aggregateId: 'o1', data: { n: 1 } },
      { tenantId, app: 'ordering', correlationId: 'c1', newId: randomUUID, now: () => new Date('2026-11-01T00:00:00Z') },
    );
    expect(Object.keys(env).sort()).toEqual(
      ['app', 'causation_id', 'correlation_id', 'data', 'id', 'occurred_at', 'origin', 'schema_ref', 'tenant_id', 'traceparent', 'type', 'version', 'workflow_chain', 'workflow_hop'].sort(),
    );
    expect(env).toMatchObject({ version: 1, origin: 'user', workflow_hop: 0, schema_ref: 'aod://ordering/order.created/v1', occurred_at: '2026-11-01T00:00:00.000Z' });
    expect(toOutboxRow(env, { aggregateType: 'order', aggregateId: 'o1' })).toEqual({ id: env.id, aggregatetype: 'order', aggregateid: 'o1', type: 'order.created', payload: env, tenant_id: tenantId });
  });

  it('rejects malformed event types', () => {
    expect(() => buildEnvelope({ type: 'Order Created', aggregateType: 'o', aggregateId: '1', data: {} }, { tenantId: randomUUID(), app: 'x', correlationId: 'c', newId: randomUUID })).toThrow();
  });
});
