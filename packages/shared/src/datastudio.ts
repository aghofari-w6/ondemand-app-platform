import { z } from 'zod';
import { CustomMetric } from './analytics.ts';
import { parse as parseExpr, references } from './expr/index.ts';

/**
 * Data studio metadata. A tenant edits a draft `Definition`, sees its impact, publishes
 * it as a new version, and can roll back to any earlier version. The published version
 * drives custom fields on app entities, custom entities (formulas, rollups, rules),
 * layouts and per-role field access.
 */

const key = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'lower_snake_case, max 41 characters');

export const CustomFieldType = z.enum(['text', 'number', 'boolean', 'date', 'select', 'link']);

export const FieldDef = z.object({
  key,
  label: z.string().trim().min(1).max(60),
  type: CustomFieldType,
  options: z.array(z.string().min(1).max(60)).max(50).default([]),
  required: z.boolean().default(false),
  /** encrypted at rest (AES-256-GCM); excluded from filters, sort and indexes */
  pii: z.boolean().default(false),
  /** build a per-tenant expression index (CREATE INDEX CONCURRENTLY) */
  indexed: z.boolean().default(false),
  /** value written into existing records by a backfill when the field is added */
  default: z.union([z.string(), z.number(), z.boolean()]).nullable().default(null),
  /** computed, read-only field (expression language); custom entities only */
  formula: z.string().max(500).optional(),
  /** for `link` fields: `custom:<entity>` or `<app>:<entity>` */
  link: z.string().regex(/^(custom|[a-z][a-z0-9_]*):[a-z][a-z0-9_]*$/).optional(),
});
export type FieldDef = z.infer<typeof FieldDef>;

export const AppFieldSet = z.object({ app: key, entity: key, fields: z.array(FieldDef).max(100) });

export const Rollup = z.object({
  key,
  label: z.string().trim().min(1).max(60),
  /** child custom entity whose `via` link field points at this entity */
  from: key,
  via: key,
  aggregate: z.enum(['count', 'sum', 'min', 'max']),
  field: key.optional(),
});
export type Rollup = z.infer<typeof Rollup>;

export const Rule = z.object({
  name: z.string().trim().min(1).max(60),
  /** optional guard: the rule applies only when this is true */
  when: z.string().max(500).optional(),
  /** must evaluate truthy, otherwise the write is rejected with `message` */
  condition: z.string().max(500),
  message: z.string().trim().min(1).max(200),
});

export const CustomEntity = z.object({
  key,
  label: z.string().trim().min(1).max(60),
  title_field: key,
  fields: z.array(FieldDef).min(1).max(100),
  rollups: z.array(Rollup).max(20).default([]),
  rules: z.array(Rule).max(50).default([]),
});
export type CustomEntity = z.infer<typeof CustomEntity>;

export const Layout = z.object({
  /** `custom:<entity>` or `<app>:<entity>` */
  target: z.string().regex(/^(custom|[a-z][a-z0-9_]*):[a-z][a-z0-9_]*$/),
  kind: z.enum(['list', 'form', 'board']),
  columns: z.array(key).max(30).default([]),
  sections: z.array(z.object({ title: z.string().max(60), fields: z.array(key).max(50) })).max(10).default([]),
  group_by: key.optional(),
  card_fields: z.array(key).max(6).default([]),
});
export type Layout = z.infer<typeof Layout>;

export const FieldAccessRule = z.object({
  /** preset name or custom role id */
  role: z.string().min(1).max(60),
  target: z.string().regex(/^(custom|[a-z][a-z0-9_]*):[a-z][a-z0-9_]*$/),
  /** built-in field key, `custom.<key>` on app entities, or a custom entity field key */
  field: z.string().regex(/^(custom\.)?[a-z][a-z0-9_]*$/),
  access: z.enum(['hidden', 'read', 'write']),
});
export type FieldAccessRule = z.infer<typeof FieldAccessRule>;

export const Definition = z.object({
  app_fields: z.array(AppFieldSet).default([]),
  entities: z.array(CustomEntity).default([]),
  layouts: z.array(Layout).default([]),
  field_access: z.array(FieldAccessRule).default([]),
  /** analytics metrics over custom entities */
  metrics: z.array(CustomMetric).max(50).default([]),
});
export type Definition = z.infer<typeof Definition>;

export const emptyDefinition = (): Definition => ({ app_fields: [], entities: [], layouts: [], field_access: [], metrics: [] });

/** What the validator needs to know about the rest of the platform. */
export interface DefinitionContext {
  /** app entities that accept custom fields: `<app>:<entity>` -> built-in field keys */
  appEntities: Record<string, string[]>;
  /** all app entities (for link targets and field access): `<app>:<entity>` -> built-in field keys */
  allAppEntities: Record<string, string[]>;
  roles: string[];
  limits: { custom_entities: number; custom_fields: number };
}

export const customResource = (entity: string) => `custom::${entity.replace(/(^|_)([a-z])/g, (_m, _p, c: string) => c.toUpperCase())}`;

function exprProblems(where: string, src: string, allowed: Set<string>): string[] {
  try {
    const refs = references(parseExpr(src)).map((r) => r.split('.')[0]!);
    const unknown = refs.filter((r) => !allowed.has(r));
    return unknown.length ? [`${where}: unknown field(s) ${[...new Set(unknown)].join(', ')}`] : [];
  } catch (e) {
    return [`${where}: ${(e as Error).message}`];
  }
}

/** Returns a list of problems (empty = valid). */
export function validateDefinition(def: Definition, ctx: DefinitionContext): string[] {
  const p: string[] = [];
  const entityKeys = new Set(def.entities.map((e) => e.key));

  const checkFields = (where: string, fields: FieldDef[], builtIn: string[], allowFormula: boolean) => {
    const seen = new Set<string>();
    for (const f of fields) {
      const at = `${where}.${f.key}`;
      if (seen.has(f.key)) p.push(`${at}: duplicate field`);
      seen.add(f.key);
      if (builtIn.includes(f.key)) p.push(`${at}: collides with a built-in field`);
      if (f.type === 'select' && f.options.length === 0) p.push(`${at}: a select field needs options`);
      if (f.type === 'link') {
        if (!f.link) p.push(`${at}: a link field needs a target`);
        else if (f.link.startsWith('custom:') ? !entityKeys.has(f.link.slice(7)) : !ctx.allAppEntities[f.link]) p.push(`${at}: unknown link target ${f.link}`);
      }
      if (f.pii && f.indexed) p.push(`${at}: a PII field cannot be indexed (values are encrypted)`);
      if (f.formula) {
        if (!allowFormula) p.push(`${at}: formulas are only available on custom entities`);
        if (f.pii || f.required || f.indexed) p.push(`${at}: a formula field cannot be PII, required or indexed`);
      }
      if (f.default !== null && f.type === 'select' && !f.options.includes(String(f.default))) p.push(`${at}: default is not one of the options`);
    }
  };

  const appSets = new Set<string>();
  for (const s of def.app_fields) {
    const target = `${s.app}:${s.entity}`;
    if (appSets.has(target)) p.push(`app_fields ${target}: listed twice`);
    appSets.add(target);
    const builtIn = ctx.appEntities[target];
    if (!builtIn) {
      p.push(`app_fields ${target}: entity does not accept custom fields`);
      continue;
    }
    checkFields(target, s.fields, builtIn, false);
    for (const f of s.fields) if (f.type === 'link') p.push(`${target}.${f.key}: link fields are only available on custom entities`);
  }

  for (const e of def.entities) {
    const where = `custom:${e.key}`;
    if (def.entities.filter((x) => x.key === e.key).length > 1) p.push(`${where}: entity defined twice`);
    checkFields(where, e.fields, ['id', 'version', 'created_at', 'updated_at'], true);
    const fieldKeys = new Set(e.fields.map((f) => f.key));
    if (!fieldKeys.has(e.title_field)) p.push(`${where}: title_field ${e.title_field} is not a field`);
    const rollupKeys = new Set(e.rollups.map((r) => r.key));
    for (const r of e.rollups) {
      if (fieldKeys.has(r.key)) p.push(`${where}.${r.key}: rollup collides with a field`);
      const child = def.entities.find((x) => x.key === r.from);
      const via = child?.fields.find((f) => f.key === r.via);
      if (!child) p.push(`${where}.${r.key}: unknown entity ${r.from}`);
      else if (!via || via.type !== 'link' || via.link !== `custom:${e.key}`) p.push(`${where}.${r.key}: ${r.from}.${r.via} must be a link to ${e.key}`);
      if (r.aggregate !== 'count') {
        const f = child?.fields.find((x) => x.key === r.field);
        if (!f || f.type !== 'number') p.push(`${where}.${r.key}: ${r.aggregate} needs a number field of ${r.from}`);
      }
    }
    // Formulas may use plain fields, rollups and earlier formulas.
    const available = new Set<string>([...e.fields.filter((f) => !f.formula).map((f) => f.key), ...rollupKeys, 'id', 'created_at']);
    for (const f of e.fields.filter((x) => x.formula)) {
      p.push(...exprProblems(`${where}.${f.key} formula`, f.formula!, available));
      available.add(f.key);
    }
    for (const r of e.rules) {
      p.push(...exprProblems(`${where} rule "${r.name}"`, r.condition, available));
      if (r.when) p.push(...exprProblems(`${where} rule "${r.name}" when`, r.when, available));
    }
  }

  const fieldsOf = (target: string): Map<string, FieldDef | null> | null => {
    if (target.startsWith('custom:')) {
      const e = def.entities.find((x) => x.key === target.slice(7));
      return e ? new Map(e.fields.map((f) => [f.key, f])) : null;
    }
    const builtIn = ctx.allAppEntities[target];
    if (!builtIn) return null;
    const m = new Map<string, FieldDef | null>(builtIn.map((k) => [k, null]));
    for (const f of def.app_fields.find((s) => `${s.app}:${s.entity}` === target)?.fields ?? []) m.set(`custom.${f.key}`, f);
    return m;
  };

  for (const l of def.layouts) {
    const fields = fieldsOf(l.target);
    if (!fields) {
      p.push(`layout ${l.kind} ${l.target}: unknown target`);
      continue;
    }
    const has = (k: string) => fields.has(k) || fields.has(`custom.${k}`);
    for (const c of [...l.columns, ...l.sections.flatMap((s) => s.fields), ...l.card_fields]) if (!has(c)) p.push(`layout ${l.kind} ${l.target}: unknown field ${c}`);
    if (l.kind === 'board') {
      const g = l.group_by ? (fields.get(l.group_by) ?? fields.get(`custom.${l.group_by}`)) : undefined;
      if (!l.group_by || g === undefined) p.push(`layout board ${l.target}: group_by must be a field`);
      else if (g && g.type !== 'select') p.push(`layout board ${l.target}: group_by must be a select field`);
    }
    if (def.layouts.filter((x) => x.target === l.target && x.kind === l.kind).length > 1) p.push(`layout ${l.kind} ${l.target}: defined twice`);
  }

  for (const a of def.field_access) {
    if (!ctx.roles.includes(a.role)) p.push(`field access: unknown role ${a.role}`);
    const fields = fieldsOf(a.target);
    if (!fields) p.push(`field access: unknown target ${a.target}`);
    else if (!fields.has(a.field)) p.push(`field access ${a.target}: unknown field ${a.field}`);
  }

  for (const m of def.metrics) {
    const ent = def.entities.find((e) => e.key === m.entity);
    if (!ent) {
      p.push(`metric ${m.key}: unknown custom entity ${m.entity}`);
      continue;
    }
    const f = m.field ? ent.fields.find((x) => x.key === m.field) : undefined;
    if (m.aggregate === 'sum' && (!f || f.type !== 'number')) p.push(`metric ${m.key}: sum needs a number field of ${m.entity}`);
    if (f?.pii) p.push(`metric ${m.key}: cannot aggregate the PII field ${f.key}`);
    for (const [d, k] of Object.entries(m.dims)) {
      const df = ent.fields.find((x) => x.key === k);
      if (!df) p.push(`metric ${m.key}: dimension ${d} uses unknown field ${k}`);
      else if (df.pii) p.push(`metric ${m.key}: dimension ${d} cannot use the PII field ${k}`);
    }
    if (def.metrics.filter((x) => x.key === m.key).length > 1) p.push(`metric ${m.key}: defined twice`);
  }

  const customFieldCount = def.app_fields.reduce((n, s) => n + s.fields.length, 0) + def.entities.reduce((n, e) => n + e.fields.length, 0);
  if (def.entities.length > ctx.limits.custom_entities) p.push(`plan limit: at most ${ctx.limits.custom_entities} custom entities (draft has ${def.entities.length})`);
  if (customFieldCount > ctx.limits.custom_fields) p.push(`plan limit: at most ${ctx.limits.custom_fields} custom fields (draft has ${customFieldCount})`);
  return [...new Set(p)];
}
