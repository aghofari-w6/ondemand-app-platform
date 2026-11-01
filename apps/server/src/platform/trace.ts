import { sql } from 'kysely';
import type { Tx } from '../db/database.ts';

/**
 * Trace viewer: everything that happened under one correlation id, as a timeline —
 * command (audit) → events → consumers → workflow runs/nodes → Hub deliveries →
 * approvals. The query may be a correlation id, an event id, a record id, a workflow
 * run id or an approval request id. Event data is not returned (only metadata), so the
 * trace never shows field values the viewer could not read elsewhere.
 */

export interface TraceItem {
  at: string;
  kind: 'audit' | 'event' | 'consumer' | 'run' | 'node' | 'delivery' | 'approval' | 'decision';
  title: string;
  detail: string;
  status?: string;
  correlation_id: string;
  ids: Record<string, string>;
  traceparent?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string) => new Date(d).toISOString();

async function correlationsFor(tx: Tx, q: string): Promise<string[]> {
  if (!UUID.test(q)) return [q];
  const found = new Set<string>();
  const ev = await tx.selectFrom('event_log').select(sql<string>`payload ->> 'correlation_id'`.as('c')).where('id', '=', q).executeTakeFirst();
  if (ev) found.add(ev.c);
  const run = await tx.selectFrom('workflow_run').select('correlation_id').where('id', '=', q).executeTakeFirst();
  if (run) found.add(run.correlation_id);
  const ap = await tx.selectFrom('approval_request').select('correlation_id').where('id', '=', q).executeTakeFirst();
  if (ap?.correlation_id) found.add(ap.correlation_id);
  if (!found.size) {
    // A record id: the most recent chains that touched it.
    const recs = await tx.selectFrom('event_log').select([sql<string>`payload ->> 'correlation_id'`.as('c'), 'seq']).where('aggregateid', '=', q).orderBy('seq', 'desc').limit(20).execute();
    for (const r of recs) if (found.size < 5) found.add(r.c);
  }
  if (!found.size) found.add(q);
  return [...found];
}

export async function traceQuery(tx: Tx, rawQuery: string) {
  const q = rawQuery.trim();
  const correlations = await correlationsFor(tx, q);
  const items: TraceItem[] = [];

  const audit = await tx.selectFrom('audit_log').select(['id', 'at', 'actor_type', 'actor_id', 'action', 'resource_type', 'resource_id', 'correlation_id']).where('correlation_id', 'in', correlations).orderBy('at').limit(500).execute();
  for (const a of audit) items.push({ at: iso(a.at), kind: 'audit', title: a.action, detail: `${a.actor_type} ${a.actor_id} · ${a.resource_type} ${a.resource_id}`, correlation_id: a.correlation_id!, ids: { audit_id: a.id, resource_id: a.resource_id } });

  const events = await tx
    .selectFrom('event_log')
    .select(['seq', 'id', 'type', 'aggregatetype', 'aggregateid', 'created_at', 'payload'])
    .where(sql<string>`payload ->> 'correlation_id'`, 'in', correlations)
    .orderBy('seq')
    .limit(500)
    .execute();
  const eventIds = events.map((e) => e.id as string);
  for (const e of events) {
    const env = e.payload as { occurred_at: string; app: string; origin: string; workflow_hop: number; causation_id: string | null; traceparent: string | null; correlation_id: string };
    items.push({
      at: env.occurred_at,
      kind: 'event',
      title: e.type,
      detail: `${env.app} · origin ${env.origin} · hop ${env.workflow_hop} · ${e.aggregatetype} ${e.aggregateid}`,
      correlation_id: env.correlation_id,
      ids: { event_id: e.id, aggregate_id: e.aggregateid, ...(env.causation_id ? { causation_id: env.causation_id } : {}) },
      traceparent: env.traceparent,
    });
  }

  if (eventIds.length) {
    const consumed = await tx.selectFrom('processed_event').select(['consumer', 'event_id', 'processed_at']).where('event_id', 'in', eventIds).execute();
    const corrOf = new Map(events.map((e) => [e.id as string, (e.payload as { correlation_id: string }).correlation_id]));
    const typeOf = new Map(events.map((e) => [e.id as string, e.type as string]));
    for (const c of consumed) items.push({ at: iso(c.processed_at), kind: 'consumer', title: c.consumer, detail: `processed ${typeOf.get(c.event_id)}`, correlation_id: corrOf.get(c.event_id)!, ids: { event_id: c.event_id } });

    const deliveries = await tx
      .selectFrom('hub_delivery as d')
      .innerJoin('hub_endpoint as e', 'e.id', 'd.endpoint_id')
      .select(['d.id', 'd.event_id', 'd.event_type', 'd.status', 'd.attempts', 'd.created_at', 'd.last_error', 'e.name'])
      .where('d.event_id', 'in', eventIds)
      .execute();
    for (const d of deliveries) items.push({ at: iso(d.created_at), kind: 'delivery', title: `Hub → ${d.name}`, detail: `${d.event_type} · ${d.attempts} attempt(s)${d.last_error ? ` · ${d.last_error}` : ''}`, status: d.status, correlation_id: corrOf.get(d.event_id)!, ids: { delivery_id: d.id, event_id: d.event_id } });
  }

  const runs = await tx.selectFrom('workflow_run as r').innerJoin('workflow as w', 'w.id', 'r.workflow_id').select(['r.id', 'r.workflow_id', 'r.version_number', 'r.status', 'r.started_at', 'r.finished_at', 'r.error', 'r.hop', 'r.correlation_id', 'r.trigger_event_id', 'w.name']).where('r.correlation_id', 'in', correlations).orderBy('r.started_at').execute();
  if (runs.length) {
    for (const r of runs) items.push({ at: iso(r.started_at), kind: 'run', title: `Workflow: ${r.name}`, detail: `version ${r.version_number} · hop ${r.hop}${r.error ? ` · ${r.error}` : ''}`, status: r.status, correlation_id: r.correlation_id, ids: { run_id: r.id, workflow_id: r.workflow_id, event_id: r.trigger_event_id } });
    const nodes = await tx.selectFrom('workflow_node_run').select(['id', 'run_id', 'node_id', 'status', 'port', 'error', 'created_at', 'started_at', 'finished_at']).where('run_id', 'in', runs.map((r) => r.id)).orderBy('created_at').execute();
    const runCorr = new Map(runs.map((r) => [r.id, r.correlation_id]));
    for (const n of nodes) items.push({ at: iso(n.started_at ?? n.created_at), kind: 'node', title: `Node ${n.node_id}`, detail: [n.port ? `→ ${n.port}` : '', n.error ?? ''].filter(Boolean).join(' · '), status: n.status, correlation_id: runCorr.get(n.run_id)!, ids: { run_id: n.run_id, node_run_id: n.id } });
  }

  const approvals = await tx.selectFrom('approval_request').select(['id', 'title', 'status', 'quorum', 'created_at', 'correlation_id', 'source', 'source_ref']).where('correlation_id', 'in', correlations).execute();
  if (approvals.length) {
    for (const a of approvals) items.push({ at: iso(a.created_at), kind: 'approval', title: `Approval: ${a.title}`, detail: `${a.source} · quorum ${a.quorum}`, status: a.status, correlation_id: a.correlation_id!, ids: { request_id: a.id } });
    const decisions = await tx.selectFrom('approval_decision as d').innerJoin('app_user as u', 'u.id', 'd.user_id').select(['d.id', 'd.request_id', 'd.decision', 'd.at', 'u.name']).where('d.request_id', 'in', approvals.map((a) => a.id)).execute();
    const aCorr = new Map(approvals.map((a) => [a.id, a.correlation_id!]));
    for (const d of decisions) items.push({ at: iso(d.at), kind: 'decision', title: `${d.name} ${d.decision === 'approve' ? 'approved' : 'rejected'}`, detail: '', status: d.decision, correlation_id: aCorr.get(d.request_id)!, ids: { request_id: d.request_id, decision_id: d.id } });
  }

  const order: Record<TraceItem['kind'], number> = { audit: 0, event: 1, consumer: 2, run: 3, node: 4, approval: 5, decision: 6, delivery: 7 };
  items.sort((a, b) => a.at.localeCompare(b.at) || order[a.kind] - order[b.kind]);
  return { query: q, correlation_ids: correlations, items, truncated: audit.length >= 500 || events.length >= 500 };
}
