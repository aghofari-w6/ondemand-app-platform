import { describe, expect, it } from 'vitest';
import { BotGraph, botOutputPorts, orderStatusFlow, validateBotGraph } from './bot.ts';
import { evaluate, parse } from './expr/index.ts';

const ctx = { tools: new Set(['ordering__find_order']), limits: { nodes: 60 } };

describe('bot flows', () => {
  it('the starter flow is valid and uses only declared outputs', () => {
    const g = BotGraph.parse(orderStatusFlow(['widget', 'telegram']));
    expect(validateBotGraph(g, ctx)).toEqual([]);
    for (const e of g.edges) expect(botOutputPorts(g.nodes.find((n) => n.id === e.from)!)).toContain(e.port);
    expect(botOutputPorts({ type: 'handoff', config: {} })).toEqual([]);
    expect(botOutputPorts({ type: 'switch', config: { cases: [{ port: 'a' }] } })).toEqual(['a', 'default']);
  });

  it('rejects loops, unreachable nodes, unknown lookups, bad expressions and a missing start', () => {
    const base = () => BotGraph.parse(orderStatusFlow());
    const loop = base();
    loop.edges.push({ id: 'x', from: 'status', port: 'out', to: 'intent' });
    expect(validateBotGraph(loop, ctx)[0]).toMatch(/contains a loop/);

    const g = base();
    g.nodes.push({ id: 'orphan', type: 'message', name: 'Orphan', position: { x: 0, y: 0 }, config: { text: 'hi {{ nope.x }}' } });
    g.nodes.find((n) => n.id === 'find')!.config.tool = 'payments__find_payment';
    g.nodes.find((n) => n.id === 'intent')!.config.cases = [{ port: 'cancel', expr: 'contains(lower(message.text),' }];
    g.edges.push({ id: 'y', from: 'to_person', port: 'out', to: 'status' });
    const problems = validateBotGraph(g, ctx);
    expect(problems).toEqual(expect.arrayContaining(['orphan: not reachable from the start', 'find: unknown lookup payments__find_payment (or its app is not active)', 'to_person: has no output "out"', 'intent: has no output "order"']));
    expect(problems.some((x) => x.startsWith('orphan: unknown name(s) nope'))).toBe(true);
    expect(problems.some((x) => x.startsWith('intent case cancel:'))).toBe(true);

    const noStart = base();
    noStart.nodes = noStart.nodes.filter((n) => n.type !== 'start');
    expect(validateBotGraph(noStart, ctx)).toEqual(['a flow needs exactly one start (has 0)']);
    const twoVars = BotGraph.parse({ nodes: [{ id: 'start', type: 'start', name: 's', config: { channels: ['widget'] } }, { id: 'a', type: 'ask', name: 'a', config: { question: 'q', variable: 'v' } }, { id: 'b', type: 'ask', name: 'b', config: { question: 'q', variable: 'v' } }], edges: [{ id: 'e1', from: 'start', port: 'out', to: 'a' }, { id: 'e2', from: 'a', port: 'answered', to: 'b' }] });
    expect(validateBotGraph(twoVars, ctx)).toEqual(['b: the variable v is already collected by another question']);
    expect(validateBotGraph(base(), { tools: ctx.tools, limits: { nodes: 3 } })).toEqual(['at most 3 nodes per flow']);
  });

  it('digits() finds an order number in a sentence', () => {
    const run = (text: string) => evaluate(parse('digits(message.text)'), { message: { text } });
    expect(run('where is my order 1042?')).toBe('1042');
    expect(run('hello')).toBeNull();
  });
});
