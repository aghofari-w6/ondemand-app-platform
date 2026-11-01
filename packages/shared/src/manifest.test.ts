import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { contractingStatements, ManifestError, validateManifest } from './manifest.ts';

const templates = fileURLToPath(new URL('../../../templates', import.meta.url));
const load = (app: string) => {
  const dir = join(templates, app);
  const sources = Object.fromEntries(readdirSync(join(dir, 'migrations')).map((f) => [f, readFileSync(join(dir, 'migrations', f), 'utf8')]));
  return { raw: parse(readFileSync(join(dir, 'manifest.yaml'), 'utf8')), sources };
};
const problems = (raw: unknown, sources?: Record<string, string>) => {
  try {
    validateManifest(raw, sources);
    return [];
  } catch (e) {
    if (e instanceof ManifestError) return e.problems;
    throw e;
  }
};
const clone = <T>(x: T): T => structuredClone(x);

describe('manifest validator', () => {
  for (const app of ['ordering', 'payments', 'pos', 'logistics']) {
    it(`accepts the shipped ${app} manifest`, () => {
      const { raw, sources } = load(app);
      expect(problems(raw, sources)).toEqual([]);
    });
  }

  it('rejects an entity event missing from events.publishes', () => {
    const m = clone(load('ordering').raw);
    m.events.publishes = m.events.publishes.filter((e: any) => e.type !== 'order.cancelled');
    expect(problems(m).join()).toMatch(/event order.cancelled is not listed in events.publishes/);
  });

  it('rejects a command without may_emit, or emitting undeclared events', () => {
    const m = clone(load('ordering').raw);
    delete m.commands[0].may_emit;
    expect(problems(m).join()).toMatch(/commands.0.may_emit/);
    const m2 = clone(load('ordering').raw);
    m2.commands[0].may_emit = ['order.exploded'];
    expect(problems(m2).join()).toMatch(/may_emit order.exploded is not in events.publishes/);
  });

  it('rejects undeclared permissions, bad tools and bad workflow conditions', () => {
    const m = clone(load('ordering').raw);
    m.commands[0].permission = 'ordering:order.teleport';
    m.assistant.tools.push({ name: 'x', description: 'x', risk: 'read', command: 'order.cancel' });
    m.workflows.templates[0].condition = 'total >';
    const p = problems(m).join('\n');
    expect(p).toMatch(/permission ordering:order.teleport is not declared/);
    expect(p).toMatch(/cannot be risk tier 'read'/);
    expect(p).toMatch(/condition does not parse/);
  });

  it('requires later releases to be expand-only', () => {
    const { raw, sources } = load('ordering');
    const bad = { ...sources, '20261101100002_ordering_pickup_eta.sql': '-- Up Migration\nALTER TABLE ord_order DROP COLUMN notes;' };
    expect(problems(raw, bad).join()).toMatch(/not expand-only/);
    expect(contractingStatements('-- Up Migration\nALTER TABLE x ADD COLUMN y int;\n-- Down Migration\nDROP TABLE x;')).toEqual([]);
    expect(contractingStatements('ALTER TABLE x RENAME COLUMN a TO b;')).not.toEqual([]);
  });
});
