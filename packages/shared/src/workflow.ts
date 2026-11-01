import { z } from 'zod';
import { evaluate, parse as parseExpr, references, truthy, type Value } from './expr/index.ts';

/**
 * Workflow graphs. A workflow is a DAG: one trigger node, then action and control
 * nodes joined by edges; each edge leaves a node from a named output port. A node's
 * port leads to at most one edge, except a `parallel` node's `out`, which fans out to
 * every connected branch; branches join again at the `merge` node paired with it.
 *
 * Values in node configs may be templates: a string that is exactly `{{ expr }}`
 * yields the expression's value; any other string has each `{{ expr }}` interpolated.
 * Expressions use the safe expression language over `trigger`, `steps.<node>.output`
 * and `vars`.
 */

const nodeId = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'node ids are lower_snake_case');
const eventType = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const expression = z.string().min(1).max(1000);
/** JSON value whose strings may contain `{{ }}` templates */
export type Template = string | number | boolean | null | Template[] | { [k: string]: Template };
const template: z.ZodType<Template> = z.lazy(() => z.union([z.string().max(4000), z.number(), z.boolean(), z.null(), z.array(template).max(100), z.record(z.string(), template)]));

export const NODE_TYPES = ['trigger', 'condition', 'switch', 'command', 'record', 'hub_send', 'notify', 'wait', 'approval', 'set', 'code', 'parallel', 'merge'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

const configs = {
  trigger: z.object({ event: eventType, filter: expression.optional() }),
  condition: z.object({ expr: expression }),
  switch: z.object({ cases: z.array(z.object({ port: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), expr: expression })).min(1).max(20) }),
  command: z.object({ app: z.string().min(1), command: z.string().min(1), input: z.record(z.string(), template).default({}) }),
  record: z.object({ entity: z.string().min(1), op: z.enum(['create', 'update']), id: z.string().optional(), values: z.record(z.string(), template).default({}) }),
  hub_send: z.object({ endpoint_id: z.uuid(), body: template.default({}) }),
  notify: z.object({ roles: z.array(z.string().min(1)).max(10).default([]), users: z.array(z.uuid()).max(50).default([]), subject: z.string().min(1).max(200), message: z.string().min(1).max(4000) }),
  wait: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('duration'), seconds: z.int().min(1).max(30 * 86_400) }),
    z.object({ mode: z.literal('event'), event: eventType, filter: expression.optional(), timeout_seconds: z.int().min(1).max(30 * 86_400) }),
  ]),
  approval: z.object({
    title: z.string().min(1).max(200),
    details: z.string().max(4000).default(''),
    approver_roles: z.array(z.string().min(1)).min(1).max(10),
    quorum: z.int().min(1).max(10).default(1),
    expires_in_hours: z.int().min(1).max(24 * 30).default(72),
  }),
  set: z.object({ vars: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), template).refine((v) => Object.keys(v).length > 0, 'set at least one variable') }),
  code: z.object({ source: z.string().min(1).max(20_000), timeout_ms: z.int().min(10).max(2000).default(250), memory_mb: z.int().min(8).max(64).default(16) }),
  parallel: z.object({}).default({}),
  merge: z.object({ parallel: nodeId }),
} satisfies Record<NodeType, z.ZodType>;

export const WorkflowNode = z.object({
  id: nodeId,
  type: z.enum(NODE_TYPES),
  name: z.string().trim().min(1).max(80),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export const WorkflowEdge = z.object({ id: z.string().min(1).max(100), from: nodeId, port: z.string().min(1).max(40), to: nodeId });
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

export const WorkflowGraph = z.object({ nodes: z.array(WorkflowNode).min(1).max(200), edges: z.array(WorkflowEdge).max(400) });
export type WorkflowGraph = z.infer<typeof WorkflowGraph>;

export const nodeConfigSchema = (type: NodeType) => configs[type];

/** Output ports of a node, given its config. Action nodes also have an `error` port. */
export function outputPorts(node: Pick<WorkflowNode, 'type' | 'config'>): string[] {
  switch (node.type) {
    case 'condition':
      return ['true', 'false'];
    case 'switch':
      return [...((node.config.cases as { port: string }[] | undefined) ?? []).map((c) => c.port), 'default'];
    case 'wait':
      return node.config.mode === 'event' ? ['event', 'timeout'] : ['out'];
    case 'approval':
      return ['approved', 'rejected', 'expired'];
    case 'command':
    case 'record':
    case 'hub_send':
    case 'notify':
    case 'code':
      return ['out', 'error'];
    default:
      return ['out'];
  }
}

/** Nodes whose execution changes something outside the run (skipped in a dry run). */
export const SIDE_EFFECT_NODES: NodeType[] = ['command', 'record', 'hub_send', 'notify'];

// ------------------------------------------------------------------ templates

const TEMPLATE = /\{\{([\s\S]+?)\}\}/g;

export function templateExpressions(t: Template): string[] {
  if (typeof t === 'string') return [...t.matchAll(TEMPLATE)].map((m) => m[1]!.trim());
  if (Array.isArray(t)) return t.flatMap(templateExpressions);
  if (t && typeof t === 'object') return Object.values(t).flatMap(templateExpressions);
  return [];
}

export function renderTemplate(t: Template, ctx: Record<string, unknown>): unknown {
  if (typeof t === 'string') {
    const whole = /^\{\{([\s\S]+?)\}\}$/.exec(t.trim());
    if (whole) return evaluate(parseExpr(whole[1]!.trim()), ctx, { maxSteps: 5000 });
    return t.replace(TEMPLATE, (_m, src: string) => {
      const v = evaluate(parseExpr(src.trim()), ctx, { maxSteps: 5000 });
      return v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(t)) return t.map((x) => renderTemplate(x, ctx));
  if (t && typeof t === 'object') return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, renderTemplate(v, ctx)]));
  return t;
}

export const evalCondition = (src: string, ctx: Record<string, unknown>) => truthy(evaluate(parseExpr(src), ctx, { maxSteps: 5000 }) as Value);

// ------------------------------------------------------------------ validation

export interface WorkflowContext {
  /** event types that exist (manifest publishes + platform/record events) */
  events: Set<string>;
  /** `<app>/<command>` -> events it may emit; only active apps */
  commands: Map<string, string[]>;
  /** custom entity keys in the published data model */
  entities: Set<string>;
  /** Hub endpoint ids of the tenant */
  endpoints: Set<string>;
  roles: Set<string>;
  limits?: { workflow_nodes: number };
}

/** Ancestors of every node (graph assumed to be a DAG). */
function ancestors(graph: WorkflowGraph): Map<string, Set<string>> {
  const parents = new Map<string, string[]>();
  for (const e of graph.edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return new Set();
    stack.add(id);
    const out = new Set<string>();
    for (const p of parents.get(id) ?? []) {
      out.add(p);
      for (const a of visit(p, stack)) out.add(a);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const n of graph.nodes) visit(n.id, new Set());
  return memo;
}

/** Problems with a graph (empty = publishable). Node-level problems are prefixed with the node id. */
export function validateGraph(graph: WorkflowGraph, ctx: WorkflowContext): string[] {
  const p: string[] = [];
  const byId = new Map<string, WorkflowNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) p.push(`${n.id}: duplicate node id`);
    byId.set(n.id, n);
    const parsed = configs[n.type].safeParse(n.config);
    if (!parsed.success) p.push(...parsed.error.issues.map((i) => `${n.id}: ${i.path.join('.') || 'config'} ${i.message}`));
  }
  if (ctx.limits && graph.nodes.length > ctx.limits.workflow_nodes) p.push(`plan limit: at most ${ctx.limits.workflow_nodes} nodes per workflow`);
  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) p.push(`a workflow needs exactly one trigger (has ${triggers.length})`);
  if (p.length) return [...new Set(p)];

  // Edges
  const outKey = new Map<string, number>();
  for (const e of graph.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) {
      p.push(`edge ${e.id}: unknown node`);
      continue;
    }
    if (to.type === 'trigger') p.push(`edge ${e.id}: nothing may connect into the trigger`);
    if (!outputPorts(from).includes(e.port)) p.push(`${from.id}: has no output "${e.port}"`);
    if (e.from === e.to) p.push(`${from.id}: connects to itself`);
    const k = `${e.from}:${e.port}`;
    outKey.set(k, (outKey.get(k) ?? 0) + 1);
  }
  for (const [k, n] of outKey) {
    const [id, port] = k.split(':') as [string, string];
    if (n > 1 && !(byId.get(id)?.type === 'parallel' && port === 'out')) p.push(`${id}: output "${port}" connects to ${n} nodes; use a parallel node to run branches side by side`);
  }
  for (const n of graph.nodes.filter((x) => x.type === 'parallel')) {
    if ((outKey.get(`${n.id}:out`) ?? 0) < 2) p.push(`${n.id}: a parallel node needs at least two branches`);
  }

  // Cycles (DFS)
  const children = new Map<string, string[]>();
  for (const e of graph.edges) children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  const state = new Map<string, 1 | 2>();
  const cyc = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const c of children.get(id) ?? []) if (cyc(c)) return true;
    state.set(id, 2);
    return false;
  };
  if (graph.nodes.some((n) => cyc(n.id))) {
    p.push('the workflow contains a loop; workflows must be acyclic');
    return [...new Set(p)];
  }

  // Reachability
  const trigger = triggers[0]!;
  const seen = new Set([trigger.id]);
  const queue = [trigger.id];
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      queue.push(c);
    }
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) p.push(`${n.id}: not reachable from the trigger`);

  // Merge pairing: the paired parallel node must be an ancestor of every input of the merge.
  const anc = ancestors(graph);
  for (const m of graph.nodes.filter((x) => x.type === 'merge')) {
    const par = byId.get(String(m.config.parallel));
    if (!par || par.type !== 'parallel') {
      p.push(`${m.id}: must name the parallel node it joins`);
      continue;
    }
    const inputs = graph.edges.filter((e) => e.to === m.id);
    if (inputs.length < 1) p.push(`${m.id}: has no inputs`);
    for (const e of inputs) if (e.from !== par.id && !anc.get(e.from)?.has(par.id)) p.push(`${m.id}: input from ${e.from} does not come from ${par.id}`);
    if (graph.nodes.some((x) => x.id !== m.id && x.type === 'merge' && x.config.parallel === par.id)) p.push(`${par.id}: joined by more than one merge`);
  }

  // Branches of one parallel node may only meet at its merge (a node shared by two
  // branches would run twice).
  for (const par of graph.nodes.filter((x) => x.type === 'parallel')) {
    const merge = graph.nodes.find((x) => x.type === 'merge' && x.config.parallel === par.id)?.id;
    const owner = new Map<string, string>();
    for (const b of graph.edges.filter((e) => e.from === par.id)) {
      const stack = [b.to];
      const mine = new Set<string>();
      while (stack.length) {
        const id = stack.pop()!;
        if (id === merge || mine.has(id)) continue;
        mine.add(id);
        stack.push(...(children.get(id) ?? []));
      }
      for (const id of mine) {
        if (owner.has(id) && owner.get(id) !== b.id) p.push(`${id}: reached by two branches of ${par.id}; join branches with a merge node`);
        owner.set(id, b.id);
      }
    }
  }

  // Semantics per node
  const exprOk = (where: string, src: string) => {
    try {
      const refs = references(parseExpr(src)).map((r) => r.split('.')[0]);
      const bad = refs.filter((r) => !['trigger', 'steps', 'vars', 'event', 'run'].includes(r!));
      if (bad.length) p.push(`${where}: unknown name(s) ${[...new Set(bad)].join(', ')} (use trigger, steps, vars)`);
    } catch (e) {
      p.push(`${where}: ${(e as Error).message}`);
    }
  };
  for (const n of graph.nodes) {
    const c = n.config as Record<string, any>;
    for (const src of templateExpressions(c as Template)) exprOk(`${n.id}`, src);
    switch (n.type) {
      case 'trigger':
        if (!ctx.events.has(c.event)) p.push(`${n.id}: unknown event ${c.event}`);
        if (c.filter) exprOk(`${n.id} filter`, c.filter);
        break;
      case 'condition':
        exprOk(`${n.id}`, c.expr);
        break;
      case 'switch':
        for (const k of c.cases) exprOk(`${n.id} case ${k.port}`, k.expr);
        if (new Set(c.cases.map((k: any) => k.port)).size !== c.cases.length || c.cases.some((k: any) => k.port === 'default')) p.push(`${n.id}: case names must be unique and not "default"`);
        break;
      case 'command':
        if (!ctx.commands.has(`${c.app}/${c.command}`)) p.push(`${n.id}: unknown command ${c.app}/${c.command} (or the app is not active)`);
        break;
      case 'record':
        if (!ctx.entities.has(c.entity)) p.push(`${n.id}: unknown custom entity ${c.entity}`);
        if (c.op === 'update' && !c.id) p.push(`${n.id}: an update needs the record id`);
        break;
      case 'hub_send':
        if (!ctx.endpoints.has(c.endpoint_id)) p.push(`${n.id}: unknown Hub endpoint`);
        break;
      case 'notify':
        if (!c.roles?.length && !c.users?.length) p.push(`${n.id}: choose at least one role or user to notify`);
        for (const r of c.roles ?? []) if (!ctx.roles.has(r)) p.push(`${n.id}: unknown role ${r}`);
        break;
      case 'approval':
        for (const r of c.approver_roles) if (!ctx.roles.has(r)) p.push(`${n.id}: unknown role ${r}`);
        break;
      case 'wait':
        if (c.mode === 'event') {
          if (!ctx.events.has(c.event)) p.push(`${n.id}: unknown event ${c.event}`);
          if (c.filter) exprOk(`${n.id} filter`, c.filter);
        }
        break;
    }
  }

  // Loop risk: a command that may emit the workflow's own trigger event needs a trigger filter.
  const trig = trigger.config as { event: string; filter?: string };
  for (const n of graph.nodes.filter((x) => x.type === 'command')) {
    const c = n.config as { app: string; command: string };
    if ((ctx.commands.get(`${c.app}/${c.command}`) ?? []).includes(trig.event) && !trig.filter) {
      p.push(`${n.id}: ${c.app}/${c.command} can emit ${trig.event}, which triggers this workflow again; add a trigger filter`);
    }
  }
  return [...new Set(p)];
}

/** Manifest template conditions name event data fields directly; workflows use `trigger.data.*`. */
function prefixFields(src: string): string {
  const keywords = ['and', 'or', 'not', 'in', 'true', 'false', 'null'];
  // Split out string literals so their contents are never rewritten.
  return src
    .split(/('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/)
    .map((part, i) => (i % 2 ? part : part.replace(/(?<![.\w])([a-z_][a-z0-9_]*)\b(?!\s*\()/g, (w) => (keywords.includes(w) ? w : `trigger.data.${w}`))))
    .join('');
}

/** Starter graph for a manifest workflow template. */
export function graphFromTemplate(t: { trigger: string; condition?: string | undefined; action: string; app: string; label: string }): WorkflowGraph {
  const nodes: WorkflowNode[] = [{ id: 'trigger', type: 'trigger', name: 'When', position: { x: 0, y: 0 }, config: { event: t.trigger } }];
  const edges: WorkflowEdge[] = [];
  let last = { id: 'trigger', port: 'out' };
  if (t.condition) {
    nodes.push({ id: 'check', type: 'condition', name: 'Check', position: { x: 260, y: 0 }, config: { expr: prefixFields(t.condition) } });
    edges.push({ id: 'e1', from: 'trigger', port: 'out', to: 'check' });
    last = { id: 'check', port: 'true' };
  }
  nodes.push({ id: 'action', type: 'command', name: t.label, position: { x: 520, y: 0 }, config: { app: t.app, command: t.action, input: {} } });
  edges.push({ id: 'e2', from: last.id, port: last.port, to: 'action' });
  return { nodes, edges };
}
