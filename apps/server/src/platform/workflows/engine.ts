import {
  backoffMs,
  CommandError,
  evalCondition,
  renderTemplate,
  WorkflowGraph,
  type EventEnvelope,
  type Principal,
  type Template,
  type WorkflowNode,
} from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../../db/database.ts';
import type { Consumer } from '../../ports/index.ts';
import { publishedFieldRules, resolveRole } from '../../auth/principal.ts';
import { executeCommand } from '../commands.ts';
import type { Platform } from '../context.ts';
import { recordChange } from '../record.ts';
import { executeRecordWrite } from '../records.ts';
import { assertActorCovers } from './definitions.ts';

/**
 * Workflow engine.
 *
 * Start: the `platform.workflows` consumer starts one run per matching published
 * workflow in the transaction that marks the event processed (unique per workflow +
 * trigger event), so a run is never lost or doubled. The same consumer resolves runs
 * that wait for an event.
 *
 * Advance: every node execution is a `workflow_node_run` row. An in-process runner
 * claims due rows across tenants (lease, SKIP LOCKED) and executes them. A node's
 * completion and its successors are written in one transaction that holds the run row
 * lock, so parallel branches and the run's final status never race.
 *
 * Exactly-once side effects: command and record nodes run inside the transaction that
 * marks the node succeeded, with the idempotency key `wf:<node run id>`; a crash before
 * commit leaves nothing behind, a re-claimed node replays the stored response.
 *
 * Loop protection: events written by a run carry origin `workflow`, the run's hop
 * (trigger hop + 1) and its chain (trigger chain + workflow id). Events at hop
 * `WORKFLOW_MAX_HOPS` or whose chain already holds the workflow never start it.
 */

export const MAX_NODE_ATTEMPTS = 3;
const LEASE_SECONDS = 60;
const OPEN = ['pending', 'running', 'waiting'];

export interface RunRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  version_number: number;
  status: string;
  trigger_event_id: string;
  trigger: EventEnvelope;
  correlation_id: string;
  hop: number;
  chain: string[];
  vars: Record<string, unknown>;
  initiated_by: string | null;
}

const workflowEnvelope = (run: RunRow) => ({ origin: 'workflow' as const, causationId: run.trigger_event_id, workflowHop: run.hop, workflowChain: run.chain });

export interface NodeRunRow {
  id: string;
  run_id: string;
  node_id: string;
  status: string;
  attempt: number;
  groups: string[];
  input: unknown;
  state: Record<string, unknown>;
  claimed_from: string | null;
  started_at: Date | null;
}

/** A failure the node reports; `retry` says whether trying again can help. */
export class NodeError extends Error {
  readonly retry: boolean;
  readonly code: string;
  constructor(message: string, retry: boolean, code = 'node_failed') {
    super(message);
    this.retry = retry;
    this.code = code;
  }
}

const asNodeError = (e: unknown): NodeError => {
  if (e instanceof NodeError) return e;
  if (e instanceof CommandError) return new NodeError(e.message, e.status >= 500 || e.status === 409, e.code);
  return new NodeError((e as Error)?.message ?? String(e), true, 'unexpected');
};

const json = (v: unknown) => JSON.stringify(v ?? null);

// ------------------------------------------------------------------ graph + context helpers

const graphCache = new Map<string, WorkflowGraph>();
export async function loadGraph(tx: Tx, workflowId: string, number: number): Promise<WorkflowGraph> {
  const k = `${workflowId}:${number}`;
  const hit = graphCache.get(k);
  if (hit) return hit;
  const v = await tx.selectFrom('workflow_version').select('graph').where('workflow_id', '=', workflowId).where('number', '=', number).executeTakeFirstOrThrow();
  const g = WorkflowGraph.parse(v.graph);
  if (graphCache.size > 500) graphCache.clear();
  graphCache.set(k, g); // published versions never change
  return g;
}

export const nodeOf = (g: WorkflowGraph, id: string): WorkflowNode => {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) throw new NodeError(`node ${id} is not in this version`, false);
  return n;
};

/** Expression scope for a run: trigger, steps.<node>.output/port, vars, run. */
export async function runScope(tx: Tx, run: RunRow): Promise<Record<string, unknown>> {
  const done = await tx.selectFrom('workflow_node_run').select(['node_id', 'output', 'port']).where('run_id', '=', run.id).where('status', '=', 'succeeded').orderBy('created_at').execute();
  const steps: Record<string, unknown> = {};
  for (const n of done) steps[n.node_id] = { output: n.output, port: n.port };
  return { trigger: run.trigger, steps, vars: run.vars, run: { id: run.id, workflow_id: run.workflow_id, hop: run.hop, correlation_id: run.correlation_id } };
}

const render = (t: unknown, scope: Record<string, unknown>) => {
  try {
    return renderTemplate(t as Template, scope);
  } catch (e) {
    throw new NodeError(`template: ${(e as Error).message}`, false, 'template_error');
  }
};
const condition = (src: string, scope: Record<string, unknown>) => {
  try {
    return evalCondition(src, scope);
  } catch (e) {
    throw new NodeError(`expression: ${(e as Error).message}`, false, 'expression_error');
  }
};

/** Nodes computed from the scope alone (also used by the dry run). */
export function computePure(node: WorkflowNode, scope: Record<string, unknown>, input: unknown): { port: string; output: unknown } {
  const c = node.config as Record<string, any>;
  switch (node.type) {
    case 'trigger':
      return { port: 'out', output: { event_id: (scope.trigger as EventEnvelope).id, type: (scope.trigger as EventEnvelope).type } };
    case 'condition': {
      const result = condition(c.expr, scope);
      return { port: result ? 'true' : 'false', output: { result } };
    }
    case 'switch': {
      for (const k of c.cases as { port: string; expr: string }[]) if (condition(k.expr, scope)) return { port: k.port, output: { case: k.port } };
      return { port: 'default', output: { case: 'default' } };
    }
    case 'set':
      return { port: 'out', output: render(c.vars, scope) };
    case 'parallel':
      return { port: 'out', output: {} };
    case 'merge':
      return { port: 'out', output: input ?? { branches: {} } };
    default:
      throw new Error(`${node.type} is not a pure node`);
  }
}

// ------------------------------------------------------------------ service principal

/** The principal a published workflow acts as: (its role today) ∩ (the permissions capped at publish). */
export async function servicePrincipal(p: Platform, tx: Tx, tenantId: string, workflowId: string, number: number): Promise<Principal> {
  const v = await tx.selectFrom('workflow_version').select(['service_role', 'service_permissions']).where('workflow_id', '=', workflowId).where('number', '=', number).executeTakeFirstOrThrow();
  const role = v.service_role ? await resolveRole(tx, p.catalog, v.service_role) : null;
  if (!role) return { type: 'Workflow', id: workflowId, tenantId, roles: [] };
  const capped = new Set(v.service_permissions as string[]);
  const published = role.preset === 'Owner' ? [] : await publishedFieldRules(tx, v.service_role!);
  const own = role.fieldRules.filter((r) => !published.some((x) => x.resource === r.resource && x.field === r.field));
  return {
    type: 'Workflow',
    id: workflowId,
    tenantId,
    // never a preset: an Owner preset would bypass the permission list
    roles: [{ name: `workflow:${role.name}`, preset: null, permissions: role.permissions.filter((x) => capped.has(x)), fieldRules: [...own, ...published] }],
  };
}

// ------------------------------------------------------------------ run bookkeeping (inside a tx)

export async function lockRun(tx: Tx, runId: string): Promise<RunRow> {
  const r = await sql<RunRow>`SELECT * FROM workflow_run WHERE id = ${runId} FOR UPDATE`.execute(tx);
  return r.rows[0]!;
}

async function insertNodeRun(tx: Tx, run: RunRow, nodeId: string, groups: string[], input: unknown) {
  await tx.insertInto('workflow_node_run').values({ id: newId(), tenant_id: run.tenant_id, run_id: run.id, node_id: nodeId, status: 'pending', groups, input: json(input) }).execute();
}

/** A branch of the innermost parallel group ended without reaching its merge. */
async function branchEnded(tx: Tx, run: RunRow, groups: string[], arrival: { node: string; output: unknown } | null) {
  if (!groups.length) return;
  const gid = groups[groups.length - 1]!;
  const r = await sql<{ open: number; arrivals: { node: string; output: unknown }[]; merge_node: string | null }>`
    UPDATE workflow_branch SET open = open - 1, arrivals = CASE WHEN ${arrival !== null} THEN arrivals || ${json(arrival ? [arrival] : [])}::jsonb ELSE arrivals END
    WHERE run_id = ${run.id} AND group_id = ${gid} RETURNING open, arrivals, merge_node`.execute(tx);
  const b = r.rows[0];
  if (!b || b.open > 0) return;
  const outer = groups.slice(0, -1);
  if (b.merge_node && b.arrivals.length) {
    await insertNodeRun(tx, run, b.merge_node, outer, { branches: Object.fromEntries(b.arrivals.map((a) => [a.node, a.output])) });
  } else {
    await branchEnded(tx, run, outer, null);
  }
}

/** Creates the successors of a finished node (one per edge leaving `port`). */
async function advance(tx: Tx, run: RunRow, graph: WorkflowGraph, nr: Pick<NodeRunRow, 'node_id' | 'groups'>, port: string, output: unknown) {
  const node = nodeOf(graph, nr.node_id);
  const edges = graph.edges.filter((e) => e.from === node.id && e.port === port);
  let groups = nr.groups;
  if (node.type === 'parallel' && edges.length) {
    const gid = newId();
    const merge = graph.nodes.find((n) => n.type === 'merge' && n.config.parallel === node.id)?.id ?? null;
    await tx.insertInto('workflow_branch').values({ tenant_id: run.tenant_id, run_id: run.id, group_id: gid, merge_node: merge, open: edges.length }).execute();
    groups = [...groups, gid];
  }
  if (!edges.length) return branchEnded(tx, run, groups, null);
  for (const e of edges) {
    const target = nodeOf(graph, e.to);
    if (target.type === 'merge') {
      const gid = groups[groups.length - 1];
      const b = gid ? await tx.selectFrom('workflow_branch').select('merge_node').where('run_id', '=', run.id).where('group_id', '=', gid).executeTakeFirst() : null;
      if (b?.merge_node === target.id) {
        await branchEnded(tx, run, groups, { node: node.id, output });
        continue;
      }
      if (gid) throw new NodeError(`${target.id} is reached from inside a parallel branch it does not join`, false);
    }
    await insertNodeRun(tx, run, e.to, groups, output);
  }
}

async function maybeComplete(p: Platform, tx: Tx, run: RunRow) {
  const open = await tx.selectFrom('workflow_node_run').select(sql<number>`count(*)::int`.as('n')).where('run_id', '=', run.id).where('status', 'in', OPEN).executeTakeFirstOrThrow();
  if (open.n > 0) return;
  await tx.updateTable('workflow_run').set({ status: 'succeeded', finished_at: new Date(), version: sql`version + 1` }).where('id', '=', run.id).where('status', '=', 'running').execute();
  p.ports.metrics.increment('aod_workflow_runs_total', { status: 'succeeded' });
}

/** Marks a node succeeded with an output port and creates its successors. Call with the run locked. */
export async function finishNode(p: Platform, tx: Tx, run: RunRow, graph: WorkflowGraph, nr: Pick<NodeRunRow, 'id' | 'node_id' | 'groups'>, port: string, output: unknown) {
  await tx.updateTable('workflow_node_run').set({ status: 'succeeded', port, output: json(output), error: null, lease_until: null, finished_at: new Date() }).where('id', '=', nr.id).execute();
  await advance(tx, run, graph, nr, port, output);
  await maybeComplete(p, tx, run);
}

async function cancelOpen(p: Platform, tx: Tx, run: Pick<RunRow, 'id' | 'tenant_id' | 'correlation_id'>, reason: string, exceptId?: string) {
  const runId = run.id;
  const rows = await tx
    .updateTable('workflow_node_run')
    .set({ status: 'cancelled', error: reason, lease_until: null, finished_at: new Date() })
    .where('run_id', '=', runId)
    .where('status', 'in', OPEN)
    .$if(Boolean(exceptId), (q) => q.where('id', '<>', exceptId!))
    .returning('id')
    .execute();
  if (rows.length) {
    const cancelled = await tx
      .updateTable('approval_request')
      .set({ status: 'cancelled', decided_at: new Date(), version: sql`version + 1` })
      .where('source', '=', 'workflow')
      .where('source_ref', 'in', rows.map((r) => r.id))
      .where('status', '=', 'pending')
      .returning('id')
      .execute();
    for (const a of cancelled) {
      await recordChange(p, tx, { tenantId: run.tenant_id, actor: { type: 'System', id: 'workflows' }, action: 'platform:approval.cancelled', resourceType: 'platform::ApprovalRequest', resourceId: a.id, correlationId: run.correlation_id, events: [{ type: 'approval.resolved', data: { request_id: a.id, status: 'cancelled', reason } }], data: { reason } });
    }
  }
  return rows.map((r) => r.id);
}

/** A node failed for good: take its `error` output if connected, else fail the run (run DLQ). */
async function failNode(p: Platform, tx: Tx, run: RunRow, graph: WorkflowGraph, nr: NodeRunRow, err: NodeError) {
  const node = nodeOf(graph, nr.node_id);
  if (graph.edges.some((e) => e.from === node.id && e.port === 'error')) {
    await finishNode(p, tx, run, graph, nr, 'error', { error: err.message, code: err.code });
    return;
  }
  await tx.updateTable('workflow_node_run').set({ status: 'failed', error: err.message, lease_until: null, finished_at: new Date() }).where('id', '=', nr.id).execute();
  const cancelled = await cancelOpen(p, tx, run, 'run failed', nr.id);
  if (cancelled.length) await tx.updateTable('workflow_node_run').set({ state: sql`state || '{"revive": true}'::jsonb` }).where('id', 'in', cancelled).execute();
  await tx.updateTable('workflow_run').set({ status: 'failed', error: `${node.id}: ${err.message}`, finished_at: new Date(), version: sql`version + 1` }).where('id', '=', run.id).execute();
  p.ports.metrics.increment('aod_workflow_runs_total', { status: 'failed' });
  await recordChange(p, tx, {
    tenantId: run.tenant_id,
    actor: { type: 'System', id: 'workflows' },
    action: 'platform:workflow.run_failed',
    resourceType: 'platform::WorkflowRun',
    resourceId: run.id,
    correlationId: run.correlation_id,
    events: [{ type: 'workflow.run_failed', data: { run_id: run.id, workflow_id: run.workflow_id, node: node.id, error: err.message } }],
  });
}

// ------------------------------------------------------------------ notifications (consumer)

/**
 * Sends `workflow.notification` events through the Channel port. Runs once per event
 * (processed_event); a crash between send and commit can repeat a send.
 */
export function notificationsConsumer(p: Platform): Consumer {
  return {
    name: 'platform.notifications',
    types: ['workflow.notification'],
    async handle(event, tx) {
      const d = event.data as { users: string[]; subject: string; message: string };
      if (!d.users?.length) return;
      const users = await tx.selectFrom('app_user').select(['id', 'email']).where('id', 'in', d.users).where('status', '=', 'active').execute();
      for (const u of users) await p.ports.channel.send({ tenantId: event.tenant_id, to: u.email, subject: d.subject, body: d.message });
      p.ports.metrics.increment('aod_workflow_notifications_total', {}, users.length);
    },
  };
}

// ------------------------------------------------------------------ start + event waits (consumer)

export function workflowsConsumer(p: Platform): Consumer {
  return {
    name: 'platform.workflows',
    types: ['*'],
    async handle(event, tx) {
      // The engine's own bookkeeping events never start or resume workflows.
      if (event.type.startsWith('workflow.') || event.type.startsWith('approval.')) return;
      await resolveWaits(p, tx, event);
      await startRuns(p, tx, event);
    },
  };
}

async function startRuns(p: Platform, tx: Tx, event: EventEnvelope) {
  const candidates = await tx
    .selectFrom('workflow_version as v')
    .innerJoin('workflow as w', 'w.id', 'v.workflow_id')
    .select(['w.id', 'w.name', 'v.number', 'v.graph'])
    .where('v.status', '=', 'published')
    .where('w.status', '=', 'active')
    .where('v.trigger_event', '=', event.type)
    .execute();
  for (const wf of candidates) {
    const graph = WorkflowGraph.parse(wf.graph);
    const trigger = graph.nodes.find((n) => n.type === 'trigger')!;
    const filter = (trigger.config as { filter?: string }).filter;
    if (filter) {
      let ok = false;
      try {
        ok = evalCondition(filter, { trigger: event });
      } catch (e) {
        p.log.warn({ workflow: wf.id, err: (e as Error).message }, 'workflow trigger filter failed');
      }
      if (!ok) continue;
    }
    // Loop guards: recorded as cancelled runs so the trace shows why nothing happened.
    let guard: string | null = null;
    if (event.workflow_hop >= p.env.WORKFLOW_MAX_HOPS) guard = `hop limit: the event is ${event.workflow_hop} workflow hops deep (max ${p.env.WORKFLOW_MAX_HOPS})`;
    else if (event.workflow_chain.includes(wf.id)) guard = 'loop guard: this workflow already ran earlier in the chain';
    else {
      const t = await tx.selectFrom('tenant').select('plan').executeTakeFirstOrThrow();
      const limits = p.ports.billing.plan(t.plan)?.limits;
      const limit = limits?.workflow_runs_month ?? 0;
      const used = await tx.selectFrom('workflow_run').select(sql<number>`count(*)::int`.as('n')).where('status', '<>', 'cancelled').where('started_at', '>=', sql<Date>`date_trunc('month', now())`).executeTakeFirstOrThrow();
      // Fan-out budget: k workflows re-emitting each other's triggers stay within this many
      // runs per correlation chain, whatever the hop limit allows.
      const chainLimit = limits?.workflow_runs_per_chain ?? 0;
      const inChain = await tx.selectFrom('workflow_run').select(sql<number>`count(*)::int`.as('n')).where('correlation_id', '=', event.correlation_id).where('status', '<>', 'cancelled').executeTakeFirstOrThrow();
      if (used.n >= limit) guard = `plan limit: ${limit} workflow runs per month`;
      else if (inChain.n >= chainLimit) guard = `chain limit: ${chainLimit} workflow runs for one change (plan limit workflow_runs_per_chain)`;
    }
    // The user whose change started this chain may not approve its approval requests.
    const initiator = guard
      ? null
      : await tx.selectFrom('audit_log').select('actor_id').where('correlation_id', '=', event.correlation_id).where('actor_type', '=', 'User').orderBy('at').limit(1).executeTakeFirst();
    const runId = newId();
    const inserted = await tx
      .insertInto('workflow_run')
      .values({
        id: runId,
        tenant_id: event.tenant_id,
        workflow_id: wf.id,
        version_number: wf.number,
        status: guard ? 'cancelled' : 'running',
        trigger_event_id: event.id,
        trigger: json(event),
        correlation_id: event.correlation_id,
        hop: event.workflow_hop + 1,
        chain: [...event.workflow_chain, wf.id],
        initiated_by: initiator?.actor_id ?? null,
        error: guard,
        ...(guard ? { finished_at: new Date() } : {}),
      })
      .onConflict((oc) => oc.columns(['workflow_id', 'trigger_event_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) continue;
    p.ports.metrics.increment('aod_workflow_runs_total', { status: guard ? 'guarded' : 'started' });
    if (guard) {
      p.log.warn({ workflow: wf.id, event: event.id }, guard);
      continue;
    }
    const run = await lockRun(tx, runId);
    const nrId = newId();
    const output = computePure(trigger, { trigger: event }, null).output;
    // created a moment earlier than its successors (same transaction, same now()) so it lists first
    await tx.insertInto('workflow_node_run').values({ id: nrId, tenant_id: event.tenant_id, run_id: runId, node_id: trigger.id, status: 'succeeded', attempt: 1, groups: [], input: null, output: json(output), port: 'out', created_at: sql`now() - interval '1 millisecond'`, started_at: new Date(), finished_at: new Date() }).execute();
    await advance(tx, run, graph, { node_id: trigger.id, groups: [] }, 'out', output);
    await maybeComplete(p, tx, run);
  }
}

async function resolveWaits(p: Platform, tx: Tx, event: EventEnvelope) {
  const waiting = await tx.selectFrom('workflow_node_run').selectAll().where('status', '=', 'waiting').where('wait_event', '=', event.type).execute();
  for (const w of waiting as unknown as NodeRunRow[]) {
    const run = await lockRun(tx, w.run_id);
    if (run.status !== 'running' || run.trigger_event_id === event.id) continue;
    // Only events that happened after the wait was armed.
    if (w.started_at && new Date(event.occurred_at) < new Date(w.started_at)) continue;
    const filter = w.state.filter as string | undefined;
    if (filter) {
      try {
        if (!evalCondition(filter, { ...(await runScope(tx, run)), event })) continue;
      } catch {
        continue;
      }
    }
    const won = await tx.updateTable('workflow_node_run').set({ status: 'running' }).where('id', '=', w.id).where('status', '=', 'waiting').returning('id').executeTakeFirst();
    if (!won) continue;
    const graph = await loadGraph(tx, run.workflow_id, run.version_number);
    await finishNode(p, tx, run, graph, w, 'event', { event_id: event.id, type: event.type, data: event.data });
  }
}

/** Resolves a workflow approval node after its request was decided (in the deciding tx). */
export async function resolveApprovalNode(p: Platform, tx: Tx, nodeRunId: string, outcome: 'approved' | 'rejected' | 'expired', output: unknown) {
  const nr = (await tx.selectFrom('workflow_node_run').selectAll().where('id', '=', nodeRunId).executeTakeFirst()) as unknown as NodeRunRow | undefined;
  if (!nr) return false;
  const run = await lockRun(tx, nr.run_id);
  if (run.status !== 'running') return false;
  const won = await tx.updateTable('workflow_node_run').set({ status: 'running' }).where('id', '=', nr.id).where('status', '=', 'waiting').returning('id').executeTakeFirst();
  if (!won) return false;
  await finishNode(p, tx, run, await loadGraph(tx, run.workflow_id, run.version_number), nr, outcome, output);
  return true;
}

// ------------------------------------------------------------------ runner

export class WorkflowRunner {
  private readonly p: Platform;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking: Promise<unknown> | null = null;

  private readonly loopFailed = (e: unknown) => this.p.log.error({ err: String(e) }, 'workflow loop failed');

  constructor(p: Platform) {
    this.p = p;
  }

  start() {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      this.ticking = this.tick().catch((e) => this.p.log.error({ err: String(e) }, 'workflow tick failed'));
      await this.ticking;
      this.ticking = null;
      if (this.running) this.timer = setTimeout(() => {
          loop().catch(this.loopFailed);
        }, this.p.env.WORKFLOW_INTERVAL_MS);
    };
    loop().catch(this.loopFailed);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.ticking) await this.ticking;
  }

  async tick(limit = 20): Promise<number> {
    const claimed = (await sql<{ tenant_id: string; id: string; claimed_from: string }>`SELECT * FROM workflow_claim_nodes(${limit}, ${LEASE_SECONDS})`.execute(this.p.database.db)).rows;
    await Promise.all(claimed.map((c) => this.process(c.tenant_id, c.id, c.claimed_from).catch((e) => this.p.log.error({ err: String(e), node_run: c.id }, 'workflow node failed unexpectedly'))));
    return claimed.length;
  }

  /** Runs everything that is due now (tests, demo). */
  async drain() {
    for (let i = 0; i < 200; i++) if ((await this.tick(50)) === 0) return;
  }

  async process(tenantId: string, nodeRunId: string, claimedFrom: string) {
    const p = this.p;
    const loaded = await p.database.withTenant(tenantId, async (tx) => {
      const nr = (await tx.selectFrom('workflow_node_run').selectAll().where('id', '=', nodeRunId).executeTakeFirst()) as unknown as NodeRunRow | undefined;
      if (!nr || nr.status !== 'running') return null;
      const run = (await tx.selectFrom('workflow_run').selectAll().where('id', '=', nr.run_id).executeTakeFirstOrThrow()) as unknown as RunRow;
      if (run.status !== 'running') {
        await tx.updateTable('workflow_node_run').set({ status: 'cancelled', error: `run ${run.status}`, lease_until: null, finished_at: new Date() }).where('id', '=', nr.id).execute();
        return null;
      }
      const graph = await loadGraph(tx, run.workflow_id, run.version_number);
      if (claimedFrom !== 'waiting') {
        await tx.updateTable('workflow_node_run').set({ attempt: sql`attempt + 1`, started_at: sql`coalesce(started_at, now())` }).where('id', '=', nr.id).execute();
        nr.attempt += 1;
      }
      return { nr, run, graph, node: nodeOf(graph, nr.node_id), scope: await runScope(tx, run) };
    });
    if (!loaded) return;
    const { nr, run, graph, node, scope } = loaded;
    try {
      if (claimedFrom === 'waiting') return await this.timeout(tenantId, nr, node);
      await p.ports.telemetry.span('workflow.node', { 'aod.workflow': run.workflow_id, 'aod.node': node.id, 'aod.node_type': node.type }, () => this.execute(tenantId, nr, run, graph, node, scope));
      p.ports.metrics.increment('aod_workflow_nodes_total', { type: node.type, ok: 'true' });
    } catch (e) {
      p.ports.metrics.increment('aod_workflow_nodes_total', { type: node.type, ok: 'false' });
      const err = asNodeError(e);
      await p.database.withTenant(tenantId, async (tx) => {
        const fresh = await lockRun(tx, run.id);
        const cur = await tx.selectFrom('workflow_node_run').select('status').where('id', '=', nr.id).executeTakeFirst();
        if (fresh.status !== 'running' || cur?.status !== 'running') return;
        if (err.retry && nr.attempt < MAX_NODE_ATTEMPTS) {
          await tx.updateTable('workflow_node_run').set({ status: 'pending', error: err.message, lease_until: null, not_before: new Date(Date.now() + backoffMs(nr.attempt - 1, { baseMs: 1000, capMs: 60_000 })) }).where('id', '=', nr.id).execute();
          return;
        }
        await failNode(p, tx, fresh, graph, nr, err);
      });
    }
  }

  /** Completes the node in a tx holding the run lock, if the node is still ours. */
  private async complete(tenantId: string, nr: NodeRunRow, graph: WorkflowGraph, fn: (tx: Tx, run: RunRow) => Promise<{ port: string; output: unknown } | null>) {
    await this.p.database.withTenant(tenantId, async (tx) => {
      const run = await lockRun(tx, nr.run_id);
      const cur = await tx.selectFrom('workflow_node_run').select('status').where('id', '=', nr.id).executeTakeFirst();
      if (run.status !== 'running' || cur?.status !== 'running') return;
      const r = await fn(tx, run);
      if (r) await finishNode(this.p, tx, run, graph, nr, r.port, r.output);
    });
  }

  private async execute(tenantId: string, nr: NodeRunRow, run: RunRow, graph: WorkflowGraph, node: WorkflowNode, scope: Record<string, unknown>) {
    const p = this.p;
    const c = node.config as Record<string, any>;
    const writeCtx = {
      tenantId,
      origin: 'workflow' as const,
      correlationId: run.correlation_id,
      causationId: run.trigger_event_id,
      workflowHop: run.hop,
      workflowChain: run.chain,
      idempotencyKey: `wf:${nr.id}`,
    };
    switch (node.type) {
      case 'trigger':
      case 'condition':
      case 'switch':
      case 'parallel':
      case 'merge': {
        const r = computePure(node, scope, nr.input);
        return this.complete(tenantId, nr, graph, async () => r);
      }
      case 'set': {
        const r = computePure(node, scope, nr.input);
        return this.complete(tenantId, nr, graph, async (tx, locked) => {
          const vars = { ...locked.vars, ...(r.output as object) };
          await tx.updateTable('workflow_run').set({ vars: json(vars) }).where('id', '=', locked.id).execute();
          locked.vars = vars;
          return r;
        });
      }
      case 'code': {
        let output: unknown;
        try {
          output = await p.ports.sandbox.run(c.source, { trigger: scope.trigger, steps: scope.steps, vars: scope.vars }, { timeoutMs: c.timeout_ms ?? 250, memoryMb: c.memory_mb ?? 16 });
        } catch (e) {
          throw new NodeError(`code: ${(e as Error).message}`, false, 'code_error');
        }
        return this.complete(tenantId, nr, graph, async () => ({ port: 'out', output }));
      }
      case 'command': {
        const input = render(c.input ?? {}, scope);
        return this.complete(tenantId, nr, graph, async (tx) => {
          const principal = await servicePrincipal(p, tx, tenantId, run.workflow_id, run.version_number);
          const r = await executeCommand(p, { ...writeCtx, principal, app: c.app, command: c.command, input }, tx);
          return { port: 'out', output: r.body };
        });
      }
      case 'record': {
        const values = render(c.values ?? {}, scope) as Record<string, unknown>;
        const id = c.id ? String(render(c.id, scope)) : undefined;
        return this.complete(tenantId, nr, graph, async (tx) => {
          const principal = await servicePrincipal(p, tx, tenantId, run.workflow_id, run.version_number);
          let version: number | undefined;
          if (c.op === 'update') {
            const cur = await tx.selectFrom('custom_record').select('version').where('id', '=', id!).where('entity', '=', c.entity).executeTakeFirst();
            if (!cur) throw new NodeError(`${c.entity} ${id} not found`, false, 'not_found');
            version = cur.version;
          }
          const r = await executeRecordWrite(p, { ...writeCtx, principal, entity: c.entity, op: c.op, ...(id ? { id } : {}), ...(version ? { version } : {}), values }, tx);
          return { port: 'out', output: r.body };
        });
      }
      case 'hub_send': {
        // Sent through the Hub (Webhooks port, retries, DLQ) as a `workflow.message`
        // addressed to this one endpoint.
        const body = render(c.body ?? {}, scope);
        return this.complete(tenantId, nr, graph, async (tx) => {
          const e = await tx.selectFrom('hub_endpoint').select(['id', 'status']).where('id', '=', c.endpoint_id).executeTakeFirst();
          if (!e) throw new NodeError('Hub endpoint not found', false, 'not_found');
          await recordChange(p, tx, {
            tenantId,
            actor: { type: 'Workflow', id: run.workflow_id },
            action: 'platform:workflow.hub_sent',
            resourceType: 'platform::WorkflowRun',
            resourceId: run.id,
            correlationId: run.correlation_id,
            events: [{ type: 'workflow.message', data: { endpoint_id: e.id, workflow_id: run.workflow_id, run_id: run.id, node: node.id, body: body as Record<string, unknown> } }],
            data: { node: node.id, endpoint_id: e.id },
            envelope: workflowEnvelope(run),
          });
          return { port: 'out', output: { endpoint_id: e.id, queued: true } };
        });
      }
      case 'notify': {
        const subject = String(render(c.subject, scope));
        const message = String(render(c.message, scope));
        // Queued through the outbox with the node's completion; the notifications consumer
        // calls the Channel port. Event data carries user ids, never addresses.
        return this.complete(tenantId, nr, graph, async (tx) => {
          const recipients = await tx
            .selectFrom('app_user')
            .select(['id'])
            .where('status', '=', 'active')
            .where((eb) => eb.or([eb('role', 'in', [...(c.roles ?? []), '__none__']), eb('id', 'in', [...(c.users ?? []), '00000000-0000-0000-0000-000000000000'])]))
            .execute();
          const users = recipients.map((r) => r.id as string);
          await recordChange(p, tx, {
            tenantId,
            actor: { type: 'Workflow', id: run.workflow_id },
            action: 'platform:workflow.notified',
            resourceType: 'platform::WorkflowRun',
            resourceId: run.id,
            correlationId: run.correlation_id,
            events: [{ type: 'workflow.notification', data: { workflow_id: run.workflow_id, run_id: run.id, node: node.id, users, subject, message } }],
            data: { node: node.id, subject, recipients: users.length },
            envelope: workflowEnvelope(run),
          });
          return { port: 'out', output: { subject, message, recipients: users } };
        });
      }
      case 'wait': {
        return this.complete(tenantId, nr, graph, async (tx) => {
          const seconds = c.mode === 'duration' ? Number(c.seconds) : Number(c.timeout_seconds);
          await tx
            .updateTable('workflow_node_run')
            .set({ status: 'waiting', lease_until: null, started_at: new Date(), not_before: new Date(Date.now() + seconds * 1000), wait_event: c.mode === 'event' ? c.event : null, state: json(c.mode === 'event' ? { filter: c.filter ?? null } : {}) })
            .where('id', '=', nr.id)
            .execute();
          return null;
        });
      }
      case 'approval': {
        const title = String(render(c.title, scope));
        const details = String(render(c.details ?? '', scope));
        return this.complete(tenantId, nr, graph, async (tx) => {
          const expires = new Date(Date.now() + Number(c.expires_in_hours ?? 72) * 3600_000);
          const requestId = newId();
          const ins = await tx
            .insertInto('approval_request')
            .values({ id: requestId, tenant_id: tenantId, source: 'workflow', source_ref: nr.id, title, details, approver_roles: c.approver_roles, quorum: c.quorum ?? 1, correlation_id: run.correlation_id, requested_by: run.initiated_by ?? `workflow:${run.workflow_id}`, expires_at: expires })
            .onConflict((oc) => oc.columns(['tenant_id', 'source', 'source_ref']).doNothing())
            .returning(['id', 'expires_at'])
            .executeTakeFirst();
          const req = ins ?? (await tx.selectFrom('approval_request').select(['id', 'expires_at']).where('source', '=', 'workflow').where('source_ref', '=', nr.id).executeTakeFirstOrThrow());
          await tx.updateTable('workflow_node_run').set({ status: 'waiting', lease_until: null, not_before: req.expires_at, state: json({ request_id: req.id }) }).where('id', '=', nr.id).execute();
          if (ins) {
            await recordChange(p, tx, {
              tenantId,
              actor: { type: 'System', id: 'workflows' },
              action: 'platform:approval.requested',
              resourceType: 'platform::ApprovalRequest',
              resourceId: req.id,
              correlationId: run.correlation_id,
              events: [{ type: 'approval.requested', data: { request_id: req.id, source: 'workflow', run_id: run.id, approver_roles: c.approver_roles, quorum: c.quorum ?? 1 } }],
            });
          }
          return null;
        });
      }
    }
  }

  /** A waiting node reached its `not_before`: duration over, event timeout, or approval expiry. */
  private async timeout(tenantId: string, nr: NodeRunRow, node: WorkflowNode) {
    const p = this.p;
    await p.database.withTenant(tenantId, async (tx) => {
      const run = await lockRun(tx, nr.run_id);
      const cur = await tx.selectFrom('workflow_node_run').select('status').where('id', '=', nr.id).executeTakeFirst();
      if (cur?.status !== 'running') return;
      if (run.status !== 'running') {
        await tx.updateTable('workflow_node_run').set({ status: 'cancelled', lease_until: null, finished_at: new Date() }).where('id', '=', nr.id).execute();
        return;
      }
      const graph = await loadGraph(tx, run.workflow_id, run.version_number);
      if (node.type === 'wait') {
        const c = node.config as { mode: string; seconds?: number };
        return finishNode(p, tx, run, graph, nr, c.mode === 'event' ? 'timeout' : 'out', c.mode === 'event' ? { timed_out: true } : { waited_seconds: c.seconds });
      }
      if (node.type === 'approval') {
        const id = nr.state.request_id as string;
        const expired = await tx.updateTable('approval_request').set({ status: 'expired', decided_at: new Date(), version: sql`version + 1` }).where('id', '=', id).where('status', '=', 'pending').returning('id').executeTakeFirst();
        const req = await tx.selectFrom('approval_request').select(['status']).where('id', '=', id).executeTakeFirstOrThrow();
        if (expired) {
          await recordChange(p, tx, { tenantId, actor: { type: 'System', id: 'workflows' }, action: 'platform:approval.expired', resourceType: 'platform::ApprovalRequest', resourceId: id, correlationId: run.correlation_id, events: [{ type: 'approval.resolved', data: { request_id: id, status: 'expired' } }] });
        }
        // Decided at the same moment the expiry fired: the decision stands.
        const outcome = req.status === 'approved' || req.status === 'rejected' ? req.status : 'expired';
        return finishNode(p, tx, run, graph, nr, outcome, { request_id: id, status: outcome });
      }
      // Anything else re-claimed from `waiting` is unexpected: run it again.
      await tx.updateTable('workflow_node_run').set({ status: 'pending', lease_until: null }).where('id', '=', nr.id).execute();
    });
  }
}

// ------------------------------------------------------------------ run DLQ

/** Retries a failed run from its failed node(s); branches cancelled by the failure come back too. */
export async function retryRun(p: Platform, tx: Tx, tenantId: string, actor: Principal, runId: string, correlationId: string) {
  const run = await lockRun(tx, runId);
  if (!run) throw new CommandError(404, 'not_found', 'run not found');
  if (run.status !== 'failed') throw new CommandError(409, 'not_failed', 'only failed runs can be retried');
  await assertActorCovers(p, tx, actor, run.workflow_id, run.version_number);
  const again = await tx
    .selectFrom('workflow_node_run')
    .select(['node_id', 'groups', 'input'])
    .where('run_id', '=', runId)
    .where((eb) => eb.or([eb('status', '=', 'failed'), eb.and([eb('status', '=', 'cancelled'), sql<boolean>`(state ->> 'revive') = 'true'`])]))
    .execute();
  for (const n of again) await insertNodeRun(tx, run, n.node_id, n.groups as string[], n.input);
  await tx.updateTable('workflow_node_run').set({ state: sql`state - 'revive'` }).where('run_id', '=', runId).execute();
  await tx.updateTable('workflow_run').set({ status: 'running', error: null, finished_at: null, version: sql`version + 1` }).where('id', '=', runId).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:workflow.run_retried', resourceType: 'platform::WorkflowRun', resourceId: runId, correlationId, data: { nodes: again.map((n) => n.node_id), run_correlation: run.correlation_id } });
  return { retried: again.map((n) => n.node_id) };
}

export async function cancelRun(p: Platform, tx: Tx, tenantId: string, actor: Principal, runId: string, correlationId: string) {
  const run = await lockRun(tx, runId);
  if (!run) throw new CommandError(404, 'not_found', 'run not found');
  if (run.status !== 'running' && run.status !== 'failed') throw new CommandError(409, 'not_cancellable', `the run is ${run.status}`);
  await cancelOpen(p, tx, run, 'cancelled by a user');
  await tx.updateTable('workflow_run').set({ status: 'cancelled', finished_at: new Date(), version: sql`version + 1` }).where('id', '=', runId).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:workflow.run_cancelled', resourceType: 'platform::WorkflowRun', resourceId: runId, correlationId, data: { run_correlation: run.correlation_id } });
}
