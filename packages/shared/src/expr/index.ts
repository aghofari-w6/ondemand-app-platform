/**
 * Safe expression language.
 *
 * A small, side-effect-free language used by Hub filters, workflow conditions and
 * formulas. It is parsed by our own recursive-descent parser (no eval, no Function),
 * evaluated against a plain data object, and bounded by a step limit.
 *
 * Grammar (lowest to highest precedence):
 *   expr     := or
 *   or       := and (("||" | "or") and)*
 *   and      := not (("&&" | "and") not)*
 *   not      := ("!" | "not") not | cmp
 *   cmp      := add (("==" | "!=" | "<" | "<=" | ">" | ">=" | "in") add)?
 *   add      := mul (("+" | "-") mul)*
 *   mul      := unary (("*" | "/" | "%") unary)*
 *   unary    := "-" unary | primary
 *   primary  := number | string | true | false | null | list | call | ref | "(" expr ")"
 *   list     := "[" (expr ("," expr)*)? "]"
 *   call     := ident "(" (expr ("," expr)*)? ")"
 *   ref      := ident ("." ident | "[" number "]")*
 */

export type Value = null | boolean | number | string | Value[] | { [k: string]: Value };

export type Node =
  | { kind: 'lit'; value: Value }
  | { kind: 'ref'; path: (string | number)[] }
  | { kind: 'list'; items: Node[] }
  | { kind: 'call'; fn: string; args: Node[] }
  | { kind: 'unary'; op: '-' | '!'; arg: Node }
  | { kind: 'binary'; op: BinaryOp; left: Node; right: Node };

type BinaryOp = '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | '+' | '-' | '*' | '/' | '%';

export class ExprError extends Error {
  readonly pos: number | undefined;
  constructor(message: string, pos?: number) {
    super(pos === undefined ? message : `${message} (at ${pos})`);
    this.name = 'ExprError';
    this.pos = pos;
  }
}

// ---------------------------------------------------------------- lexer

type Tok =
  | { t: 'num'; v: number; p: number }
  | { t: 'str'; v: string; p: number }
  | { t: 'id'; v: string; p: number }
  | { t: 'op'; v: string; p: number }
  | { t: 'eof'; p: number };

const MAX_SOURCE = 4000;
const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', '[', ']', ',', '.'];

function lex(src: string): Tok[] {
  if (src.length > MAX_SOURCE) throw new ExprError(`expression longer than ${MAX_SOURCE} characters`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]), p: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1]!;
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new ExprError('unterminated string', i);
      out.push({ t: 'str', v: s, p: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], p: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected character '${c}'`, i);
    out.push({ t: 'op', v: op, p: i });
    i += op.length;
  }
  out.push({ t: 'eof', p: src.length });
  return out;
}

// ---------------------------------------------------------------- parser

const MAX_DEPTH = 64;

export function parse(src: string): Node {
  const toks = lex(src);
  let k = 0;
  let depth = 0;
  const peek = () => toks[k]!;
  const isOp = (v: string) => peek().t === 'op' && (peek() as { v: string }).v === v;
  const isWord = (v: string) => peek().t === 'id' && (peek() as { v: string }).v === v;
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected '${v}'`, peek().p);
    k++;
  };
  const enter = () => {
    if (++depth > MAX_DEPTH) throw new ExprError('expression nested too deeply', peek().p);
  };

  function expr(): Node {
    enter();
    const n = or();
    depth--;
    return n;
  }
  function or(): Node {
    let left = and();
    while (isOp('||') || isWord('or')) {
      k++;
      left = { kind: 'binary', op: '||', left, right: and() };
    }
    return left;
  }
  function and(): Node {
    let left = not();
    while (isOp('&&') || isWord('and')) {
      k++;
      left = { kind: 'binary', op: '&&', left, right: not() };
    }
    return left;
  }
  function not(): Node {
    if (isOp('!') || isWord('not')) {
      k++;
      enter();
      const arg = not();
      depth--;
      return { kind: 'unary', op: '!', arg };
    }
    return cmp();
  }
  function cmp(): Node {
    const left = add();
    for (const op of ['==', '!=', '<=', '>=', '<', '>'] as const) {
      if (isOp(op)) {
        k++;
        return { kind: 'binary', op, left, right: add() };
      }
    }
    if (isWord('in')) {
      k++;
      return { kind: 'binary', op: 'in', left, right: add() };
    }
    return left;
  }
  function add(): Node {
    let left = mul();
    while (isOp('+') || isOp('-')) {
      const op = (toks[k++] as { v: '+' | '-' }).v;
      left = { kind: 'binary', op, left, right: mul() };
    }
    return left;
  }
  function mul(): Node {
    let left = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (toks[k++] as { v: '*' | '/' | '%' }).v;
      left = { kind: 'binary', op, left, right: unary() };
    }
    return left;
  }
  function unary(): Node {
    if (isOp('-')) {
      k++;
      enter();
      const arg = unary();
      depth--;
      return { kind: 'unary', op: '-', arg };
    }
    return primary();
  }
  function args(close: string): Node[] {
    const items: Node[] = [];
    if (isOp(close)) {
      k++;
      return items;
    }
    for (;;) {
      items.push(expr());
      if (isOp(',')) {
        k++;
        continue;
      }
      expectOp(close);
      return items;
    }
  }
  function primary(): Node {
    const tok = peek();
    if (tok.t === 'num' || tok.t === 'str') {
      k++;
      return { kind: 'lit', value: tok.v };
    }
    if (tok.t === 'op' && tok.v === '(') {
      k++;
      const n = expr();
      expectOp(')');
      return n;
    }
    if (tok.t === 'op' && tok.v === '[') {
      k++;
      return { kind: 'list', items: args(']') };
    }
    if (tok.t === 'id') {
      k++;
      if (tok.v === 'true') return { kind: 'lit', value: true };
      if (tok.v === 'false') return { kind: 'lit', value: false };
      if (tok.v === 'null') return { kind: 'lit', value: null };
      if (isOp('(')) {
        k++;
        if (!Object.hasOwn(FUNCTIONS, tok.v)) throw new ExprError(`unknown function '${tok.v}'`, tok.p);
        return { kind: 'call', fn: tok.v, args: args(')') };
      }
      const path: (string | number)[] = [tok.v];
      for (;;) {
        if (isOp('.')) {
          k++;
          const nxt = peek();
          if (nxt.t !== 'id') throw new ExprError('expected field name after "."', nxt.p);
          k++;
          path.push(nxt.v);
        } else if (isOp('[')) {
          k++;
          const nxt = peek();
          if (nxt.t !== 'num' && nxt.t !== 'str') throw new ExprError('expected index', nxt.p);
          k++;
          path.push(nxt.v);
          expectOp(']');
        } else break;
      }
      return { kind: 'ref', path };
    }
    throw new ExprError(tok.t === 'eof' ? 'unexpected end of expression' : `unexpected token`, tok.p);
  }

  const root = expr();
  if (peek().t !== 'eof') throw new ExprError('unexpected trailing input', peek().p);
  return root;
}

// ---------------------------------------------------------------- functions

type Fn = { arity: [number, number]; impl: (args: Value[], ctx: EvalContext) => Value };

const num = (v: Value, name: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ExprError(`${name}: expected a number`);
  return v;
};
const str = (v: Value): string => (v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const toTime = (v: Value, name: string): number => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw new ExprError(`${name}: expected a date`);
  return t;
};

/** The allowlisted function set. Nothing else is callable. */
export const FUNCTIONS: Record<string, Fn> = {
  lower: { arity: [1, 1], impl: ([a]) => str(a!).toLowerCase() },
  upper: { arity: [1, 1], impl: ([a]) => str(a!).toUpperCase() },
  trim: { arity: [1, 1], impl: ([a]) => str(a!).trim() },
  len: { arity: [1, 1], impl: ([a]) => (Array.isArray(a) ? a.length : str(a!).length) },
  concat: { arity: [0, 20], impl: (a) => a.map(str).join('') },
  contains: {
    arity: [2, 2],
    impl: ([h, n]) => (Array.isArray(h) ? h.some((x) => equals(x, n!)) : str(h!).includes(str(n!))),
  },
  startsWith: { arity: [2, 2], impl: ([h, n]) => str(h!).startsWith(str(n!)) },
  endsWith: { arity: [2, 2], impl: ([h, n]) => str(h!).endsWith(str(n!)) },
  abs: { arity: [1, 1], impl: ([a]) => Math.abs(num(a!, 'abs')) },
  round: {
    arity: [1, 2],
    impl: ([a, d]) => {
      const f = 10 ** (d === undefined ? 0 : num(d, 'round'));
      return Math.round(num(a!, 'round') * f) / f;
    },
  },
  floor: { arity: [1, 1], impl: ([a]) => Math.floor(num(a!, 'floor')) },
  ceil: { arity: [1, 1], impl: ([a]) => Math.ceil(num(a!, 'ceil')) },
  min: { arity: [1, 20], impl: (a) => Math.min(...a.map((x) => num(x, 'min'))) },
  max: { arity: [1, 20], impl: (a) => Math.max(...a.map((x) => num(x, 'max'))) },
  sum: {
    arity: [1, 1],
    impl: ([a]) => {
      if (!Array.isArray(a)) throw new ExprError('sum: expected a list');
      return a.reduce<number>((s, x) => s + num(x, 'sum'), 0);
    },
  },
  coalesce: { arity: [1, 20], impl: (a) => a.find((x) => x !== null) ?? null },
  if: { arity: [3, 3], impl: ([c, t, f]) => (truthy(c!) ? t! : f!) },
  isNull: { arity: [1, 1], impl: ([a]) => a === null },
  number: {
    arity: [1, 1],
    impl: ([a]) => {
      const n = Number(a);
      if (!Number.isFinite(n)) throw new ExprError('number: not numeric');
      return n;
    },
  },
  string: { arity: [1, 1], impl: ([a]) => str(a!) },
  now: { arity: [0, 0], impl: (_a, ctx) => new Date(ctx.now()).toISOString() },
  daysBetween: {
    arity: [2, 2],
    impl: ([a, b]) => Math.floor((toTime(b!, 'daysBetween') - toTime(a!, 'daysBetween')) / 86_400_000),
  },
};

// ---------------------------------------------------------------- evaluator

export interface EvalContext {
  now: () => number;
}

export interface EvalOptions {
  /** Maximum evaluation steps (node visits). Defaults to 10 000. */
  maxSteps?: number;
  now?: () => number;
}

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function equals(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(op: '<' | '<=' | '>' | '>=', a: Value, b: Value): boolean {
  if (a === null || b === null) return false;
  if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) {
    throw new ExprError(`cannot compare ${typeof a} with ${typeof b}`);
  }
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
  }
}

function lookup(data: Value, path: (string | number)[]): Value {
  let cur: Value = data;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return null;
    if (Array.isArray(cur)) {
      if (typeof seg !== 'number') return null;
      cur = cur[seg] ?? null;
    } else {
      // Only own properties: no prototype walking (`constructor`, `__proto__`).
      if (!Object.hasOwn(cur, String(seg))) return null;
      cur = cur[String(seg)] ?? null;
    }
  }
  return cur;
}

export function evaluate(node: Node, data: Record<string, unknown>, opts: EvalOptions = {}): Value {
  const maxSteps = opts.maxSteps ?? 10_000;
  const ctx: EvalContext = { now: opts.now ?? Date.now };
  let steps = 0;
  const root = data as Value;

  function ev(n: Node): Value {
    if (++steps > maxSteps) throw new ExprError(`step limit of ${maxSteps} exceeded`);
    switch (n.kind) {
      case 'lit':
        return n.value;
      case 'ref':
        return lookup(root, n.path);
      case 'list':
        return n.items.map(ev);
      case 'unary': {
        const v = ev(n.arg);
        return n.op === '!' ? !truthy(v) : -num(v, 'negation');
      }
      case 'call': {
        const fn = FUNCTIONS[n.fn]!;
        const [lo, hi] = fn.arity;
        if (n.args.length < lo || n.args.length > hi) throw new ExprError(`${n.fn}: wrong number of arguments`);
        if (n.fn === 'if') return truthy(ev(n.args[0]!)) ? ev(n.args[1]!) : ev(n.args[2]!);
        return fn.impl(n.args.map(ev), ctx);
      }
      case 'binary': {
        if (n.op === '&&') return truthy(ev(n.left)) && truthy(ev(n.right));
        if (n.op === '||') return truthy(ev(n.left)) || truthy(ev(n.right));
        const a = ev(n.left);
        const b = ev(n.right);
        switch (n.op) {
          case '==':
            return equals(a, b);
          case '!=':
            return !equals(a, b);
          case '<':
          case '<=':
          case '>':
          case '>=':
            return compare(n.op, a, b);
          case 'in':
            if (Array.isArray(b)) return b.some((x) => equals(x, a));
            if (typeof b === 'string') return b.includes(str(a));
            throw new ExprError("'in' expects a list or string on the right");
          case '+':
            if (typeof a === 'string' || typeof b === 'string') {
              const s = str(a) + str(b);
              if (s.length > 100_000) throw new ExprError('string too long');
              return s;
            }
            return num(a, '+') + num(b, '+');
          case '-':
            return num(a, '-') - num(b, '-');
          case '*':
            return num(a, '*') * num(b, '*');
          case '/': {
            const d = num(b, '/');
            if (d === 0) throw new ExprError('division by zero');
            return num(a, '/') / d;
          }
          case '%': {
            const d = num(b, '%');
            if (d === 0) throw new ExprError('division by zero');
            return num(a, '%') % d;
          }
        }
      }
    }
  }
  return ev(node);
}

/** Field references used by an expression, e.g. for validating against a schema. */
export function references(node: Node): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.kind === 'ref') out.add(n.path.join('.'));
    else if (n.kind === 'list') n.items.forEach(walk);
    else if (n.kind === 'call') n.args.forEach(walk);
    else if (n.kind === 'unary') walk(n.arg);
    else if (n.kind === 'binary') {
      walk(n.left);
      walk(n.right);
    }
  };
  walk(node);
  return [...out];
}

/** Compile once, evaluate many times. */
export function compile(src: string) {
  const ast = parse(src);
  return {
    ast,
    references: references(ast),
    eval: (data: Record<string, unknown>, opts?: EvalOptions) => evaluate(ast, data, opts),
    test: (data: Record<string, unknown>, opts?: EvalOptions) => truthy(evaluate(ast, data, opts)),
  };
}
