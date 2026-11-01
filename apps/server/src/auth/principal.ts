import { presetPermissions, ROLE_PRESETS, type FieldRule, type Principal, type ResolvedRole, type RolePreset } from '@aod/shared';
import type { Tx } from '../db/database.ts';
import type { Catalog } from '../platform/catalog.ts';

export const isPreset = (r: string): r is RolePreset => (ROLE_PRESETS as readonly string[]).includes(r);

export async function resolveRole(tx: Tx, catalog: Catalog, role: string): Promise<ResolvedRole | null> {
  if (isPreset(role)) return { name: role, preset: role, permissions: presetPermissions(role, catalog.permissions), fieldRules: [] };
  const r = await tx.selectFrom('custom_role').select(['name', 'permissions', 'field_rules']).where('id', '=', role).executeTakeFirst();
  if (!r) return null;
  const known = new Set(catalog.permissions.filter((p) => !p.ownerOnly).map((p) => p.id));
  return {
    name: r.name,
    preset: null,
    permissions: (r.permissions as string[]).filter((p) => known.has(p)),
    fieldRules: r.field_rules as FieldRule[],
  };
}

/** Field access rules published from Data studio for a role (preset name or custom role id). */
export async function publishedFieldRules(tx: Tx, role: string): Promise<FieldRule[]> {
  const rows = await tx.selectFrom('field_access_rule').select(['resource', 'field', 'access']).where('role', '=', role).execute();
  return rows as FieldRule[];
}

export async function principalFor(tx: Tx, catalog: Catalog, tenantId: string, user: { id: string; role: string }): Promise<Principal> {
  const role = await resolveRole(tx, catalog, user.role);
  if (!role) return { type: 'User', id: user.id, tenantId, roles: [] };
  // Owners keep full access; for everyone else Data studio rules refine the role's own.
  const published = role.preset === 'Owner' ? [] : await publishedFieldRules(tx, user.role);
  const own = role.fieldRules.filter((r) => !published.some((x) => x.resource === r.resource && x.field === r.field));
  return { type: 'User', id: user.id, tenantId, roles: [{ ...role, fieldRules: [...own, ...published] }] };
}

export const systemPrincipal = (tenantId: string, id = 'platform'): Principal => ({ type: 'System', id, tenantId, roles: [] });
