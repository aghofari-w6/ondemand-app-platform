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

export async function principalFor(tx: Tx, catalog: Catalog, tenantId: string, user: { id: string; role: string }): Promise<Principal> {
  const role = await resolveRole(tx, catalog, user.role);
  return { type: 'User', id: user.id, tenantId, roles: role ? [role] : [] };
}

export const systemPrincipal = (tenantId: string, id = 'platform'): Principal => ({ type: 'System', id, tenantId, roles: [] });
