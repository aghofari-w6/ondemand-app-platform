import { z } from 'zod';
import { parse as parseExpr, references } from './expr/index.ts';
import { templateExpressions, WorkflowEdge, type Template } from './workflow.ts';

/**
 * Bot flows (Bot Studio). A flow is a graph on the workflow canvas with conversational
 * node types: it starts when a customer message arrives on one of its channels, and
 * runs until it asks a question (and waits for the answer), hands the conversation to
 * the Inbox, or ends. Like workflows it is acyclic; an `ask` node retries by itself.
 *
 * Expressions and `{{ }}` templates see `message` (text, channel), `contact`
 * (name, verified), `vars`, `steps.<node>.output` and, in an `ask` validation, `answer`.
 */

const nodeId = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'node ids are lower_snake_case');
const expression = z.string().min(1).max(1000);
const text = z.string().min(1).max(4000);
const template: z.ZodType<Template> = z.lazy(() => z.union([z.string().max(4000), z.number(), z.boolean(), z.null(), z.array(template).max(50), z.record(z.string(), template)]));

export const BOT_CHANNELS = ['telegram', 'gmail', 'widget'] as const;
export type BotChannel = (typeof BOT_CHANNELS)[number];

export const BOT_NODE_TYPES = ['start', 'message', 'ask', 'lookup', 'ask_assistant', 'handoff', 'condition', 'switch'] as const;
export type BotNodeType = (typeof BOT_NODE_TYPES)[number];

const configs = {
  start: z.object({ channels: z.array(z.enum(BOT_CHANNELS)).min(1), filter: expression.optional() }),
  message: z.object({ text }),
  ask: z.object({
    question: text,
    variable: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
    /** expression over `answer`; empty = any answer */
    validate: expression.optional(),
    retry_message: z.string().max(1000).optional(),
    max_attempts: z.int().min(1).max(5).default(2),
  }),
  /** a read tool of an active app, e.g. `ordering__find_order` */
  lookup: z.object({ tool: z.string().min(1).max(120), input: z.record(z.string(), template).default({}) }),
  ask_assistant: z.object({ question: text.default('{{ message.text }}') }),
  handoff: z.object({ message: z.string().max(1000).optional() }),
  condition: z.object({ expr: expression }),
  switch: z.object({ cases: z.array(z.object({ port: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), expr: expression })).min(1).max(20) }),
} satisfies Record<BotNodeType, z.ZodType>;

export const BotNode = z.object({
  id: nodeId,
  type: z.enum(BOT_NODE_TYPES),
  name: z.string().trim().min(1).max(80),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type BotNode = z.infer<typeof BotNode>;

export const BotGraph = z.object({ nodes: z.array(BotNode).min(1).max(100), edges: z.array(WorkflowEdge).max(300) });
export type BotGraph = z.infer<typeof BotGraph>;

export const botNodeConfigSchema = (type: BotNodeType) => configs[type];

export function botOutputPorts(node: { type: string; config: Record<string, unknown> }): string[] {
  switch (node.type) {
    case 'condition':
      return ['true', 'false'];
    case 'switch':
      return [...((node.config.cases as { port: string }[] | undefined) ?? []).map((c) => c.port), 'default'];
    case 'ask':
      return ['answered', 'invalid'];
    case 'lookup':
      return ['found', 'not_found', 'error'];
    case 'ask_assistant':
      return ['answered', 'unsure'];
    case 'handoff':
      return [];
    default:
      return ['out'];
  }
}

export interface BotContext {
  /** read tools the flow may look things up with (active apps) */
  tools: Set<string>;
  limits?: { nodes: number };
}

const SCOPE = ['message', 'contact', 'vars', 'steps', 'answer'];

/** Problems with a flow (empty = publishable). Node-level problems are prefixed with the node id. */
export function validateBotGraph(graph: BotGraph, ctx: BotContext): string[] {
  const p: string[] = [];
  const byId = new Map<string, BotNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) p.push(`${n.id}: duplicate node id`);
    byId.set(n.id, n);
    const parsed = configs[n.type].safeParse(n.config);
    if (!parsed.success) p.push(...parsed.error.issues.map((i) => `${n.id}: ${i.path.join('.') || 'config'} ${i.message}`));
  }
  if (ctx.limits && graph.nodes.length > ctx.limits.nodes) p.push(`at most ${ctx.limits.nodes} nodes per flow`);
  const starts = graph.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) p.push(`a flow needs exactly one start (has ${starts.length})`);
  if (p.length) return [...new Set(p)];

  const used = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const e of graph.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) {
      p.push(`edge ${e.id}: unknown node`);
      continue;
    }
    if (to.type === 'start') p.push(`edge ${e.id}: nothing may connect into the start`);
    if (!botOutputPorts(from).includes(e.port)) p.push(`${from.id}: has no output "${e.port}"`);
    if (e.from === e.to) p.push(`${from.id}: connects to itself`);
    used.set(`${e.from}:${e.port}`, (used.get(`${e.from}:${e.port}`) ?? 0) + 1);
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  }
  for (const [k, n] of used) if (n > 1) p.push(`${k.split(':')[0]}: output "${k.split(':')[1]}" connects to ${n} nodes`);

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
    p.push('the flow contains a loop; an "ask" node already repeats its question when the answer is not valid');
    return [...new Set(p)];
  }

  const start = starts[0]!;
  const seen = new Set([start.id]);
  const queue = [start.id];
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      queue.push(c);
    }
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) p.push(`${n.id}: not reachable from the start`);
  if (!graph.edges.some((e) => e.from === start.id)) p.push(`${start.id}: connect the start to a first step`);

  const exprOk = (where: string, src: string) => {
    try {
      const bad = references(parseExpr(src)).map((r) => r.split('.')[0]!).filter((r) => !SCOPE.includes(r));
      if (bad.length) p.push(`${where}: unknown name(s) ${[...new Set(bad)].join(', ')} (use message, contact, vars, steps)`);
    } catch (e) {
      p.push(`${where}: ${(e as Error).message}`);
    }
  };
  const vars = new Set<string>();
  for (const n of graph.nodes) {
    const c = n.config as Record<string, any>;
    for (const src of templateExpressions(c as Template)) exprOk(n.id, src);
    switch (n.type) {
      case 'start':
        if (c.filter) exprOk(`${n.id} filter`, c.filter);
        break;
      case 'condition':
        exprOk(n.id, c.expr);
        break;
      case 'switch':
        for (const k of c.cases) exprOk(`${n.id} case ${k.port}`, k.expr);
        if (new Set(c.cases.map((k: any) => k.port)).size !== c.cases.length || c.cases.some((k: any) => k.port === 'default')) p.push(`${n.id}: case names must be unique and not "default"`);
        break;
      case 'ask':
        if (c.validate) exprOk(`${n.id} validation`, c.validate);
        if (vars.has(c.variable)) p.push(`${n.id}: the variable ${c.variable} is already collected by another question`);
        vars.add(c.variable);
        break;
      case 'lookup':
        if (!ctx.tools.has(c.tool)) p.push(`${n.id}: unknown lookup ${c.tool} (or its app is not active)`);
        break;
    }
  }
  return [...new Set(p)];
}

/** The starter flow: answer "where is my order?", hand cancellations to a person, and let the assistant answer the rest. */
export function orderStatusFlow(channels: BotChannel[] = ['widget']): BotGraph {
  const at = (x: number, y: number) => ({ x, y });
  return {
    nodes: [
      { id: 'start', type: 'start', name: 'Customer writes', position: at(0, 120), config: { channels } },
      { id: 'intent', type: 'switch', name: 'What do they want?', position: at(260, 120), config: { cases: [{ port: 'cancel', expr: "contains(lower(message.text), 'cancel')" }, { port: 'order', expr: 'digits(message.text) != null' }] } },
      { id: 'to_person', type: 'handoff', name: 'Hand to a person', position: at(540, 0), config: { message: 'I am handing you to a colleague who can help with that.' } },
      { id: 'find', type: 'lookup', name: 'Find the order', position: at(540, 160), config: { tool: 'ordering__find_order', input: { q: '{{ digits(message.text) }}' } } },
      { id: 'status', type: 'message', name: 'Tell the status', position: at(820, 100), config: { text: 'Order {{ steps.find.output.first.number }} is {{ steps.find.output.first.status }}.' } },
      { id: 'unknown', type: 'message', name: 'Not found', position: at(820, 260), config: { text: 'I could not find order {{ digits(message.text) }}. Please check the number.' } },
      { id: 'answer', type: 'ask_assistant', name: 'Answer from help articles', position: at(540, 380), config: { question: '{{ message.text }}' } },
      { id: 'unsure', type: 'handoff', name: 'Not sure: hand over', position: at(820, 440), config: { message: 'Let me get a colleague to help you with that.' } },
    ],
    edges: [
      { id: 'e1', from: 'start', port: 'out', to: 'intent' },
      { id: 'e2', from: 'intent', port: 'cancel', to: 'to_person' },
      { id: 'e3', from: 'intent', port: 'order', to: 'find' },
      { id: 'e4', from: 'find', port: 'found', to: 'status' },
      { id: 'e5', from: 'find', port: 'not_found', to: 'unknown' },
      { id: 'e6', from: 'intent', port: 'default', to: 'answer' },
      { id: 'e7', from: 'answer', port: 'unsure', to: 'unsure' },
      { id: 'e8', from: 'find', port: 'error', to: 'unsure' },
    ],
  };
}
