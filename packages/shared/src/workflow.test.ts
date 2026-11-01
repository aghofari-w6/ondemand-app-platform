import { describe, expect, it } from 'vitest';
import { graphFromTemplate, outputPorts, renderTemplate, validateGraph, type WorkflowContext, type WorkflowGraph } from './workflow.ts';

const ctx: WorkflowContext = {
  events: new Set(['sale.voided', 'order.created', 'payment.refunded']),
  commands: new Map([
    ['payments/payment.refund_by_reference', ['payment.refunded']],
    ['ordering/order.create', ['order.created']],
  ]),
  entities: new Set(['supplier']),
  endpoints: new Set(['00000000-0000-4000-8000-000000000001']),
  roles: new Set(['Owner', 'Admin', 'Manager', 'Staff', 'Viewer']),
};
const n = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, name: id, position: { x: 0, y: 0 }, config }) as WorkflowGraph['nodes'][number];
const e = (from: string, port: string, to: string) => ({ id: `${from}-${port}-${to}`, from, port, to });

const j3: WorkflowGraph = {
  nodes: [
    n('trigger', 'trigger', { event: 'sale.voided', filter: 'trigger.data.total > 1000000' }),
    n('approve', 'approval', { title: 'Refund {{ trigger.data.receipt_no }}?', approver_roles: ['Manager'] }),
    n('refund', 'command', { app: 'payments', command: 'payment.refund_by_reference', input: { reference: "{{ 'pos:sale:' + trigger.data.sale_id }}" } }),
    n('tell_store', 'notify', { roles: ['Staff'], subject: 'Refunded', message: 'Sale {{ trigger.data.receipt_no }} refunded' }),
    n('tell_cashier', 'notify', { roles: ['Staff'], subject: 'Rejected', message: 'No refund' }),
  ],
  edges: [e('trigger', 'out', 'approve'), e('approve', 'approved', 'refund'), e('refund', 'out', 'tell_store'), e('approve', 'rejected', 'tell_cashier')],
};

describe('workflow graphs', () => {
  it('accepts the J3 graph', () => {
    expect(validateGraph(j3, ctx)).toEqual([]);
  });

  it('rejects structural problems', () => {
    const cyc: WorkflowGraph = { nodes: [n('trigger', 'trigger', { event: 'order.created' }), n('a', 'set', { vars: { x: 1 } }), n('b', 'set', { vars: { y: 1 } })], edges: [e('trigger', 'out', 'a'), e('a', 'out', 'b'), e('b', 'out', 'a')] };
    expect(validateGraph(cyc, ctx).join()).toMatch(/loop/);
    const two: WorkflowGraph = { nodes: [n('trigger', 'trigger', { event: 'order.created' }), n('a', 'set', { vars: { x: 1 } }), n('b', 'set', { vars: { y: 1 } })], edges: [e('trigger', 'out', 'a'), e('trigger', 'out', 'b')] };
    expect(validateGraph(two, ctx).join()).toMatch(/use a parallel node/);
    const orphan: WorkflowGraph = { nodes: [n('trigger', 'trigger', { event: 'order.created' }), n('a', 'set', { vars: { x: 1 } })], edges: [] };
    expect(validateGraph(orphan, ctx).join()).toMatch(/a: not reachable/);
    const badPort: WorkflowGraph = { nodes: [n('trigger', 'trigger', { event: 'order.created' }), n('a', 'set', { vars: { x: 1 } })], edges: [e('trigger', 'yes', 'a')] };
    expect(validateGraph(badPort, ctx).join()).toMatch(/no output "yes"/);
    expect(validateGraph({ nodes: [n('a', 'set', { vars: { x: 1 } })], edges: [] }, ctx).join()).toMatch(/exactly one trigger/);
  });

  it('pairs merges with their parallel node', () => {
    const g: WorkflowGraph = {
      nodes: [n('trigger', 'trigger', { event: 'order.created' }), n('fan', 'parallel'), n('a', 'set', { vars: { a: 1 } }), n('b', 'set', { vars: { b: 2 } }), n('join', 'merge', { parallel: 'fan' })],
      edges: [e('trigger', 'out', 'fan'), e('fan', 'out', 'a'), e('fan', 'out', 'b'), e('a', 'out', 'join'), e('b', 'out', 'join')],
    };
    expect(validateGraph(g, ctx)).toEqual([]);
    const bad = { ...g, nodes: g.nodes.map((x) => (x.id === 'join' ? { ...x, config: { parallel: 'a' } } : x)) };
    expect(validateGraph(bad, ctx).join()).toMatch(/must name the parallel node/);
  });

  it('rejects branches of one parallel node meeting anywhere but its merge', () => {
    const g: WorkflowGraph = {
      nodes: [n('trigger', 'trigger', { event: 'order.created' }), n('fan', 'parallel'), n('a', 'set', { vars: { a: 1 } }), n('b', 'set', { vars: { b: 2 } }), n('shared', 'set', { vars: { c: 3 } })],
      edges: [e('trigger', 'out', 'fan'), e('fan', 'out', 'a'), e('fan', 'out', 'b'), e('a', 'out', 'shared'), e('b', 'out', 'shared')],
    };
    expect(validateGraph(g, ctx).join()).toMatch(/shared: reached by two branches of fan/);
    // Converging after a condition (one path at a time) is fine.
    const ok: WorkflowGraph = {
      nodes: [n('trigger', 'trigger', { event: 'order.created' }), n('c', 'condition', { expr: 'trigger.data.total > 1' }), n('shared', 'set', { vars: { c: 3 } })],
      edges: [e('trigger', 'out', 'c'), e('c', 'true', 'shared'), e('c', 'false', 'shared')],
    };
    expect(validateGraph(ok, ctx)).toEqual([]);
  });

  it('checks semantics: events, commands, roles, expressions, loop risk', () => {
    const g = JSON.parse(JSON.stringify(j3)) as WorkflowGraph;
    g.nodes[0]!.config = { event: 'order.created' };
    g.nodes[2]!.config = { app: 'ordering', command: 'order.create', input: { channel: '{{ secret.x }}' } };
    g.nodes[1]!.config = { title: 't', approver_roles: ['Wizard'] };
    const problems = validateGraph(g, ctx).join('\n');
    expect(problems).toMatch(/can emit order.created, which triggers this workflow again/);
    expect(problems).toMatch(/unknown role Wizard/);
    expect(problems).toMatch(/unknown name\(s\) secret/);
  });

  it('renders templates with typed whole-expression values', () => {
    const c = { trigger: { data: { total: 1200000, receipt_no: 'R-1' } }, vars: { n: 2 } };
    expect(renderTemplate('{{ trigger.data.total }}', c)).toBe(1200000);
    expect(renderTemplate('Receipt {{ trigger.data.receipt_no }} x{{ vars.n }}', c)).toBe('Receipt R-1 x2');
    expect(renderTemplate({ a: ['{{ vars.n * 2 }}'] }, c)).toEqual({ a: [4] });
  });

  it('lists output ports per node type', () => {
    expect(outputPorts({ type: 'approval', config: {} })).toEqual(['approved', 'rejected', 'expired']);
    expect(outputPorts({ type: 'switch', config: { cases: [{ port: 'big', expr: 'true' }] } })).toEqual(['big', 'default']);
    expect(outputPorts({ type: 'wait', config: { mode: 'event' } })).toEqual(['event', 'timeout']);
    expect(outputPorts({ type: 'command', config: {} })).toEqual(['out', 'error']);
  });

  it('builds starter graphs from manifest templates', () => {
    const g = graphFromTemplate({ trigger: 'order.created', condition: "channel == 'web' && total < 100000", action: 'order.create', app: 'ordering', label: 'Do it' });
    expect(g.nodes.find((x) => x.id === 'check')!.config.expr).toBe("trigger.data.channel == 'web' && trigger.data.total < 100000");
  });
});
