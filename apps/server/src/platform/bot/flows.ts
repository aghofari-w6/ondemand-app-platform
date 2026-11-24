import { BotGraph, CommandError, orderStatusFlow, validateBotGraph, type BotChannel, type BotContext, type Principal } from '@aod/shared';
import { sql } from 'kysely';
import { publishedFieldRules, resolveRole, systemPrincipal } from '../../auth/principal.ts';
import { newId, type Tx } from '../../db/database.ts';
import { toolsFor } from '../assistant/tools.ts';
import type { Platform } from '../context.ts';
import { BOT_PACKAGE, planLimit, requirePackage } from '../packages.ts';
import { recordChange } from '../record.ts';
import { heldPermissions } from '../workflows/definitions.ts';

/**
 * Bot flow definitions follow the workflow pattern: one draft per flow, publish validates
 * it and supersedes the published version, rollback re-publishes an earlier version as a
 * new number. A published flow looks things up with a service role capped at what its
 * publisher holds, never as `System`.
 */

const RESOURCE = 'platform::BotFlow';
export const MAX_BOT_NODES = 60;

/** Read tools a flow may use: every view tool of the active apps. */
export async function botContext(p: Platform, tx: Tx): Promise<BotContext> {
  const tools = (await toolsFor(p, tx, systemPrincipal((await tx.selectFrom('tenant').select('id').executeTakeFirstOrThrow()).id))).filter((t) => t.kind === 'view');
  return { tools: new Set(tools.map((t) => t.name)), limits: { nodes: MAX_BOT_NODES } };
}

const channelsOf = (g: BotGraph): BotChannel[] => ((g.nodes.find((n) => n.type === 'start')?.config.channels as BotChannel[] | undefined) ?? []).filter((c) => ['telegram', 'gmail', 'widget'].includes(c));

function parseGraph(raw: unknown): BotGraph {
  const g = BotGraph.safeParse(raw);
  if (!g.success) throw new CommandError(422, 'invalid_graph', g.error.issues.map((i) => `${i.path.join('.') || 'graph'}: ${i.message}`).join('; '));
  return g.data;
}

export async function getFlow(tx: Tx, id: string) {
  const f = await tx.selectFrom('bot_flow').selectAll().where('id', '=', id).executeTakeFirst();
  if (!f) throw new CommandError(404, 'not_found', 'bot flow not found');
  return f;
}

export async function createFlow(p: Platform, tx: Tx, tenantId: string, actor: Principal, input: { name: string; description?: string | undefined; template?: 'order_status' | undefined; channels?: BotChannel[] | undefined; graph?: unknown }, correlationId: string) {
  await requirePackage(p, tx, BOT_PACKAGE);
  const limit = await planLimit(p, tx, 'bot_flows');
  const n = await tx.selectFrom('bot_flow').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
  if (n.n >= limit) throw new CommandError(409, 'plan_limit', `your plan allows ${limit} bot flows`);
  const graph = input.graph !== undefined ? parseGraph(input.graph) : input.template === 'order_status' ? orderStatusFlow(input.channels ?? ['widget']) : ({ nodes: [{ id: 'start', type: 'start', name: 'Customer writes', position: { x: 0, y: 0 }, config: { channels: input.channels ?? ['widget'] } }], edges: [] } satisfies BotGraph);
  const id = newId();
  await tx
    .insertInto('bot_flow')
    .values({ id, tenant_id: tenantId, name: input.name, description: input.description ?? '', created_by: actor.id })
    .execute()
    .catch((e) => {
      if (e?.code === '23505') throw new CommandError(409, 'name_taken', `a bot flow named ${input.name} exists`);
      throw e;
    });
  await tx.insertInto('bot_flow_version').values({ id: newId(), tenant_id: tenantId, flow_id: id, number: 1, status: 'draft', graph: JSON.stringify(graph), channels: channelsOf(graph), created_by: actor.id }).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:bot_flow.created', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: 'bot_flow.created', data: { flow_id: id, name: input.name } }] });
  return { id };
}

export async function saveFlowDraft(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, raw: unknown, expectedVersion: number | undefined, correlationId: string) {
  await getFlow(tx, id);
  const graph = parseGraph(raw);
  const draft = await tx.selectFrom('bot_flow_version').select(['id', 'number', 'version']).where('flow_id', '=', id).where('status', '=', 'draft').forUpdate().executeTakeFirst();
  let number: number;
  let version: number;
  if (draft) {
    if (expectedVersion !== undefined && draft.version !== expectedVersion) throw new CommandError(409, 'version_conflict', `the draft changed (expected version ${expectedVersion}, current ${draft.version})`);
    ({ number, version } = await tx.updateTable('bot_flow_version').set({ graph: JSON.stringify(graph), channels: channelsOf(graph), version: sql`version + 1` }).where('id', '=', draft.id).returning(['number', 'version']).executeTakeFirstOrThrow());
  } else {
    const max = await tx.selectFrom('bot_flow_version').select(sql<number>`max(number)`.as('n')).where('flow_id', '=', id).executeTakeFirstOrThrow();
    const published = await tx.selectFrom('bot_flow_version').select('number').where('flow_id', '=', id).where('status', '=', 'published').executeTakeFirst();
    number = Number(max.n ?? 0) + 1;
    version = 1;
    await tx.insertInto('bot_flow_version').values({ id: newId(), tenant_id: tenantId, flow_id: id, number, status: 'draft', graph: JSON.stringify(graph), channels: channelsOf(graph), based_on: published?.number ?? null, created_by: actor.id }).execute();
  }
  await tx.updateTable('bot_flow').set({ updated_at: new Date() }).where('id', '=', id).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:bot_flow.draft_saved', resourceType: RESOURCE, resourceId: id, correlationId, data: { number, nodes: graph.nodes.length } });
  return { number, version, problems: validateBotGraph(graph, await botContext(p, tx)) };
}

/** The role may not exceed the publisher, and must be able to run every lookup of the flow. */
async function capRole(p: Platform, tx: Tx, actor: Principal, role: string, graph: BotGraph): Promise<string[]> {
  const resolved = await resolveRole(tx, p.catalog, role);
  if (!resolved) throw new CommandError(422, 'unknown_role', `unknown role ${role}`);
  const held = heldPermissions(p, actor);
  const extra = resolved.permissions.filter((x) => !held.has(x));
  if (extra.length) throw Object.assign(new CommandError(403, 'role_exceeds_publisher', `the bot's role may not have more permissions than you: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', …' : ''}`), { details: { extra } });
  const tools = await toolsFor(p, tx, systemPrincipal(actor.tenantId));
  const missing: string[] = [];
  for (const n of graph.nodes.filter((x) => x.type === 'lookup')) {
    const perm = tools.find((t) => t.name === n.config.tool)?.permission;
    if (perm && !resolved.permissions.includes(perm)) missing.push(`${n.id} needs ${perm}`);
  }
  if (missing.length) throw Object.assign(new CommandError(422, 'role_too_narrow', `the role ${resolved.name} cannot run this flow: ${missing.join('; ')}`), { details: { missing } });
  return resolved.permissions;
}

async function publishGraph(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, graph: BotGraph, role: string, versionId: string | null, number: number, basedOn: number | null, correlationId: string) {
  const problems = validateBotGraph(graph, await botContext(p, tx));
  if (problems.length) throw Object.assign(new CommandError(422, 'invalid_flow', `the flow has ${problems.length} problem(s): ${problems.slice(0, 3).join('; ')}`), { details: { problems } });
  const permissions = await capRole(p, tx, actor, role, graph);
  await tx.updateTable('bot_flow_version').set({ status: 'superseded' }).where('flow_id', '=', id).where('status', '=', 'published').execute();
  const values = { status: 'published', service_role: role, service_permissions: permissions, channels: channelsOf(graph), published_by: actor.id, published_at: new Date() };
  if (versionId) await tx.updateTable('bot_flow_version').set({ ...values, version: sql`version + 1` }).where('id', '=', versionId).execute();
  else await tx.insertInto('bot_flow_version').values({ id: newId(), tenant_id: tenantId, flow_id: id, number, graph: JSON.stringify(graph), based_on: basedOn, note: `rollback to version ${basedOn}`, created_by: actor.id, ...values }).execute();
  await tx.updateTable('bot_flow').set({ published_number: number, status: sql`CASE WHEN status = 'draft' THEN 'active' ELSE status END`, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
  await recordChange(p, tx, { tenantId, actor, action: basedOn && !versionId ? 'platform:bot_flow.rolled_back' : 'platform:bot_flow.published', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: 'bot_flow.published', data: { flow_id: id, number, service_role: role, channels: channelsOf(graph), ...(basedOn ? { based_on: basedOn } : {}) } }] });
  return { number };
}

export async function publishFlow(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, expectedVersion: number, role: string, correlationId: string) {
  await getFlow(tx, id);
  const draft = await tx.selectFrom('bot_flow_version').selectAll().where('flow_id', '=', id).where('status', '=', 'draft').forUpdate().executeTakeFirst();
  if (!draft) throw new CommandError(404, 'no_draft', 'there is no draft to publish');
  if (draft.version !== expectedVersion) throw new CommandError(409, 'version_conflict', `the draft changed (expected version ${expectedVersion}, current ${draft.version})`);
  return publishGraph(p, tx, tenantId, actor, id, parseGraph(draft.graph), role, draft.id, draft.number, draft.based_on, correlationId);
}

export async function rollbackFlow(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, number: number, correlationId: string) {
  await getFlow(tx, id);
  if (await tx.selectFrom('bot_flow_version').select('id').where('flow_id', '=', id).where('status', '=', 'draft').executeTakeFirst()) throw new CommandError(409, 'draft_open', 'publish or discard the open draft before rolling back');
  const target = await tx.selectFrom('bot_flow_version').selectAll().where('flow_id', '=', id).where('number', '=', number).executeTakeFirst();
  if (!target || target.status !== 'superseded') throw new CommandError(target?.status === 'published' ? 409 : 404, target?.status === 'published' ? 'already_published' : 'not_found', `version ${number} cannot be restored`);
  const max = await tx.selectFrom('bot_flow_version').select(sql<number>`max(number)`.as('n')).where('flow_id', '=', id).executeTakeFirstOrThrow();
  return publishGraph(p, tx, tenantId, actor, id, parseGraph(target.graph), target.service_role ?? 'Viewer', null, Number(max.n) + 1, number, correlationId);
}

export async function discardFlowDraft(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, correlationId: string) {
  const r = await tx.updateTable('bot_flow_version').set({ status: 'discarded' }).where('flow_id', '=', id).where('status', '=', 'draft').returning('number').executeTakeFirst();
  if (!r) throw new CommandError(404, 'no_draft', 'there is no draft');
  await recordChange(p, tx, { tenantId, actor, action: 'platform:bot_flow.draft_discarded', resourceType: RESOURCE, resourceId: id, correlationId, data: { number: r.number } });
}

export async function setFlowStatus(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, status: 'active' | 'disabled', correlationId: string) {
  const f = await getFlow(tx, id);
  if (status === 'active' && !f.published_number) throw new CommandError(409, 'not_published', 'publish the flow first');
  await tx.updateTable('bot_flow').set({ status, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
  await recordChange(p, tx, { tenantId, actor, action: `platform:bot_flow.${status === 'active' ? 'enabled' : 'disabled'}`, resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: `bot_flow.${status === 'active' ? 'enabled' : 'disabled'}`, data: { flow_id: id } }] });
}

/** The principal a published flow looks things up as: (its role today) ∩ (the permissions capped at publish). */
export async function botPrincipal(p: Platform, tx: Tx, tenantId: string, flowId: string, number: number): Promise<Principal> {
  const v = await tx.selectFrom('bot_flow_version').select(['service_role', 'service_permissions']).where('flow_id', '=', flowId).where('number', '=', number).executeTakeFirst();
  const role = v?.service_role ? await resolveRole(tx, p.catalog, v.service_role) : null;
  if (!v || !role) return { type: 'Workflow', id: `bot:${flowId}`, tenantId, roles: [] };
  const capped = new Set(v.service_permissions as string[]);
  const published = role.preset === 'Owner' ? [] : await publishedFieldRules(tx, v.service_role!);
  const own = role.fieldRules.filter((r) => !published.some((x) => x.resource === r.resource && x.field === r.field));
  // never a preset: an Owner preset would bypass the permission list
  return { type: 'Workflow', id: `bot:${flowId}`, tenantId, roles: [{ name: `bot:${role.name}`, preset: null, permissions: role.permissions.filter((x) => capped.has(x)), fieldRules: [...own, ...published] }] };
}
