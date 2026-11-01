import { describe, expect, it } from 'vitest';
import { compile, evaluate, ExprError, parse, references } from './index.ts';

const order = {
  order: { total: 125000, status: 'new', channel: 'pos', tags: ['vip', 'pickup'], customer: { name: 'Rina' } },
  lines: [{ qty: 2 }, { qty: 3 }],
};

const run = (src: string, data: Record<string, unknown> = order) => evaluate(parse(src), data);

describe('expression language', () => {
  it('evaluates literals and arithmetic with precedence', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('-2 * -3')).toBe(6);
    expect(run('10 % 4')).toBe(2);
    expect(run("'a' + 1")).toBe('a1');
    expect(run('null')).toBe(null);
  });

  it('resolves field references, nested paths and indexes', () => {
    expect(run('order.total')).toBe(125000);
    expect(run('order.customer.name')).toBe('Rina');
    expect(run('lines[1].qty')).toBe(3);
    expect(run('order.missing.deeper')).toBe(null);
  });

  it('does not walk the prototype chain', () => {
    expect(run('order.constructor')).toBe(null);
    expect(run('order.__proto__')).toBe(null);
    expect(run('order.toString')).toBe(null);
  });

  it('supports comparison, boolean and membership operators', () => {
    expect(run("order.total > 100000 && order.status == 'new'")).toBe(true);
    expect(run("order.channel != 'pos' or order.total >= 125000")).toBe(true);
    expect(run("not (order.status in ['done', 'cancelled'])")).toBe(true);
    expect(run("'vip' in order.tags")).toBe(true);
    expect(run('!true')).toBe(false);
    expect(run('null < 3')).toBe(false);
  });

  it('short-circuits boolean operators', () => {
    expect(run('false && 1 / 0')).toBe(false);
    expect(run('true || 1 / 0')).toBe(true);
    expect(run('if(true, 1, 1 / 0)')).toBe(1);
  });

  it('calls only allowlisted functions', () => {
    expect(run("upper(order.customer.name)")).toBe('RINA');
    expect(run('len(order.tags)')).toBe(2);
    expect(run('round(10 / 3, 2)')).toBe(3.33);
    expect(run('max(1, 5, 3)')).toBe(5);
    expect(run("coalesce(order.nope, 'fallback')")).toBe('fallback');
    expect(run("contains(order.tags, 'pickup')")).toBe(true);
    expect(run("daysBetween('2026-01-01', '2026-01-31')")).toBe(30);
    expect(() => parse('eval("1")')).toThrow(ExprError);
    expect(() => parse('process(1)')).toThrow(/unknown function/);
    expect(() => run('round()')).toThrow(/wrong number of arguments/);
  });

  it('reports type and syntax errors', () => {
    expect(() => parse('1 +')).toThrow(ExprError);
    expect(() => parse('(1')).toThrow(/expected '\)'/);
    expect(() => parse("'abc")).toThrow(/unterminated/);
    expect(() => parse('1 2')).toThrow(/trailing/);
    expect(() => parse('a ; b')).toThrow(/unexpected character/);
    expect(() => run("order.total < 'x'")).toThrow(/cannot compare/);
    expect(() => run('1 / 0')).toThrow(/division by zero/);
  });

  it('enforces a step limit', () => {
    const big = Array.from({ length: 200 }, () => '1').join(' + ');
    expect(() => evaluate(parse(big), {}, { maxSteps: 100 })).toThrow(/step limit/);
    expect(evaluate(parse(big), {}, { maxSteps: 1000 })).toBe(200);
  });

  it('limits nesting depth and source length', () => {
    expect(() => parse('('.repeat(100) + '1' + ')'.repeat(100))).toThrow(/nested too deeply/);
    expect(() => parse('1+'.repeat(3000) + '1')).toThrow(/longer than/);
  });

  it('lists references and compiles once', () => {
    expect(references(parse("order.total > 5 && lower(order.status) == 'x'")).sort()).toEqual(['order.status', 'order.total']);
    const c = compile('order.total * 2');
    expect(c.eval(order)).toBe(250000);
    expect(c.test({ order: { total: 0 } })).toBe(false);
  });

  it('uses an injectable clock', () => {
    expect(run('1') && evaluate(parse('now()'), {}, { now: () => Date.UTC(2026, 0, 2) })).toBe('2026-01-02T00:00:00.000Z');
  });
});
