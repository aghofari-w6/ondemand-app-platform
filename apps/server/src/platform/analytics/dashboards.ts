import { CommandError, DashboardInput, type MetricSpec, type Principal, type Widget } from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../../db/database.ts';
import type { Platform } from '../context.ts';
import { recordChange } from '../record.ts';
import { assertCanView, visibleMetrics } from './query.ts';

/**
 * Dashboards: saved widget layouts shared per role, plus built-in defaults (an Overview
 * across active apps and one per app) generated from the metrics the viewer may see.
 */

const RESOURCE = 'platform::Dashboard';
const isAdmin = (principal: Principal) => principal.roles.some((r) => r.preset === 'Owner' || r.preset === 'Admin');
const roleIds = (principal: Principal, userRole: string | null) => new Set([userRole, ...principal.roles.map((r) => r.preset ?? r.name)].filter(Boolean) as string[]);

function defaultWidgets(specs: MetricSpec[]): Widget[] {
  const w: Widget[] = [];
  for (const s of specs) w.push({ id: `kpi-${s.id.replace(/[^a-z0-9]/g, '-')}`.slice(0, 40), kind: 'kpi', title: s.label, metric: s.id });
  const money = specs.filter((s) => s.unit === 'money');
  for (const s of money) w.push({ id: `ts-${s.id.replace(/[^a-z0-9]/g, '-')}`.slice(0, 40), kind: 'timeseries', title: `${s.label} over time`, metric: s.id });
  for (const s of specs.filter((x) => x.dims.store)) w.push({ id: `bar-${s.id.replace(/[^a-z0-9]/g, '-')}`.slice(0, 40), kind: 'bar', title: `${s.label} per store`, metric: s.id, group_by: 'store' });
  const top = money.find((s) => s.dims.store);
  if (top) w.push({ id: 'top-stores', kind: 'table', title: `Top stores by ${top.label.toLowerCase()}`, metric: top.id, group_by: 'store', limit: 10 });
  return w;
}

export async function builtinDashboards(p: Platform, tx: Tx, principal: Principal) {
  const specs = await visibleMetrics(p, tx, principal);
  if (!specs.length) return [];
  const apps = [...new Set(specs.map((s) => s.app))];
  const out: { id: string; name: string; widgets: Widget[]; shared_roles: string[]; builtin: boolean; version: number }[] = [{ id: 'default:overview', name: 'Overview', widgets: defaultWidgets(specs), shared_roles: [], builtin: true, version: 1 }];
  if (apps.length > 1) {
    for (const app of apps) {
      const label = app === 'custom' ? 'Custom data' : app.charAt(0).toUpperCase() + app.slice(1);
      out.push({ id: `default:${app}`, name: label, widgets: defaultWidgets(specs.filter((s) => s.app === app)), shared_roles: [], builtin: true, version: 1 });
    }
  }
  return out;
}

export async function listDashboards(p: Platform, tx: Tx, principal: Principal, userRole: string | null) {
  const builtin = await builtinDashboards(p, tx, principal);
  const mine = roleIds(principal, userRole);
  const rows = await tx.selectFrom('dashboard').selectAll().orderBy('name').limit(200).execute();
  const saved = rows.filter((d) => isAdmin(principal) || d.owner_id === principal.id || (d.shared_roles as string[]).some((r) => mine.has(r)));
  return [...builtin, ...saved.map((d) => ({ id: d.id as string, name: d.name as string, widgets: d.widgets as Widget[], shared_roles: d.shared_roles as string[], owner_id: d.owner_id as string, builtin: false, version: d.version as number }))];
}

export async function getDashboard(p: Platform, tx: Tx, principal: Principal, userRole: string | null, id: string) {
  const all = await listDashboards(p, tx, principal, userRole);
  const d = all.find((x) => x.id === id);
  if (!d) throw new CommandError(404, 'not_found', 'dashboard not found');
  return d;
}

async function checkWidgets(p: Platform, tx: Tx, principal: Principal, widgets: Widget[]) {
  const specs = await visibleMetrics(p, tx, principal);
  for (const w of widgets) {
    const s = specs.find((x) => x.id === w.metric);
    if (!s) throw new CommandError(422, 'unknown_metric', `widget ${w.title}: unknown or hidden metric ${w.metric}`);
    if ((w.kind === 'bar' || w.kind === 'table') && !w.group_by) throw new CommandError(422, 'invalid_widget', `widget ${w.title}: choose a dimension`);
    if (w.group_by && !s.dims[w.group_by]) throw new CommandError(422, 'invalid_widget', `widget ${w.title}: ${s.label} has no ${w.group_by} dimension`);
    assertCanView(s, principal, w.group_by ?? null);
  }
  if (new Set(widgets.map((w) => w.id)).size !== widgets.length) throw new CommandError(422, 'invalid_widget', 'widget ids must be unique');
}

export async function saveDashboard(p: Platform, tx: Tx, tenantId: string, principal: Principal, raw: unknown, correlationId: string, existing?: { id: string; version: number }) {
  const parsed = DashboardInput.safeParse(raw);
  if (!parsed.success) throw new CommandError(422, 'invalid_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const input = parsed.data;
  await checkWidgets(p, tx, principal, input.widgets);
  const id = existing?.id ?? newId();
  if (existing) {
    const cur = await tx.selectFrom('dashboard').select(['owner_id']).where('id', '=', id).executeTakeFirst();
    if (!cur) throw new CommandError(404, 'not_found', 'dashboard not found');
    if (cur.owner_id !== principal.id && !isAdmin(principal)) throw new CommandError(403, 'forbidden', 'only the owner or an Admin can change this dashboard');
    const r = await tx
      .updateTable('dashboard')
      .set({ name: input.name, widgets: JSON.stringify(input.widgets), shared_roles: input.shared_roles, updated_at: new Date(), version: sql`version + 1` })
      .where('id', '=', id)
      .where('version', '=', existing.version)
      .returning('version')
      .executeTakeFirst();
    if (!r) throw new CommandError(409, 'version_conflict', 'the dashboard changed');
  } else {
    await tx
      .insertInto('dashboard')
      .values({ id, tenant_id: tenantId, name: input.name, widgets: JSON.stringify(input.widgets), shared_roles: input.shared_roles, owner_id: principal.id })
      .execute()
      .catch((e) => {
        if (e?.code === '23505') throw new CommandError(409, 'name_taken', `a dashboard named ${input.name} exists`);
        throw e;
      });
  }
  await recordChange(p, tx, { tenantId, actor: principal, action: existing ? 'platform:dashboard.updated' : 'platform:dashboard.created', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: existing ? 'dashboard.updated' : 'dashboard.created', data: { dashboard_id: id, widgets: input.widgets.length, shared_roles: input.shared_roles } }] });
  return { id };
}

export async function deleteDashboard(p: Platform, tx: Tx, tenantId: string, principal: Principal, id: string, correlationId: string) {
  const cur = await tx.selectFrom('dashboard').select(['owner_id']).where('id', '=', id).executeTakeFirst();
  if (!cur) throw new CommandError(404, 'not_found', 'dashboard not found');
  if (cur.owner_id !== principal.id && !isAdmin(principal)) throw new CommandError(403, 'forbidden', 'only the owner or an Admin can delete this dashboard');
  await tx.deleteFrom('dashboard').where('id', '=', id).execute();
  await recordChange(p, tx, { tenantId, actor: principal, action: 'platform:dashboard.deleted', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: 'dashboard.deleted', data: { dashboard_id: id } }] });
}
