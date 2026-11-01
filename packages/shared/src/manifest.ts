import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parse as parseExpr } from './expr/index.ts';
import { AnalyticsMetric, validateAnalyticsMetric } from './analytics.ts';
import { PermissionLevel } from './permissions.ts';

/**
 * App manifest (`templates/<app>/manifest.yaml`).
 *
 * The manifest is the app's contract with the platform: what it stores, which events
 * it publishes, which commands may emit which events, which permissions exist, and
 * what the assistant may do with it. `validateManifest` rejects incomplete contracts.
 */

const ident = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lower_snake_case identifier');
const eventType = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'dotted event type, e.g. order.created');
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

export const FieldType = z.enum(['text', 'number', 'money', 'boolean', 'date', 'datetime', 'select', 'uuid', 'json']);
export type FieldType = z.infer<typeof FieldType>;

export const EntityField = z.object({
  key: ident,
  label: z.string(),
  type: FieldType,
  options: z.array(z.string()).optional(),
  pii: z.boolean().default(false),
  sortable: z.boolean().default(false),
  facet: z.boolean().default(false),
  searchable: z.boolean().default(false),
});

export const Entity = z.object({
  name: ident,
  label: z.string(),
  /** Cedar-style resource type, e.g. `ordering::Order` */
  resource: z.string().regex(/^[a-z][a-z0-9_]*::[A-Z][A-Za-z0-9]*$/),
  table: z.string().regex(/^[a-z][a-z0-9_]*$/),
  shipped: z.boolean().default(true),
  custom_fields: z.boolean().default(false),
  /** permission needed to list/read this entity (default `<app>:<entity>.read`) */
  read_permission: z.string().optional(),
  /** list/detail workspace in the SPA (needs id, version, search columns) */
  workspace: z.boolean().default(true),
  /** events this entity's lifecycle produces; must all be listed in events.publishes */
  events: z.array(eventType).min(1),
  fields: z.array(EntityField).min(1),
  default_sort: z.string().optional(),
  /** field used as the record's title in links and pickers */
  title_field: z.string().optional(),
});
export type Entity = z.infer<typeof Entity>;

export const PublishedEvent = z.object({
  type: eventType,
  version: z.int().positive().default(1),
  entity: ident,
  description: z.string(),
  /** top-level keys of `data` */
  data: z.array(z.string()).default([]),
});

export const ConsumedEvent = z.object({
  type: eventType,
  /** consumer name, unique within the app */
  consumer: ident,
  /** capability rule that must be active for this consumer to run (see catalog config) */
  capability: z.string().optional(),
});

export const Command = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  description: z.string(),
  permission: z.string(),
  entity: ident,
  /** events this command may emit; an empty list is allowed but must be explicit */
  may_emit: z.array(eventType),
  idempotent: z.boolean().default(true),
});
export type Command = z.infer<typeof Command>;

export const ManifestPermission = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  label: z.string(),
  level: PermissionLevel,
});

export const View = z.object({
  name: ident,
  label: z.string(),
  entity: ident,
  /** safe-expression filter evaluated in SQL-compatible form: field facets only */
  filter: z.record(z.string(), z.array(z.string())).default({}),
  sort: z.string().optional(),
});

export const WorkflowTemplate = z.object({
  name: ident,
  label: z.string(),
  trigger: eventType,
  condition: z.string().optional(),
  action: z.string(),
});


export const RiskTier = z.enum(['read', 'low', 'high']);
export const AssistantTool = z.object({
  name: ident,
  description: z.string(),
  risk: RiskTier,
  command: z.string().optional(),
  view: ident.optional(),
});

export const Release = z.object({
  version: semver,
  channel: z.enum(['stable', 'canary']),
  /** migration files (in order) that make up this release's schema */
  migrations: z.array(z.string()),
  notes: z.string().default(''),
});

/**
 * Link index declarations: when `on` is published, record a relation between two
 * records (ids taken from event paths, e.g. `data.order_id`). No cross-app FKs needed.
 */
export const LinkDecl = z.object({
  on: eventType,
  from: z.object({ resource: z.string().regex(/^[a-z][a-z0-9_]*::[A-Z][A-Za-z0-9]*$/), id: z.string().regex(/^data(\.[a-z_][a-z0-9_]*)+$/) }),
  to: z.object({ resource: z.string().regex(/^[a-z][a-z0-9_]*::[A-Z][A-Za-z0-9]*$/), id: z.string().regex(/^data(\.[a-z_][a-z0-9_]*)+$/) }),
  rel: ident,
});
export type LinkDecl = z.infer<typeof LinkDecl>;

export const Manifest = z.object({
  id: ident,
  name: z.string(),
  description: z.string(),
  package: z.enum(['Apps', 'Analytics', 'Bot', 'Omnichannel']),
  version: semver,
  releases: z.array(Release).min(1),
  dependencies: z
    .object({
      requires: z.array(ident).default([]),
      optional: z.array(ident).default([]),
    })
    .default({ requires: [], optional: [] }),
  entities: z.array(Entity).min(1),
  events: z.object({
    publishes: z.array(PublishedEvent).min(1),
    consumes: z.array(ConsumedEvent).default([]),
  }),
  commands: z.array(Command).min(1),
  views: z.array(View).default([]),
  workflows: z.object({ templates: z.array(WorkflowTemplate).default([]) }).default({ templates: [] }),
  analytics: z.object({ metrics: z.array(AnalyticsMetric).default([]) }).default({ metrics: [] }),
  assistant: z.object({ tools: z.array(AssistantTool).default([]) }).default({ tools: [] }),
  telemetry: z.object({
    spans: z.array(z.string()).default([]),
    metrics: z.array(z.string()).default([]),
  }),
  permissions: z.array(ManifestPermission).min(1),
  links: z.array(LinkDecl).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type Manifest = z.infer<typeof Manifest>;

export class ManifestError extends Error {
  readonly problems: string[];
  constructor(app: string, problems: string[]) {
    super(`manifest '${app}' is invalid:\n - ${problems.join('\n - ')}`);
    this.name = 'ManifestError';
    this.problems = problems;
  }
}

/** Statements an "expand-only" migration may not contain. */
const CONTRACTING_SQL = [
  /\bdrop\s+(table|column|index|view|type|schema|function|constraint)\b/i,
  /\balter\s+table\b[^;]*\brename\b/i,
  /\balter\s+column\b[^;]*\btype\b/i,
  /\balter\s+column\b[^;]*\bset\s+not\s+null\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
];

/** Returns the contracting statements found in an up-migration (empty = expand-only). */
export function contractingStatements(sql: string): string[] {
  const up = sql.split(/^--\s*Down Migration/im)[0] ?? sql;
  const noComments = up.replace(/--.*$/gm, '');
  return CONTRACTING_SQL.filter((re) => re.test(noComments)).map((re) => re.source);
}

/**
 * Validates a manifest object. `migrationSources` (file name -> SQL) enables the
 * expand-only check for every release after the first.
 */
export function validateManifest(raw: unknown, migrationSources?: Record<string, string>): Manifest {
  const parsed = Manifest.safeParse(raw);
  const appId = (raw as { id?: string })?.id ?? '?';
  if (!parsed.success) {
    throw new ManifestError(
      appId,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const m = parsed.data;
  const problems: string[] = [];
  const published = new Set(m.events.publishes.map((e) => e.type));
  const consumed = new Set(m.events.consumes.map((e) => e.type));
  const entities = new Map(m.entities.map((e) => [e.name, e]));
  const permissions = new Set(m.permissions.map((p) => p.id));
  const commands = new Set(m.commands.map((c) => c.name));

  for (const p of m.permissions) {
    if (!p.id.startsWith(`${m.id}:`)) problems.push(`permission ${p.id} must be namespaced '${m.id}:'`);
  }
  for (const e of m.entities) {
    if (!e.resource.startsWith(`${m.id}::`)) problems.push(`entity ${e.name}: resource must be '${m.id}::<Type>'`);
    if (e.shipped) {
      for (const ev of e.events) {
        if (!published.has(ev)) problems.push(`entity ${e.name}: event ${ev} is not listed in events.publishes`);
      }
    }
    const readPerm = e.read_permission ?? `${m.id}:${e.name}.read`;
    if (e.workspace && !permissions.has(readPerm)) problems.push(`entity ${e.name}: read permission ${readPerm} is not declared`);
    if (e.default_sort && !e.fields.some((f) => f.key === e.default_sort?.replace(/^-/, ''))) {
      problems.push(`entity ${e.name}: default_sort ${e.default_sort} is not a field`);
    }
  }
  for (const ev of m.events.publishes) {
    const ent = entities.get(ev.entity);
    if (!ent) problems.push(`event ${ev.type}: unknown entity ${ev.entity}`);
    else if (!ent.events.includes(ev.type)) problems.push(`event ${ev.type}: not declared on entity ${ev.entity}`);
  }
  const names = new Set<string>();
  for (const c of m.commands) {
    if (names.has(c.name)) problems.push(`command ${c.name} is declared twice`);
    names.add(c.name);
    if (!entities.has(c.entity)) problems.push(`command ${c.name}: unknown entity ${c.entity}`);
    if (!permissions.has(c.permission)) problems.push(`command ${c.name}: permission ${c.permission} is not declared`);
    for (const ev of c.may_emit) {
      if (!published.has(ev)) problems.push(`command ${c.name}: may_emit ${ev} is not in events.publishes`);
    }
  }
  for (const v of m.views) {
    const ent = entities.get(v.entity);
    if (!ent) {
      problems.push(`view ${v.name}: unknown entity ${v.entity}`);
      continue;
    }
    for (const key of Object.keys(v.filter)) {
      if (!ent.fields.some((f) => f.key === key && f.facet)) problems.push(`view ${v.name}: filter field ${key} is not a facet`);
    }
  }
  for (const w of m.workflows.templates) {
    if (!published.has(w.trigger) && !consumed.has(w.trigger)) problems.push(`workflow ${w.name}: trigger ${w.trigger} is neither published nor consumed`);
    if (w.condition) {
      try {
        parseExpr(w.condition);
      } catch (err) {
        problems.push(`workflow ${w.name}: condition does not parse: ${(err as Error).message}`);
      }
    }
    if (!commands.has(w.action)) problems.push(`workflow ${w.name}: action ${w.action} is not a command`);
  }
  for (const a of m.analytics.metrics) {
    const ent = entities.get(a.entity);
    if (!ent) problems.push(`metric ${a.name}: unknown entity ${a.entity}`);
    else {
      const evs = new Set(m.events.publishes.filter((e) => e.entity === a.entity).map((e) => e.type));
      problems.push(...validateAnalyticsMetric(a, evs, new Set(ent.fields.map((f) => f.key))));
      if (!a.events.length) problems.push(`metric ${a.name}: needs at least one event`);
    }
  }
  for (const t of m.assistant.tools) {
    if (!t.command && !t.view) problems.push(`assistant tool ${t.name}: needs a command or a view`);
    if (t.command && !commands.has(t.command)) problems.push(`assistant tool ${t.name}: unknown command ${t.command}`);
    if (t.view && !m.views.some((v) => v.name === t.view)) problems.push(`assistant tool ${t.name}: unknown view ${t.view}`);
    if (t.command && t.risk === 'read') problems.push(`assistant tool ${t.name}: a command tool cannot be risk tier 'read'`);
  }
  for (const l of m.links) {
    if (!published.has(l.on)) problems.push(`link ${l.rel}: event ${l.on} is not in events.publishes`);
    if (!l.from.resource.startsWith(`${m.id}::`)) problems.push(`link ${l.rel}: from must be one of this app's resources`);
    const ev = m.events.publishes.find((e) => e.type === l.on);
    for (const path of [l.from.id, l.to.id]) {
      const top = path.split('.')[1]!;
      if (ev && ev.data.length && !ev.data.includes(top)) problems.push(`link ${l.rel}: ${l.on} has no data.${top}`);
    }
  }
  for (const e of m.entities) {
    if (e.title_field && !e.fields.some((f) => f.key === e.title_field)) problems.push(`entity ${e.name}: title_field ${e.title_field} is not a field`);
  }
  const versions = m.releases.map((r) => r.version);
  if (!versions.includes(m.version)) problems.push(`version ${m.version} has no release entry`);
  for (let i = 1; i < m.releases.length; i++) {
    const prev = m.releases[i - 1]!;
    const cur = m.releases[i]!;
    if (cur.migrations.slice(0, prev.migrations.length).join() !== prev.migrations.join()) {
      problems.push(`release ${cur.version} must extend the migrations of ${prev.version}`);
    }
    if (migrationSources) {
      for (const file of cur.migrations.slice(prev.migrations.length)) {
        const sql = migrationSources[file];
        if (sql === undefined) problems.push(`release ${cur.version}: migration ${file} not found`);
        else {
          const bad = contractingStatements(sql);
          if (bad.length) problems.push(`release ${cur.version}: migration ${file} is not expand-only (${bad.join(', ')})`);
        }
      }
    }
  }
  if (migrationSources) {
    for (const r of m.releases) {
      for (const f of r.migrations) if (migrationSources[f] === undefined) problems.push(`release ${r.version}: migration ${f} not found`);
    }
  }
  if (problems.length) throw new ManifestError(m.id, [...new Set(problems)]);
  return m;
}

export function parseManifestYaml(source: string, migrationSources?: Record<string, string>): Manifest {
  return validateManifest(parseYaml(source), migrationSources);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
