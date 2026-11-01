import { CommandError, type Principal } from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../db/database.ts';
import type { Platform } from './context.ts';
import { recordChange } from './record.ts';
import { resolveApprovalNode } from './workflows/engine.ts';

/**
 * Approvals: a platform service. Workflows request approvals today; high-risk assistant
 * tools reuse it in Milestone E. A request names approver roles, a quorum and an expiry.
 * Any rejection rejects; `quorum` approvals approve. Every decision is audited and emits
 * `approval.decided`; the outcome emits `approval.resolved`.
 */

export interface Approver {
  id: string;
  /** the user's role: a preset name or a custom role id */
  role: string;
  principal: Principal;
}

const canDecide = (approver: Approver, roles: string[]) => roles.includes(approver.role) || approver.role === 'Owner';

export async function listApprovals(tx: Tx, approver: Approver, status: 'pending' | 'decided' | 'all') {
  let q = tx.selectFrom('approval_request').selectAll().orderBy('created_at', 'desc').limit(200);
  if (status === 'pending') q = q.where('status', '=', 'pending').where('expires_at', '>', new Date());
  if (status === 'decided') q = q.where('status', '<>', 'pending');
  // Approvers see the requests addressed to their role; Owners see all.
  if (approver.role !== 'Owner') q = q.where(sql<boolean>`${approver.role} = ANY(approver_roles)`);
  const rows = await q.execute();
  const decisions = rows.length ? await tx.selectFrom('approval_decision as d').innerJoin('app_user as u', 'u.id', 'd.user_id').select(['d.request_id', 'd.user_id', 'd.decision', 'd.comment', 'd.at', 'u.name']).where('d.request_id', 'in', rows.map((r) => r.id)).orderBy('d.at').execute() : [];
  return rows.map((r) => {
    const mine = decisions.filter((d) => d.request_id === r.id);
    return {
      ...r,
      decisions: mine.map((d) => ({ user_id: d.user_id, name: d.name, decision: d.decision, comment: d.comment, at: d.at })),
      approvals: mine.filter((d) => d.decision === 'approve').length,
      can_decide: r.status === 'pending' && new Date(r.expires_at) > new Date() && canDecide(approver, r.approver_roles as string[]) && !mine.some((d) => d.user_id === approver.id) && r.requested_by !== approver.id,
    };
  });
}

export async function decideApproval(p: Platform, tx: Tx, tenantId: string, approver: Approver, requestId: string, decision: 'approve' | 'reject', comment: string, correlationId: string) {
  const r = (await sql<any>`SELECT * FROM approval_request WHERE id = ${requestId} FOR UPDATE`.execute(tx)).rows[0];
  if (!r) throw new CommandError(404, 'not_found', 'approval request not found');
  if (!canDecide(approver, r.approver_roles)) throw new CommandError(403, 'not_an_approver', 'this request is not addressed to your role');
  if (r.requested_by === approver.id) throw new CommandError(403, 'own_request', 'you cannot decide your own request');
  if (r.status !== 'pending') throw new CommandError(409, 'already_resolved', `the request is ${r.status}`);
  if (new Date(r.expires_at) <= new Date()) throw new CommandError(409, 'expired', 'the request has expired');
  await tx
    .insertInto('approval_decision')
    .values({ id: newId(), tenant_id: tenantId, request_id: r.id, user_id: approver.id, decision, comment })
    .execute()
    .catch((e) => {
      if (e?.code === '23505') throw new CommandError(409, 'already_decided', 'you already decided this request');
      throw e;
    });
  const tally = await tx.selectFrom('approval_decision').select(['decision', sql<number>`count(*)::int`.as('n')]).where('request_id', '=', r.id).groupBy('decision').execute();
  const approvals = tally.find((t) => t.decision === 'approve')?.n ?? 0;
  const rejected = (tally.find((t) => t.decision === 'reject')?.n ?? 0) > 0;
  const outcome: 'approved' | 'rejected' | null = rejected ? 'rejected' : approvals >= r.quorum ? 'approved' : null;
  const corr = r.correlation_id ?? correlationId;
  const events: { type: string; data: Record<string, unknown> }[] = [{ type: 'approval.decided', data: { request_id: r.id, decision, approvals, quorum: r.quorum } }];
  if (outcome) {
    await tx.updateTable('approval_request').set({ status: outcome, decided_at: new Date(), version: sql`version + 1` }).where('id', '=', r.id).execute();
    events.push({ type: 'approval.resolved', data: { request_id: r.id, status: outcome } });
  }
  // Audited under the request's correlation id so the trace viewer shows the decision in its chain.
  await recordChange(p, tx, { tenantId, actor: approver.principal, action: `platform:approval.${decision}`, resourceType: 'platform::ApprovalRequest', resourceId: r.id, correlationId: corr, events, data: { comment, request_correlation: corr, http_request: correlationId } });
  if (outcome && r.source === 'workflow') {
    const all = await tx.selectFrom('approval_decision').select(['user_id', 'decision', 'comment']).where('request_id', '=', r.id).execute();
    await resolveApprovalNode(p, tx, r.source_ref, outcome, { request_id: r.id, status: outcome, decisions: all });
  }
  return { status: outcome ?? 'pending', approvals, quorum: r.quorum };
}
