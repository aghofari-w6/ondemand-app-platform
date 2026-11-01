import { CommandError, graphFromTemplate, type FieldAccess, presetPermissions, ROLE_PRESETS, validateGraph, WorkflowGraph, type Principal, type WorkflowContext } from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../../db/database.ts';
import { publishedFieldRules, resolveRole } from '../../auth/principal.ts';
import { activeApps } from '../commands.ts';
import type { Platform } from '../context.ts';
import { publishedDefinition } from '../datastudio.ts';
import { recordChange } from '../record.ts';

/**
 * Workflow definitions follow the Data studio pattern: one draft per workflow, publish
 * validates it and supersedes the published version, rollback re-publishes an earlier
 * version as a new number. History only grows.
 */

const RESOURCE = 'platform::Workflow';
const RECORD_EVENTS = ['record.created', 'record.updated', 'record.deleted'];

export async function workflowContext(p: Platform, tx: Tx): Promise<WorkflowContext> {
  const active = new Set(await activeApps(tx));
  const events = new Set<string>(RECORD_EVENTS);
  const commands = new Map<string, string[]>();
  for (const m of p.catalog.manifests()) {
    if (!active.has(m.id)) continue;
    for (const e of m.events.publishes) events.add(e.type);
    for (const c of m.commands) commands.set(`${m.id}/${c.name}`, c.may_emit);
  }
  const { definition } = await publishedDefinition(tx);
  const endpoints = await tx.selectFrom('hub_endpoint').select('id').execute();
  const custom = await tx.selectFrom('custom_role').select('id').execute();
  const t = await tx.selectFrom('tenant').select('plan').executeTakeFirstOrThrow();
  return {
    events,
    commands,
    entities: new Set(definition.entities.map((e) => e.key)),
    endpoints: new Set(endpoints.map((e) => e.id as string)),
    roles: new Set<string>([...ROLE_PRESETS, ...custom.map((r) => r.id as string)]),
    limits: { workflow_nodes: p.ports.billing.plan(t.plan)?.limits.workflow_nodes ?? 0 },
  };
}

/** Parses and validates a graph; never throws for semantic problems, returns them. */
export async function checkGraph(p: Platform, tx: Tx, raw: unknown): Promise<{ graph: WorkflowGraph | null; problems: string[] }> {
  const parsed = WorkflowGraph.safeParse(raw);
  if (!parsed.success) return { graph: null, problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'graph'}: ${i.message}`) };
  return { graph: parsed.data, problems: validateGraph(parsed.data, await workflowContext(p, tx)) };
}

const emptyGraph = (): WorkflowGraph => ({ nodes: [{ id: 'trigger', type: 'trigger', name: 'When', position: { x: 0, y: 0 }, config: {} }], edges: [] });

export async function createWorkflow(
  p: Platform,
  tx: Tx,
  tenantId: string,
  actor: Principal,
  input: { name: string; description?: string | undefined; template?: { app: string; name: string } | undefined; graph?: unknown },
  correlationId: string,
) {
  const t = await tx.selectFrom('tenant').select('plan').executeTakeFirstOrThrow();
  const limit = p.ports.billing.plan(t.plan)?.limits.workflows ?? 0;
  const count = await tx.selectFrom('workflow').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
  if (count.n >= limit) throw new CommandError(409, 'plan_limit', `your plan allows ${limit} workflows`);

  let graph = emptyGraph();
  if (input.template) {
    const m = p.catalog.get(input.template.app)?.manifest;
    const tpl = m?.workflows.templates.find((w) => w.name === input.template!.name);
    if (!m || !tpl) throw new CommandError(404, 'unknown_template', 'workflow template not found');
    graph = graphFromTemplate({ trigger: tpl.trigger, condition: tpl.condition, action: tpl.action, app: m.id, label: tpl.label });
  } else if (input.graph !== undefined) {
    const g = WorkflowGraph.safeParse(input.graph);
    if (!g.success) throw new CommandError(422, 'invalid_graph', g.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    graph = g.data;
  }
  const id = newId();
  await tx
    .insertInto('workflow')
    .values({ id, tenant_id: tenantId, name: input.name, description: input.description ?? '', created_by: actor.id })
    .execute()
    .catch((e) => {
      if (e?.code === '23505') throw new CommandError(409, 'name_taken', `a workflow named ${input.name} exists`);
      throw e;
    });
  await tx.insertInto('workflow_version').values({ id: newId(), tenant_id: tenantId, workflow_id: id, number: 1, status: 'draft', graph: JSON.stringify(graph), trigger_event: triggerEvent(graph), created_by: actor.id }).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:workflow.created', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: 'workflow.created', data: { workflow_id: id, name: input.name } }] });
  return { id };
}

const triggerEvent = (g: WorkflowGraph) => {
  const e = g.nodes.find((n) => n.type === 'trigger')?.config.event;
  return typeof e === 'string' ? e : null;
};

export async function getWorkflow(tx: Tx, id: string) {
  const w = await tx.selectFrom('workflow').selectAll().where('id', '=', id).executeTakeFirst();
  if (!w) throw new CommandError(404, 'not_found', 'workflow not found');
  return w;
}

/** Saves the draft graph (opening a draft from the published version when none is open). */
export async function saveDraft(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, raw: unknown, expectedVersion: number | undefined, note: string | undefined, correlationId: string) {
  await getWorkflow(tx, id);
  const parsed = WorkflowGraph.safeParse(raw);
  if (!parsed.success) throw new CommandError(422, 'invalid_graph', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const graph = parsed.data;
  const draft = await tx.selectFrom('workflow_version').select(['id', 'number', 'version']).where('workflow_id', '=', id).where('status', '=', 'draft').forUpdate().executeTakeFirst();
  let number: number;
  let version: number;
  if (draft) {
    if (expectedVersion !== undefined && draft.version !== expectedVersion) throw new CommandError(409, 'version_conflict', `the draft changed (expected version ${expectedVersion}, current ${draft.version})`);
    const r = await tx
      .updateTable('workflow_version')
      .set({ graph: JSON.stringify(graph), trigger_event: triggerEvent(graph), note: note ?? '', version: sql`version + 1` })
      .where('id', '=', draft.id)
      .returning(['number', 'version'])
      .executeTakeFirstOrThrow();
    ({ number, version } = r);
  } else {
    const max = await tx.selectFrom('workflow_version').select([sql<number>`max(number)`.as('n')]).where('workflow_id', '=', id).executeTakeFirstOrThrow();
    const published = await tx.selectFrom('workflow_version').select('number').where('workflow_id', '=', id).where('status', '=', 'published').executeTakeFirst();
    number = Number(max.n ?? 0) + 1;
    version = 1;
    await tx.insertInto('workflow_version').values({ id: newId(), tenant_id: tenantId, workflow_id: id, number, status: 'draft', graph: JSON.stringify(graph), trigger_event: triggerEvent(graph), based_on: published?.number ?? null, note: note ?? '', created_by: actor.id }).execute();
  }
  await tx.updateTable('workflow').set({ updated_at: new Date() }).where('id', '=', id).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:workflow.draft_saved', resourceType: RESOURCE, resourceId: id, correlationId, data: { number, nodes: graph.nodes.length } });
  return { number, version, problems: validateGraph(graph, await workflowContext(p, tx)) };
}

/** Permissions of a principal (an Owner holds everything). */
export function heldPermissions(p: Platform, principal: Principal): Set<string> {
  if (principal.type === 'System') return new Set(p.catalog.permissions.map((x) => x.id));
  const out = new Set<string>();
  for (const r of principal.roles) for (const x of r.preset === 'Owner' ? presetPermissions('Owner', p.catalog.permissions) : r.permissions) out.add(x);
  return out;
}

/** Checks the graph is publishable and the service role fits under the publisher; returns the capped permission list. */
async function capServiceRole(p: Platform, tx: Tx, actor: Principal, role: string, graph: WorkflowGraph): Promise<string[]> {
  const resolved = await resolveRole(tx, p.catalog, role);
  if (!resolved) throw new CommandError(422, 'unknown_role', `unknown role ${role}`);
  const held = heldPermissions(p, actor);
  const extra = resolved.permissions.filter((x) => !held.has(x));
  if (extra.length) throw Object.assign(new CommandError(403, 'role_exceeds_publisher', `the workflow's role may not have more permissions than you: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', …' : ''}`), { details: { extra } });
  // Field rules: the workflow's role may not see or change a field its publisher cannot.
  const RANK: Record<FieldAccess, number> = { hidden: 0, read: 1, write: 2 };
  if (!actor.roles.some((r) => r.preset === 'Owner') && actor.type !== 'System') {
    const serviceRules = resolved.preset === 'Owner' ? [] : [...resolved.fieldRules, ...(await publishedFieldRules(tx, role))];
    const looser: string[] = [];
    for (const r of actor.roles.flatMap((x) => x.fieldRules)) {
      const mine = serviceRules.filter((x) => x.resource === r.resource && x.field === r.field);
      const access: FieldAccess = mine.length ? mine.reduce<FieldAccess>((a, b) => (RANK[b.access] > RANK[a] ? b.access : a), 'hidden') : 'write';
      if (RANK[access] > RANK[r.access]) looser.push(`${r.resource}.${r.field} (${access}; you have ${r.access})`);
    }
    if (looser.length) throw Object.assign(new CommandError(403, 'role_exceeds_publisher', `the workflow's role may not have more field access than you: ${looser.slice(0, 5).join(', ')}`), { details: { extra: looser } });
  }
  const perms = new Set(resolved.permissions);
  const missing: string[] = [];
  for (const n of graph.nodes) {
    const c = n.config as Record<string, any>;
    if (n.type === 'command') {
      const perm = p.catalog.command(c.app, c.command)?.def.permission;
      if (perm && !perms.has(perm)) missing.push(`${n.id} needs ${perm}`);
    }
    if (n.type === 'record' && !perms.has('platform:records.write')) missing.push(`${n.id} needs platform:records.write`);
    // Hub endpoints carry credentials an Admin configured: sending needs its own permission.
    if (n.type === 'hub_send' && !perms.has('platform:hub.send')) missing.push(`${n.id} needs platform:hub.send`);
  }
  if (missing.length) throw Object.assign(new CommandError(422, 'role_too_narrow', `the role ${resolved.name} cannot run this workflow: ${missing.join('; ')}`), { details: { missing } });
  return resolved.permissions;
}

async function publishGraph(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, graph: WorkflowGraph, role: string, versionId: string | null, number: number, basedOn: number | null, correlationId: string) {
  const problems = validateGraph(graph, await workflowContext(p, tx));
  if (problems.length) throw Object.assign(new CommandError(422, 'invalid_workflow', `the workflow has ${problems.length} problem(s): ${problems.slice(0, 3).join('; ')}`), { details: { problems } });
  const permissions = await capServiceRole(p, tx, actor, role, graph);
  await tx.updateTable('workflow_version').set({ status: 'superseded' }).where('workflow_id', '=', id).where('status', '=', 'published').execute();
  const values = { status: 'published', service_role: role, service_permissions: permissions, published_by: actor.id, published_at: new Date(), trigger_event: triggerEvent(graph) };
  if (versionId) {
    await tx.updateTable('workflow_version').set({ ...values, version: sql`version + 1` }).where('id', '=', versionId).execute();
  } else {
    await tx.insertInto('workflow_version').values({ id: newId(), tenant_id: tenantId, workflow_id: id, number, graph: JSON.stringify(graph), based_on: basedOn, note: `rollback to version ${basedOn}`, created_by: actor.id, ...values }).execute();
  }
  await tx.updateTable('workflow').set({ published_number: number, status: sql`CASE WHEN status = 'draft' THEN 'active' ELSE status END`, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
  await recordChange(p, tx, {
    tenantId,
    actor,
    action: basedOn && !versionId ? 'platform:workflow.rolled_back' : 'platform:workflow.published',
    resourceType: RESOURCE,
    resourceId: id,
    correlationId,
    events: [{ type: 'workflow.published', data: { workflow_id: id, number, service_role: role, trigger: triggerEvent(graph), ...(basedOn ? { based_on: basedOn } : {}) } }],
  });
  return { number };
}

export async function publishWorkflow(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, expectedVersion: number, role: string, correlationId: string) {
  await getWorkflow(tx, id);
  const draft = await tx.selectFrom('workflow_version').selectAll().where('workflow_id', '=', id).where('status', '=', 'draft').forUpdate().executeTakeFirst();
  if (!draft) throw new CommandError(404, 'no_draft', 'there is no draft to publish');
  if (draft.version !== expectedVersion) throw new CommandError(409, 'version_conflict', `the draft changed (expected version ${expectedVersion}, current ${draft.version})`);
  return publishGraph(p, tx, tenantId, actor, id, WorkflowGraph.parse(draft.graph), role, draft.id, draft.number, draft.based_on, correlationId);
}

export async function rollbackWorkflow(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, number: number, role: string | undefined, correlationId: string) {
  await getWorkflow(tx, id);
  if (await tx.selectFrom('workflow_version').select('id').where('workflow_id', '=', id).where('status', '=', 'draft').executeTakeFirst()) {
    throw new CommandError(409, 'draft_open', 'publish or discard the open draft before rolling back');
  }
  const target = await tx.selectFrom('workflow_version').selectAll().where('workflow_id', '=', id).where('number', '=', number).executeTakeFirst();
  if (!target || target.status === 'draft' || target.status === 'discarded') throw new CommandError(404, 'not_found', `version ${number} cannot be restored`);
  if (target.status === 'published') throw new CommandError(409, 'already_published', `version ${number} is already published`);
  const max = await tx.selectFrom('workflow_version').select(sql<number>`max(number)`.as('n')).where('workflow_id', '=', id).executeTakeFirstOrThrow();
  return publishGraph(p, tx, tenantId, actor, id, WorkflowGraph.parse(target.graph), role ?? target.service_role ?? 'Staff', null, Number(max.n) + 1, number, correlationId);
}

export async function discardWorkflowDraft(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, correlationId: string) {
  const r = await tx.updateTable('workflow_version').set({ status: 'discarded' }).where('workflow_id', '=', id).where('status', '=', 'draft').returning('number').executeTakeFirst();
  if (!r) throw new CommandError(404, 'no_draft', 'there is no draft');
  await recordChange(p, tx, { tenantId, actor, action: 'platform:workflow.draft_discarded', resourceType: RESOURCE, resourceId: id, correlationId, data: { number: r.number } });
}

/** Starting work a workflow will do (enable, retry) needs the actor to hold everything its role may do. */
export async function assertActorCovers(p: Platform, tx: Tx, actor: Principal, workflowId: string, number: number) {
  const v = await tx.selectFrom('workflow_version').select('service_permissions').where('workflow_id', '=', workflowId).where('number', '=', number).executeTakeFirst();
  const held = heldPermissions(p, actor);
  const extra = ((v?.service_permissions as string[] | undefined) ?? []).filter((x) => !held.has(x));
  if (extra.length) throw Object.assign(new CommandError(403, 'role_exceeds_actor', `this workflow acts with permissions you do not have: ${extra.slice(0, 5).join(', ')}`), { details: { extra } });
}

export async function setWorkflowStatus(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, status: 'active' | 'disabled', correlationId: string) {
  const w = await getWorkflow(tx, id);
  if (status === 'active' && !w.published_number) throw new CommandError(409, 'not_published', 'publish the workflow first');
  if (status === 'active') await assertActorCovers(p, tx, actor, id, w.published_number!);
  await tx.updateTable('workflow').set({ status, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
  await recordChange(p, tx, { tenantId, actor, action: `platform:workflow.${status === 'active' ? 'enabled' : 'disabled'}`, resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: `workflow.${status === 'active' ? 'enabled' : 'disabled'}`, data: { workflow_id: id } }] });
}
