import { randomUUID } from 'node:crypto';
import { EndpointInput, type EventEnvelope, type Principal, type WorkflowGraph } from '@aod/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { principalFor } from '../src/auth/principal.ts';
import { createSession, SESSION_COOKIE } from '../src/auth/sessions.ts';
import { buildApp } from '../src/http/app.ts';
import { newId, type Tx } from '../src/db/database.ts';
import { decideApproval } from '../src/platform/approvals.ts';
import { writeOutbox } from '../src/platform/outbox.ts';
import { traceQuery } from '../src/platform/trace.ts';
import { createWorkflow, publishWorkflow, rollbackWorkflow, saveDraft, setWorkflowStatus } from '../src/platform/workflows/definitions.ts';
import { dryRun } from '../src/platform/workflows/dryrun.ts';
import { cancelRun, retryRun, workflowsConsumer } from '../src/platform/workflows/engine.ts';
import { saveEndpoint } from '../src/platform/hub.ts';
import { closePlatform, cmd, newTenant, runSaga, setPlan, testPlatform, type TestTenant } from './helpers.ts';

const p = testPlatform();
let t: TestTenant;
const cid = () => randomUUID();
let managerA: { id: string; principal: Principal };
let managerB: { id: string; principal: Principal };
let registerId: string;

const inTenant = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => p.database.withTenant(t.tenantId, fn);
const settle = async () => {
  for (let i = 0; i < 30; i++) {
    await p.ports.eventBus.drain();
    const n = await p.workers.workflows.tick(50);
    if (n === 0) {
      await p.ports.eventBus.drain();
      if ((await p.workers.workflows.tick(50)) === 0) return;
    }
  }
};

async function publish(name: string, graph: WorkflowGraph, role = 'Manager', actor: Principal = t.owner) {
  const { id } = await inTenant((tx) => createWorkflow(p, tx, t.tenantId, actor, { name, graph }, cid()));
  const d = await inTenant((tx) => saveDraft(p, tx, t.tenantId, actor, id, graph, undefined, undefined, cid()));
  expect(d.problems).toEqual([]);
  await inTenant((tx) => publishWorkflow(p, tx, t.tenantId, actor, id, d.version, role, cid()));
  return id;
}

const runsOf = (workflowId: string) => inTenant((tx) => tx.selectFrom('workflow_run').selectAll().where('workflow_id', '=', workflowId).orderBy('started_at').execute());
const nodesOf = (runId: string) => inTenant((tx) => tx.selectFrom('workflow_node_run').selectAll().where('run_id', '=', runId).orderBy('created_at').execute());

async function sale(total: number, tender: 'card' | 'cash' = 'card') {
  const id = randomUUID();
  const qty = Math.round(total / 50000);
  const r = await cmd(p, t, 'pos', 'sale.complete', { id, register_id: registerId, lines: [{ sku: 'X', name: 'Hamper', qty, unit_price: 50000 }], tender, sold_at: new Date().toISOString() });
  await settle();
  return { id, version: r.body.version as number, total: qty * 50000 };
}

async function voidSale(s: { id: string; version: number }) {
  const correlationId = randomUUID();
  const { executeCommand } = await import('../src/platform/commands.ts');
  await executeCommand(p, { tenantId: t.tenantId, principal: t.owner, app: 'pos', command: 'sale.void', input: { id: s.id, version: s.version, reason: 'customer changed mind' }, correlationId });
  await settle();
  return correlationId;
}

const node = (id: string, type: string, config: Record<string, unknown> = {}, name = id) => ({ id, type, name, position: { x: 0, y: 0 }, config }) as WorkflowGraph['nodes'][number];
const edge = (from: string, port: string, to: string) => ({ id: `${from}-${port}-${to}`, from, port, to });

/** J3: void over Rp 1,000,000 → manager approval → approved: refund + notify store; rejected: notify cashier. */
const J3: WorkflowGraph = {
  nodes: [
    node('trigger', 'trigger', { event: 'sale.voided', filter: 'trigger.data.total > 1000000' }, 'Large void'),
    node('approve', 'approval', { title: 'Refund voided sale {{ trigger.data.receipt_no }}', details: 'Total {{ trigger.data.total }}', approver_roles: ['Manager'], quorum: 1, expires_in_hours: 24 }),
    node('refund', 'command', { app: 'payments', command: 'payment.refund_by_reference', input: { reference: 'pos:sale:{{ trigger.data.sale_id }}', reason: 'voided: {{ trigger.data.reason }}' } }),
    node('notify_store', 'notify', { roles: ['Manager'], subject: 'Refund issued for {{ trigger.data.receipt_no }}', message: 'Refunded {{ steps.refund.output.refunded }}.' }),
    node('notify_cashier', 'notify', { roles: ['Staff'], subject: 'Void refund rejected', message: 'The refund for {{ trigger.data.receipt_no }} was rejected.' }),
  ],
  edges: [edge('trigger', 'out', 'approve'), edge('approve', 'approved', 'refund'), edge('refund', 'out', 'notify_store'), edge('approve', 'rejected', 'notify_cashier')],
};

const sent: { to: string; subject: string }[] = [];
const realSend = p.ports.channel.send.bind(p.ports.channel);
p.ports.channel.send = async (m) => {
  sent.push({ to: m.to, subject: m.subject });
  return realSend(m);
};

beforeAll(async () => {
  t = await newTenant(p, 'wf');
  await setPlan(p, t, 'growth');
  for (const app of ['ordering', 'payments', 'pos']) expect((await runSaga(p, t, app)).status).toBe('succeeded');
  const mk = async (name: string, role: string) => {
    const id = newId();
    await inTenant((tx) => tx.insertInto('app_user').values({ id, tenant_id: t.tenantId, email: `${name}@wf.example`, name, role, status: 'active' }).execute());
    return { id, principal: await inTenant((tx) => principalFor(tx, p.catalog, t.tenantId, { id, role })) };
  };
  managerA = await mk('mara', 'Manager');
  managerB = await mk('budi', 'Manager');
  await mk('citra', 'Staff');
  registerId = ((await inTenant((tx) => tx.selectFrom('pos_register').select('id').execute())) as { id: string }[])[0]!.id;
  await cmd(p, t, 'pos', 'shift.open', { register_id: registerId });
});

afterAll(async () => {
  await p.workers.workflows.stop();
  await closePlatform(p);
});

describe('J3: approval-gated refund', () => {
  let workflowId: string;

  it('test-runs the draft on a past void with every node input and output, changing nothing', async () => {
    const s = await sale(1_200_000);
    await voidSale(s);
    const ev = await inTenant((tx) => tx.selectFrom('event_log').select('payload').where('type', '=', 'sale.voided').orderBy('seq', 'desc').executeTakeFirstOrThrow());
    const r = await dryRun(p, J3, ev.payload as EventEnvelope, { approval: 'approved' });
    expect(r.error).toBeNull();
    expect(r.path).toEqual(['trigger', 'approve', 'refund', 'notify_store']);
    const refund = r.steps.find((x) => x.node === 'refund')!;
    expect(refund.input).toEqual({ reference: `pos:sale:${s.id}`, reason: 'voided: customer changed mind' });
    expect(refund.output).toMatchObject({ dry_run: true, would_run: 'payments/payment.refund_by_reference' });
    const approve = r.steps.find((x) => x.node === 'approve')!;
    expect(approve.input).toMatchObject({ title: expect.stringContaining('Refund voided sale'), approver_roles: ['Manager'] });
    const rejected = await dryRun(p, J3, ev.payload as EventEnvelope, { approval: 'rejected' });
    expect(rejected.path).toEqual(['trigger', 'approve', 'notify_cashier']);
    // Nothing happened for real.
    const pay = await inTenant((tx) => tx.selectFrom('pay_payment').select('status').where('reference', '=', `pos:sale:${s.id}`).executeTakeFirstOrThrow());
    expect(pay.status).toBe('captured');
    expect(await inTenant((tx) => tx.selectFrom('approval_request').select('id').execute())).toHaveLength(0);
  });

  it('a real void pauses at Approvals; a second manager approves; refund and notification run once', async () => {
    workflowId = await publish('Large void refund', J3, 'Manager', managerA.principal);
    const small = await sale(300_000);
    await voidSale(small);
    expect(await runsOf(workflowId)).toHaveLength(0); // filter: only voids over Rp 1,000,000

    const s = await sale(1_500_000);
    const correlationId = await voidSale(s);
    const [run] = await runsOf(workflowId);
    expect(run).toMatchObject({ status: 'running', correlation_id: correlationId, hop: 1, chain: [workflowId] });
    const waiting = (await nodesOf(run!.id)).find((n) => n.node_id === 'approve')!;
    expect(waiting.status).toBe('waiting');
    const [req] = await inTenant((tx) => tx.selectFrom('approval_request').selectAll().where('source_ref', '=', waiting.id).execute());
    expect(req).toMatchObject({ status: 'pending', approver_roles: ['Manager'], quorum: 1, correlation_id: correlationId });

    // Staff cannot decide; a Manager can.
    const staff = await inTenant((tx) => principalFor(tx, p.catalog, t.tenantId, { id: t.ownerId, role: 'Staff' }));
    await expect(inTenant((tx) => decideApproval(p, tx, t.tenantId, { id: newId(), role: 'Staff', principal: staff }, req!.id, 'approve', '', cid()))).rejects.toMatchObject({ code: 'not_an_approver' });
    // The user whose void started the chain cannot approve its refund.
    expect(req!.requested_by).toBe(t.ownerId);
    await expect(inTenant((tx) => decideApproval(p, tx, t.tenantId, { id: t.ownerId, role: 'Owner', principal: t.owner }, req!.id, 'approve', '', cid()))).rejects.toMatchObject({ code: 'own_request' });
    const decided = await inTenant((tx) => decideApproval(p, tx, t.tenantId, { id: managerB.id, role: 'Manager', principal: managerB.principal }, req!.id, 'approve', 'ok, receipt checked', cid()));
    expect(decided.status).toBe('approved');
    await expect(inTenant((tx) => decideApproval(p, tx, t.tenantId, { id: managerA.id, role: 'Manager', principal: managerA.principal }, req!.id, 'approve', '', cid()))).rejects.toMatchObject({ code: 'already_resolved' });
    await settle();

    const done = (await runsOf(workflowId))[0]!;
    expect(done.status).toBe('succeeded');
    const nodes = await nodesOf(done.id);
    expect(nodes.filter((n) => n.status === 'succeeded').map((n) => `${n.node_id}:${n.port}`)).toEqual(['trigger:out', 'approve:approved', 'refund:out', 'notify_store:out']);
    const notified = nodes.find((n) => n.node_id === 'notify_store')!.output as { subject: string; recipients: string[] };
    expect(notified.subject).toContain('Refund issued');
    expect(notified.recipients).toEqual(expect.arrayContaining([managerA.id, managerB.id]));
    // Sent through the outbox: one workflow.notification event, delivered by its consumer.
    const note = await inTenant((tx) => tx.selectFrom('event_log').select(['id', 'payload']).where('type', '=', 'workflow.notification').where(sql<string>`payload ->> 'correlation_id'`, '=', correlationId).execute());
    expect(note).toHaveLength(1);
    expect(note[0]!.payload).toMatchObject({ origin: 'workflow', workflow_hop: 1, workflow_chain: [workflowId] });
    expect(JSON.stringify(note[0]!.payload)).not.toContain('@'); // user ids, never addresses
    expect(sent.filter((m) => m.subject.startsWith('Refund issued'))).toHaveLength(notified.recipients.length);
    const pay = await inTenant((tx) => tx.selectFrom('pay_payment').select('status').where('reference', '=', `pos:sale:${s.id}`).executeTakeFirstOrThrow());
    expect(pay.status).toBe('refunded');

    // The refund event carries the loop-protection fields.
    const refunded = await inTenant((tx) => tx.selectFrom('event_log').select('payload').where('type', '=', 'payment.refunded').orderBy('seq', 'desc').executeTakeFirstOrThrow());
    expect(refunded.payload).toMatchObject({ origin: 'workflow', workflow_hop: 1, workflow_chain: [workflowId], correlation_id: correlationId });
    // Audited: the decision and the command as the workflow's service principal.
    const audit = await inTenant((tx) => tx.selectFrom('audit_log').select(['action', 'actor_type', 'actor_id']).where('correlation_id', '=', correlationId).execute());
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'platform:approval.approve', actor_id: managerB.id }),
      expect.objectContaining({ action: 'payments:payment.refund_by_reference', actor_type: 'Workflow', actor_id: workflowId }),
      expect.objectContaining({ action: 'platform:workflow.notified' }),
    ]));

    // Trace viewer: the whole chain from one correlation id.
    const tr = await inTenant((tx) => traceQuery(tx, correlationId));
    const kinds = new Set(tr.items.map((i) => i.kind));
    for (const k of ['audit', 'event', 'consumer', 'run', 'node', 'approval', 'decision']) expect(kinds, k).toContain(k);
    expect(tr.items.map((i) => i.title)).toEqual(expect.arrayContaining(['sale.voided', 'payment.refunded', 'Workflow: Large void refund', 'platform.workflows']));
    // Also found from the run id and the sale (record) id.
    expect((await inTenant((tx) => traceQuery(tx, done.id))).correlation_ids).toEqual([correlationId]);
    expect((await inTenant((tx) => traceQuery(tx, s.id))).correlation_ids).toContain(correlationId);
  });

  it('a rejection takes the rejected output and notifies the cashier', async () => {
    const s = await sale(2_000_000);
    await voidSale(s);
    const run = (await runsOf(workflowId)).at(-1)!;
    const req = await inTenant((tx) => tx.selectFrom('approval_request').selectAll().where('status', '=', 'pending').executeTakeFirstOrThrow());
    await inTenant((tx) => decideApproval(p, tx, t.tenantId, { id: managerA.id, role: 'Manager', principal: managerA.principal }, req.id, 'reject', 'not eligible', cid()));
    await settle();
    const nodes = await nodesOf(run.id);
    expect(nodes.map((n) => n.node_id)).toEqual(['trigger', 'approve', 'notify_cashier']);
    expect(nodes[1]!.port).toBe('rejected');
    expect((await runsOf(workflowId)).at(-1)!.status).toBe('succeeded');
    const pay = await inTenant((tx) => tx.selectFrom('pay_payment').select('status').where('reference', '=', `pos:sale:${s.id}`).executeTakeFirstOrThrow());
    expect(pay.status).toBe('captured');
  });

  it('expiry takes the expired output', async () => {
    const s = await sale(1_100_000);
    await voidSale(s);
    const run = (await runsOf(workflowId)).at(-1)!;
    const approve = (await nodesOf(run.id)).find((n) => n.node_id === 'approve')!;
    const past = new Date(Date.now() - 1000);
    await inTenant(async (tx) => {
      await tx.updateTable('approval_request').set({ expires_at: past }).where('source_ref', '=', approve.id).execute();
      await tx.updateTable('workflow_node_run').set({ not_before: past }).where('id', '=', approve.id).execute();
    });
    await settle();
    const after = await nodesOf(run.id);
    expect(after.find((n) => n.node_id === 'approve')!.port).toBe('expired');
    expect((await runsOf(workflowId)).at(-1)!.status).toBe('succeeded');
    const req = await inTenant((tx) => tx.selectFrom('approval_request').select('status').where('source_ref', '=', approve.id).executeTakeFirstOrThrow());
    expect(req.status).toBe('expired');
  });
});

describe('publishing', () => {
  it('rejects an invalid graph and a service role above the publisher, or too narrow for the graph', async () => {
    const bad: WorkflowGraph = { nodes: [node('trigger', 'trigger', { event: 'order.created' }), node('x', 'command', { app: 'ordering', command: 'nope', input: {} })], edges: [edge('trigger', 'out', 'x')] };
    const { id } = await inTenant((tx) => createWorkflow(p, tx, t.tenantId, t.owner, { name: 'Bad', graph: bad }, cid()));
    await expect(inTenant((tx) => publishWorkflow(p, tx, t.tenantId, t.owner, id, 1, 'Manager', cid()))).rejects.toMatchObject({ status: 422, code: 'invalid_workflow' });

    const ok: WorkflowGraph = { nodes: [node('trigger', 'trigger', { event: 'sale.voided' }), node('r', 'command', { app: 'payments', command: 'payment.refund_by_reference', input: { reference: 'x' } })], edges: [edge('trigger', 'out', 'r')] };
    const { id: id2 } = await inTenant((tx) => createWorkflow(p, tx, t.tenantId, managerA.principal, { name: 'Cap', graph: ok }, cid()));
    await expect(inTenant((tx) => publishWorkflow(p, tx, t.tenantId, managerA.principal, id2, 1, 'Admin', cid()))).rejects.toMatchObject({ status: 403, code: 'role_exceeds_publisher' });
    await expect(inTenant((tx) => publishWorkflow(p, tx, t.tenantId, managerA.principal, id2, 1, 'Staff', cid()))).rejects.toMatchObject({ status: 422, code: 'role_too_narrow' });
    await inTenant((tx) => publishWorkflow(p, tx, t.tenantId, managerA.principal, id2, 1, 'Manager', cid()));
    await inTenant((tx) => tx.updateTable('workflow').set({ status: 'disabled' }).where('id', '=', id2).execute());
  });

  it('rolls back by re-publishing an earlier version as a new number', async () => {
    const g1: WorkflowGraph = { nodes: [node('trigger', 'trigger', { event: 'shift.closed' }), node('s', 'set', { vars: { v: 1 } })], edges: [edge('trigger', 'out', 's')] };
    const g2: WorkflowGraph = { nodes: [node('trigger', 'trigger', { event: 'shift.closed' }), node('s', 'set', { vars: { v: 2 } })], edges: [edge('trigger', 'out', 's')] };
    const id = await publish('Versions', g1);
    const d = await inTenant((tx) => saveDraft(p, tx, t.tenantId, t.owner, id, g2, undefined, undefined, cid()));
    expect(d.number).toBe(2);
    await inTenant((tx) => publishWorkflow(p, tx, t.tenantId, t.owner, id, d.version, 'Manager', cid()));
    const r = await inTenant((tx) => rollbackWorkflow(p, tx, t.tenantId, t.owner, id, 1, undefined, cid()));
    expect(r.number).toBe(3);
    const versions = await inTenant((tx) => tx.selectFrom('workflow_version').select(['number', 'status', 'based_on', 'graph']).where('workflow_id', '=', id).orderBy('number').execute());
    expect(versions.map((v) => v.status)).toEqual(['superseded', 'superseded', 'published']);
    expect((versions[2]!.graph as WorkflowGraph).nodes[1]!.config).toEqual({ vars: { v: 1 } });
    await inTenant((tx) => tx.updateTable('workflow').set({ status: 'disabled' }).where('id', '=', id).execute());
  });
});

describe('engine guarantees', () => {
  const orderGraph = (extra: WorkflowGraph['nodes'], edges: WorkflowGraph['edges'], filter?: string): WorkflowGraph => ({
    nodes: [node('trigger', 'trigger', { event: 'order.created', ...(filter ? { filter } : {}) }), ...extra],
    edges,
  });
  const order = async (channel: 'web' | 'phone' = 'phone', total = 10000) => {
    const r = await cmd(p, t, 'ordering', 'order.create', { channel, lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: total }] });
    await settle();
    return r.body as { id: string; version: number };
  };
  const disable = (id: string) => inTenant((tx) => tx.updateTable('workflow').set({ status: 'disabled' }).where('id', '=', id).execute());

  it('loop guard: a workflow is never re-entered from its own chain; hop guard stops at hop 5', async () => {
    // Two workflows that each create an order on order.created ping-pong once, then stop.
    const mk = (tag: string) =>
      orderGraph([node('again', 'command', { app: 'ordering', command: 'order.create', input: { channel: 'phone', customer_name: tag, lines: [{ sku: 'L', name: 'Loop', qty: 1, unit_price: 1 }] } })], [edge('trigger', 'out', 'again')], "trigger.data.channel != 'web' or trigger.data.channel == 'web'");
    const w1 = await publish('Ping', mk('ping'));
    const w2 = await publish('Pong', mk('pong'));
    await order('web');
    const r1 = await runsOf(w1);
    const r2 = await runsOf(w2);
    // user event (hop 0) starts both; each emits an event (hop 1) that starts only the other;
    // those emit hop-2 events whose chain holds both, so nothing else runs.
    expect(r1.filter((r) => r.status === 'succeeded')).toHaveLength(2);
    expect(r2.filter((r) => r.status === 'succeeded')).toHaveLength(2);
    const guarded = [...r1, ...r2].filter((r) => r.status === 'cancelled');
    expect(guarded.length).toBeGreaterThan(0);
    expect(guarded.every((r) => r.error!.startsWith('loop guard'))).toBe(true);
    expect(Math.max(...[...r1, ...r2].map((r) => r.hop))).toBeLessThanOrEqual(3);

    // Hop guard: an event already 5 hops deep never starts a run.
    await disable(w2);
    await inTenant((tx) => writeOutbox(tx, [{ type: 'order.created', aggregateType: 'order', aggregateId: newId(), data: { order_id: newId(), channel: 'web', total: 1 } }], { tenantId: t.tenantId, app: 'ordering', correlationId: 'hop-test', origin: 'workflow', workflowHop: 5, workflowChain: ['someone-else'], newId }));
    await settle();
    const hopRun = (await runsOf(w1)).find((r) => r.correlation_id === 'hop-test')!;
    expect(hopRun.status).toBe('cancelled');
    expect(hopRun.error).toMatch(/^hop limit/);
    await disable(w1);
  });

  it('chain limit: one change starts at most workflow_runs_per_chain runs (configurable per plan)', async () => {
    const limits = p.config.plans.growth!.limits;
    const before = limits.workflow_runs_per_chain;
    limits.workflow_runs_per_chain = 3;
    try {
      const mk = (tag: string) =>
        orderGraph([node('again', 'command', { app: 'ordering', command: 'order.create', input: { channel: 'phone', customer_name: tag, lines: [{ sku: 'C', name: 'Chain', qty: 1, unit_price: 2 }] } })], [edge('trigger', 'out', 'again')], 'trigger.data.total == 7001 or trigger.data.total == 2');
      const a = await publish('Chain A', mk('a'));
      const b = await publish('Chain B', mk('b'));
      const r = await cmd(p, t, 'ordering', 'order.create', { channel: 'web', lines: [{ sku: 'C', name: 'C', qty: 1, unit_price: 7001 }] });
      await settle();
      const ev = await inTenant((tx) => tx.selectFrom('event_log').select('payload').where('aggregateid', '=', r.body.id).where('type', '=', 'order.created').executeTakeFirstOrThrow());
      const corr = (ev.payload as EventEnvelope).correlation_id;
      const chain = await inTenant((tx) => tx.selectFrom('workflow_run').select(['status', 'error']).where('correlation_id', '=', corr).execute());
      // Without the budget this chain runs 4 times (2 workflows × 2 hops before the loop guard).
      expect(chain.filter((x) => x.status !== 'cancelled')).toHaveLength(3);
      expect(chain.some((x) => x.status === 'cancelled' && x.error!.startsWith('chain limit: 3'))).toBe(true);
      await disable(a);
      await disable(b);
    } finally {
      limits.workflow_runs_per_chain = before;
    }
  });

  it('exactly once: a re-delivered trigger starts one run; a node processed twice runs its command once', async () => {
    const g = orderGraph([node('adv', 'command', { app: 'ordering', command: 'order.advance', input: { id: '{{ trigger.data.order_id }}', version: 1 } })], [edge('trigger', 'out', 'adv')], 'trigger.data.total == 5001');
    const w = await publish('Advance kiosk orders', g);
    const r = await cmd(p, t, 'ordering', 'order.create', { channel: 'phone', lines: [{ sku: 'A', name: 'A', qty: 1, unit_price: 5001 }] });
    await p.ports.eventBus.drain();
    const ev = await inTenant((tx) => tx.selectFrom('event_log').select('payload').where('aggregateid', '=', r.body.id).where('type', '=', 'order.created').executeTakeFirstOrThrow());
    // Re-deliver the same event to the consumer: still one run.
    await inTenant((tx) => workflowsConsumer(p).handle(ev.payload as EventEnvelope, tx));
    expect(await runsOf(w)).toHaveLength(1);
    // Claim the command node, then process it twice concurrently.
    const [claimed] = (await sql<{ tenant_id: string; id: string; claimed_from: string }>`SELECT * FROM workflow_claim_nodes(10, 60)`.execute(p.database.db)).rows;
    expect(claimed).toBeDefined();
    await Promise.all([p.workers.workflows.process(claimed!.tenant_id, claimed!.id, claimed!.claimed_from), p.workers.workflows.process(claimed!.tenant_id, claimed!.id, claimed!.claimed_from)]);
    await settle();
    const changes = await inTenant((tx) => tx.selectFrom('event_log').select('id').where('aggregateid', '=', r.body.id).where('type', '=', 'order.status_changed').execute());
    expect(changes).toHaveLength(1);
    expect((await runsOf(w))[0]!.status).toBe('succeeded');
    await disable(w);
  });

  it('parallel branches meet at the merge once, with both outputs', async () => {
    const g = orderGraph(
      [node('fork', 'parallel'), node('a', 'set', { vars: { a: '{{ trigger.data.total }}' } }), node('b', 'code', { source: 'function transform(input) { return { doubled: input.trigger.data.total * 2 }; }' }), node('join', 'merge', { parallel: 'fork' }), node('after', 'set', { vars: { both: '{{ steps.join.output.branches }}' } })],
      [edge('trigger', 'out', 'fork'), edge('fork', 'out', 'a'), edge('fork', 'out', 'b'), edge('a', 'out', 'join'), edge('b', 'out', 'join'), edge('join', 'out', 'after')],
      'trigger.data.total == 700',
    );
    const w = await publish('Fan out', g);
    await order('phone', 700);
    const [run] = await runsOf(w);
    expect(run!.status, String(run!.error)).toBe('succeeded');
    const nodes = await nodesOf(run!.id);
    expect(nodes.filter((n) => n.node_id === 'join')).toHaveLength(1);
    expect(nodes.filter((n) => n.node_id === 'after')).toHaveLength(1);
    expect(run!.vars).toMatchObject({ a: 700, both: { a: { a: 700 }, b: { doubled: 1400 } } });
    await disable(w);
  });

  it('waits for an event (resumed by the consumer) and times out otherwise', async () => {
    const g = orderGraph(
      [
        node('hold', 'wait', { mode: 'event', event: 'order.status_changed', filter: 'event.data.order_id == trigger.data.order_id', timeout_seconds: 3600 }),
        node('moved', 'set', { vars: { moved_to: '{{ steps.hold.output.data.to }}' } }),
        node('late', 'set', { vars: { late: true } }),
      ],
      [edge('trigger', 'out', 'hold'), edge('hold', 'event', 'moved'), edge('hold', 'timeout', 'late')],
      'trigger.data.total >= 9000 and trigger.data.total < 9100',
    );
    const w = await publish('Wait for advance', g);
    const o1 = await order('phone', 9001);
    const o2 = await order('phone', 9002);
    const runs = await runsOf(w);
    expect(runs.map((r) => r.status)).toEqual(['running', 'running']);
    // Another order's change does not resume the first run.
    await cmd(p, t, 'ordering', 'order.advance', { id: o1.id, version: o1.version });
    await settle();
    const [a, b] = await runsOf(w);
    expect(a!.status).toBe('succeeded');
    expect(a!.vars).toMatchObject({ moved_to: expect.any(String) });
    expect(b!.status).toBe('running');
    // Time out the second.
    const hold = (await nodesOf(b!.id)).find((n) => n.node_id === 'hold')!;
    await inTenant((tx) => tx.updateTable('workflow_node_run').set({ not_before: new Date(Date.now() - 1000) }).where('id', '=', hold.id).execute());
    await settle();
    const b2 = (await runsOf(w))[1]!;
    expect(b2.status).toBe('succeeded');
    expect(b2.vars).toEqual({ late: true });
    void o2;
    await disable(w);
  });

  it('a failing node fails the run (run DLQ); retry from the failed node succeeds; an error output catches failures', async () => {
    const g = orderGraph(
      [node('refund', 'command', { app: 'payments', command: 'payment.refund_by_reference', input: { reference: 'order:{{ trigger.data.order_id }}' } })],
      [edge('trigger', 'out', 'refund')],
      'trigger.data.total == 4200',
    );
    const w = await publish('Refund order', g);
    const o = await order('phone', 4200);
    const [run] = await runsOf(w);
    expect(run!.status).toBe('failed');
    expect(run!.error).toMatch(/^refund: .*not found/);
    // Fix the cause, retry from the failed node.
    await cmd(p, t, 'payments', 'payment.capture', { reference: `order:${o.id}`, amount: 4200 });
    await inTenant((tx) => retryRun(p, tx, t.tenantId, t.owner, run!.id, cid()));
    await settle();
    expect((await runsOf(w))[0]!.status).toBe('succeeded');
    const pay = await inTenant((tx) => tx.selectFrom('pay_payment').select('status').where('reference', '=', `order:${o.id}`).executeTakeFirstOrThrow());
    expect(pay.status).toBe('refunded');
    await disable(w);

    const caught = orderGraph(
      [node('refund', 'command', { app: 'payments', command: 'payment.refund_by_reference', input: { reference: 'missing:{{ trigger.data.order_id }}' } }), node('oops', 'set', { vars: { failed: '{{ steps.refund.output.code }}' } })],
      [edge('trigger', 'out', 'refund'), edge('refund', 'error', 'oops')],
      'trigger.data.total == 4300',
    );
    const w2 = await publish('Refund with fallback', caught);
    await order('phone', 4300);
    const [r2] = await runsOf(w2);
    expect(r2!.status).toBe('succeeded');
    expect(r2!.vars).toEqual({ failed: 'not_found' });
    await disable(w2);
  });

  it('the service principal never exceeds the role chosen at publish', async () => {
    // A Staff-role workflow may advance orders but not refund: publish refuses the refund node,
    // and a permission removed from a custom role after publish is denied at run time.
    const roleId = newId();
    await inTenant((tx) => tx.insertInto('custom_role').values({ id: roleId, tenant_id: t.tenantId, name: 'Order bot', permissions: ['ordering:order.fulfil', 'ordering:order.read'] }).execute());
    const g = orderGraph([node('adv', 'command', { app: 'ordering', command: 'order.advance', input: { id: '{{ trigger.data.order_id }}', version: 1 } })], [edge('trigger', 'out', 'adv')], 'trigger.data.total == 4400');
    const w = await publish('Bot advance', g, roleId);
    await inTenant((tx) => tx.updateTable('custom_role').set({ permissions: ['ordering:order.read'] }).where('id', '=', roleId).execute());
    await order('phone', 4400);
    const [run] = await runsOf(w);
    expect(run!.status).toBe('failed');
    expect(run!.error).toMatch(/missing permission ordering:order.fulfil/);
    await disable(w);
  });
});

describe('HTTP: workflows, approvals, trace', () => {
  let app: FastifyInstance;
  let staffCookie: string;
  let ownerCookie: string;
  const json = (cookie: string) => ({ 'content-type': 'application/json', cookie });
  beforeAll(async () => {
    app = await buildApp(p);
    const staffId = (await inTenant((tx) => tx.selectFrom('app_user').select('id').where('role', '=', 'Staff').executeTakeFirstOrThrow())).id as string;
    staffCookie = `${SESSION_COOKIE}=${(await inTenant((tx) => createSession(tx, t.tenantId, staffId, 'magic_link'))).cookie}`;
    ownerCookie = `${SESSION_COOKIE}=${t.cookie}`;
  });
  afterAll(() => app.close());

  it('builds, validates, test-runs and publishes over HTTP; Staff cannot manage or trace', async () => {
    const meta = await app.inject({ url: '/api/workflows/meta', headers: { cookie: ownerCookie } });
    expect(meta.statusCode).toBe(200);
    const m = meta.json();
    expect(m.events.map((e: any) => e.type)).toContain('sale.voided');
    expect(m.commands.find((c: any) => c.command === 'payment.refund_by_reference').input).toMatchObject({ type: 'object' });
    expect(m.templates.length).toBeGreaterThan(0);

    const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: json(ownerCookie), payload: { name: 'From template', template: { app: 'ordering', name: 'auto_confirm_small' } } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const got = (await app.inject({ url: `/api/workflows/${id}`, headers: { cookie: ownerCookie } })).json();
    expect(got.graph.nodes.map((n: any) => n.type)).toEqual(['trigger', 'condition', 'command']);
    expect(got.problems).toEqual([]);

    const test = await app.inject({ method: 'POST', url: `/api/workflows/${id}/test`, headers: json(ownerCookie), payload: { sample: { data: { order_id: randomUUID(), channel: 'web', total: 5000 } } } });
    expect(test.statusCode).toBe(200);
    expect(test.json().path).toEqual(['trigger', 'check', 'action']);
    expect(test.json().steps[2]).toMatchObject({ status: 'failed', error: expect.stringContaining('id') }); // template has no input yet

    // Only past events of the trigger's own type can be replayed (no reading arbitrary events).
    const other = await inTenant((tx) => tx.selectFrom('event_log').select('id').where('type', '<>', 'order.created').limit(1).executeTakeFirstOrThrow());
    const wrong = await app.inject({ method: 'POST', url: `/api/workflows/${id}/test`, headers: json(ownerCookie), payload: { event_id: other.id } });
    expect(wrong.statusCode).toBe(404);

    const v = await app.inject({ method: 'POST', url: '/api/workflows/validate', headers: json(ownerCookie), payload: { graph: { nodes: [{ id: 'a', type: 'set', name: 'A', config: { vars: { x: 1 } } }], edges: [] } } });
    expect(v.json().problems).toContain('a workflow needs exactly one trigger (has 0)');

    const pub = await app.inject({ method: 'POST', url: `/api/workflows/${id}/publish`, headers: json(ownerCookie), payload: { version: got.current.version, service_role: 'Staff' } });
    expect(pub.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/workflows/${id}/status`, headers: json(ownerCookie), payload: { status: 'disabled' } });

    expect((await app.inject({ method: 'POST', url: '/api/workflows', headers: json(staffCookie), payload: { name: 'nope' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/workflows', headers: { cookie: staffCookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/trace?q=abc', headers: { cookie: staffCookie } })).statusCode).toBe(403);
    // Staff sees no approval addressed to Managers.
    expect((await app.inject({ url: '/api/approvals?status=all', headers: { cookie: staffCookie } })).json().requests).toEqual([]);
  });

  it('lists runs and the execution view; the owner sees approvals; trace resolves an event id', async () => {
    const runs = (await app.inject({ url: '/api/workflow-runs?status=succeeded', headers: { cookie: ownerCookie } })).json().runs;
    expect(runs.length).toBeGreaterThan(0);
    const view = (await app.inject({ url: `/api/workflow-runs/${runs[0].id}`, headers: { cookie: ownerCookie } })).json();
    expect(view.graph.nodes.length).toBeGreaterThan(0);
    expect(view.nodes.length).toBeGreaterThan(0);
    const approvals = (await app.inject({ url: '/api/approvals?status=decided', headers: { cookie: ownerCookie } })).json().requests;
    expect(approvals.some((a: any) => a.decisions.length > 0)).toBe(true);
    const tr = (await app.inject({ url: `/api/trace?q=${runs[0].trigger_event_id}`, headers: { cookie: ownerCookie } })).json();
    expect(tr.correlation_ids).toEqual([runs[0].correlation_id]);
    expect(tr.items.some((i: any) => i.kind === 'run')).toBe(true);
  });
});

describe('authorization of what a workflow may do', () => {
  const noop = (event: string): WorkflowGraph => ({ nodes: [node('trigger', 'trigger', { event }), node('s', 'set', { vars: { x: 1 } })], edges: [edge('trigger', 'out', 's')] });

  it('refuses a service role with looser field access than the publisher', async () => {
    const strict: Principal = { ...managerA.principal, roles: managerA.principal.roles.map((r) => ({ ...r, fieldRules: [...r.fieldRules, { resource: 'payments::Payment', field: 'amount', access: 'hidden' as const }] })) };
    const { id } = await inTenant((tx) => createWorkflow(p, tx, t.tenantId, strict, { name: 'Field cap', graph: noop('payment.refunded') }, cid()));
    await expect(inTenant((tx) => publishWorkflow(p, tx, t.tenantId, strict, id, 1, 'Manager', cid()))).rejects.toMatchObject({ status: 403, code: 'role_exceeds_publisher', message: expect.stringContaining('payments::Payment.amount') });
  });

  it('hub_send needs platform:hub.send, is audited, and keeps the run hop and chain', async () => {
    const ep = await inTenant((tx) => saveEndpoint(p, tx, t.tenantId, t.owner, EndpointInput.parse({ kind: 'webhook', name: 'erp', event_types: ['order.cancelled'], config: { url: 'http://127.0.0.1:9/hook' } }), cid()));
    const g: WorkflowGraph = {
      nodes: [node('trigger', 'trigger', { event: 'store.created' }), node('send', 'hub_send', { endpoint_id: ep.id, body: { store: '{{ trigger.data.name }}' } })],
      edges: [edge('trigger', 'out', 'send')],
    };
    const { id } = await inTenant((tx) => createWorkflow(p, tx, t.tenantId, t.owner, { name: 'Send shifts', graph: g }, cid()));
    await expect(inTenant((tx) => publishWorkflow(p, tx, t.tenantId, t.owner, id, 1, 'Manager', cid()))).rejects.toMatchObject({ code: 'role_too_narrow', message: expect.stringContaining('platform:hub.send') });
    await inTenant((tx) => publishWorkflow(p, tx, t.tenantId, t.owner, id, 1, 'Admin', cid()));
    await cmd(p, t, 'pos', 'store.create', { name: 'Hub test store' });
    await settle();
    const [run] = await runsOf(id);
    expect(run?.status).toBe('succeeded');
    const msg = await inTenant((tx) => tx.selectFrom('event_log').select('payload').where('type', '=', 'workflow.message').where(sql<string>`payload ->> 'correlation_id'`, '=', run!.correlation_id).executeTakeFirstOrThrow());
    expect(msg.payload).toMatchObject({ origin: 'workflow', workflow_hop: 1, workflow_chain: [id], data: { endpoint_id: ep.id } });
    const audit = await inTenant((tx) => tx.selectFrom('audit_log').select(['action', 'actor_type']).where('correlation_id', '=', run!.correlation_id).where('action', '=', 'platform:workflow.hub_sent').execute());
    expect(audit).toEqual([{ action: 'platform:workflow.hub_sent', actor_type: 'Workflow' }]);
    expect((await inTenant((tx) => tx.selectFrom('hub_delivery').select('endpoint_id').where('event_type', '=', 'workflow.message').execute())).map((d) => d.endpoint_id)).toEqual([ep.id]);
    await inTenant((tx) => tx.updateTable('workflow').set({ status: 'disabled' }).where('id', '=', id).execute());
    await inTenant((tx) => tx.updateTable('hub_endpoint').set({ status: 'paused' }).where('id', '=', ep.id).execute());
  });

  it('enabling or retrying needs everything the workflow may do; cancelling a run cancels its approvals, audited', async () => {
    const { id } = await inTenant((tx) => createWorkflow(p, tx, t.tenantId, t.owner, { name: 'Owner powered', graph: noop('shift.closed') }, cid()));
    await inTenant((tx) => publishWorkflow(p, tx, t.tenantId, t.owner, id, 1, 'Owner', cid()));
    await inTenant((tx) => setWorkflowStatus(p, tx, t.tenantId, t.owner, id, 'disabled', cid()));
    await expect(inTenant((tx) => setWorkflowStatus(p, tx, t.tenantId, managerA.principal, id, 'active', cid()))).rejects.toMatchObject({ status: 403, code: 'role_exceeds_actor' });

    // A failed Owner-role run cannot be retried by a Manager.
    const runId = newId();
    await inTenant((tx) => tx.insertInto('workflow_run').values({ id: runId, tenant_id: t.tenantId, workflow_id: id, version_number: 1, status: 'failed', trigger_event_id: newId(), trigger: '{}', correlation_id: 'retry-guard', hop: 1, chain: [id] }).execute());
    await expect(inTenant((tx) => retryRun(p, tx, t.tenantId, managerA.principal, runId, cid()))).rejects.toMatchObject({ code: 'role_exceeds_actor' });

    // Cancel a run waiting at Approvals.
    const s = await sale(1_300_000);
    const correlationId = await voidSale(s);
    const run = (await inTenant((tx) => tx.selectFrom('workflow_run').selectAll().where('correlation_id', '=', correlationId).executeTakeFirstOrThrow()));
    await inTenant((tx) => cancelRun(p, tx, t.tenantId, t.owner, run.id, cid()));
    const req = await inTenant((tx) => tx.selectFrom('approval_request').select(['id', 'status']).where('correlation_id', '=', correlationId).executeTakeFirstOrThrow());
    expect(req.status).toBe('cancelled');
    const audit = await inTenant((tx) => tx.selectFrom('audit_log').select('action').where('resource_id', '=', req.id).execute());
    expect(audit.map((a) => a.action)).toContain('platform:approval.cancelled');
  });
});
