import type { Principal } from '@aod/shared';
import { newId, type Tx } from '../db/database.ts';

export interface AuditEntry {
  tenantId: string;
  actor: Pick<Principal, 'type' | 'id'>;
  action: string;
  resourceType: string;
  resourceId: string;
  correlationId?: string;
  data?: Record<string, unknown>;
}

/** Appends to audit_log. The app role has no UPDATE/DELETE grant on it. */
export async function writeAudit(tx: Tx, e: AuditEntry) {
  await tx
    .insertInto('audit_log')
    .values({
      id: newId(),
      tenant_id: e.tenantId,
      actor_type: e.actor.type,
      actor_id: e.actor.id,
      action: e.action,
      resource_type: e.resourceType,
      resource_id: e.resourceId,
      correlation_id: e.correlationId ?? null,
      data: JSON.stringify(e.data ?? {}),
    })
    .execute();
}
