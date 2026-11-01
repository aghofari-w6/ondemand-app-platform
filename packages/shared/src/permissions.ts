import { z } from 'zod';

/**
 * Permission catalog and authorization.
 *
 * `authorize(principal, action, resource)` mirrors Cedar's request shape
 * (principal / action / resource entity UIDs + context), so the role presets and
 * custom roles below can later be compiled into Cedar policies without touching
 * call sites.
 */

export const PermissionLevel = z.enum(['read', 'operate', 'manage', 'admin']);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export interface PermissionDef {
  /** `<app>:<entity>.<verb>`, e.g. `ordering:order.update` or `platform:users.manage` */
  id: string;
  label: string;
  level: PermissionLevel;
  /** Only an Owner can hold it, regardless of custom roles. */
  ownerOnly?: boolean;
}

export const PLATFORM_PERMISSIONS: PermissionDef[] = [
  { id: 'platform:tenant.read', label: 'See workspace overview', level: 'read' },
  { id: 'platform:catalog.read', label: 'Browse the app catalog', level: 'read' },
  { id: 'platform:apps.provision', label: 'Provision, upgrade and remove apps', level: 'admin' },
  { id: 'platform:users.read', label: 'See users and roles', level: 'read' },
  { id: 'platform:users.manage', label: 'Invite users and change roles', level: 'admin' },
  { id: 'platform:roles.manage', label: 'Create and edit custom roles', level: 'admin' },
  { id: 'platform:settings.manage', label: 'Change workspace settings and sign-in', level: 'admin' },
  { id: 'platform:audit.read', label: 'Read the audit log', level: 'manage' },
  { id: 'platform:billing.manage', label: 'Change plan and billing', level: 'admin', ownerOnly: true },
  { id: 'platform:tenant.delete', label: 'Delete the workspace', level: 'admin', ownerOnly: true },
  { id: 'platform:fields.manage', label: 'Manage custom fields', level: 'admin' },
  { id: 'platform:datastudio.manage', label: 'Edit and publish the data model (Data studio)', level: 'admin' },
  { id: 'platform:records.read', label: 'See custom entity records', level: 'read' },
  { id: 'platform:records.write', label: 'Create and edit custom entity records', level: 'operate' },
  { id: 'platform:hub.read', label: 'See Integration Hub endpoints and deliveries', level: 'manage' },
  { id: 'platform:hub.manage', label: 'Configure the Integration Hub and replay deliveries', level: 'admin' },
  { id: 'platform:apikeys.manage', label: 'Manage API keys and OAuth clients', level: 'admin' },
];

export const ROLE_PRESETS = ['Owner', 'Admin', 'Manager', 'Staff', 'Viewer'] as const;
export type RolePreset = (typeof ROLE_PRESETS)[number];

const PRESET_LEVELS: Record<RolePreset, PermissionLevel[]> = {
  Owner: ['read', 'operate', 'manage', 'admin'],
  Admin: ['read', 'operate', 'manage', 'admin'],
  Manager: ['read', 'operate', 'manage'],
  Staff: ['read', 'operate'],
  Viewer: ['read'],
};

export function presetPermissions(preset: RolePreset, catalog: PermissionDef[]): string[] {
  const levels = PRESET_LEVELS[preset];
  return catalog
    .filter((p) => levels.includes(p.level) && (!p.ownerOnly || preset === 'Owner'))
    .map((p) => p.id);
}

export const FieldAccess = z.enum(['hidden', 'read', 'write']);
export type FieldAccess = z.infer<typeof FieldAccess>;

export const FieldRule = z.object({
  /** resource type, e.g. `ordering::Order` */
  resource: z.string().min(1),
  field: z.string().min(1),
  access: FieldAccess,
});
export type FieldRule = z.infer<typeof FieldRule>;

export interface ResolvedRole {
  name: string;
  preset: RolePreset | null;
  permissions: string[];
  fieldRules: FieldRule[];
}

export interface EntityUid {
  type: string;
  id: string;
}

export interface Principal extends EntityUid {
  type: 'User' | 'ApiClient' | 'System';
  tenantId: string;
  roles: ResolvedRole[];
}

export interface Action extends EntityUid {
  type: 'Action';
  /** permission id */
  id: string;
}

export interface Resource extends EntityUid {
  tenantId: string;
  attrs?: Record<string, unknown>;
}

export interface Decision {
  decision: 'allow' | 'deny';
  /** ids of the roles/policies that determined the decision (Cedar "reasons") */
  reasons: string[];
  errors: string[];
  /** per-field access for this resource type; fields not listed are `write` */
  fields: Record<string, FieldAccess>;
}

export const action = (id: string): Action => ({ type: 'Action', id });

const ACCESS_RANK: Record<FieldAccess, number> = { hidden: 0, read: 1, write: 2 };

/** Single authorization entry point. Pure; deny by default. */
export function authorize(principal: Principal, act: Action, resource: Resource, _context: Record<string, unknown> = {}): Decision {
  const fields: Record<string, FieldAccess> = {};
  if (principal.type === 'System') {
    return { decision: 'allow', reasons: ['system'], errors: [], fields };
  }
  if (principal.tenantId !== resource.tenantId) {
    return { decision: 'deny', reasons: [], errors: ['cross-tenant request'], fields };
  }
  const granting = principal.roles.filter((r) => r.preset === 'Owner' || r.permissions.includes(act.id));
  if (granting.length === 0) return { decision: 'deny', reasons: [], errors: [], fields };

  // Field rules: the most permissive rule across granting roles wins; a granting
  // role without a rule for a field gives full access to it.
  const ruled = new Map<string, FieldAccess[]>();
  for (const role of granting) {
    for (const r of role.fieldRules.filter((f) => f.resource === resource.type)) {
      ruled.set(r.field, [...(ruled.get(r.field) ?? []), r.access]);
    }
  }
  for (const [field, accesses] of ruled) {
    const unruledGrant = granting.some((role) => !role.fieldRules.some((f) => f.resource === resource.type && f.field === field));
    if (unruledGrant) continue;
    fields[field] = accesses.reduce((a, b) => (ACCESS_RANK[b] > ACCESS_RANK[a] ? b : a));
  }
  return { decision: 'allow', reasons: granting.map((r) => r.name), errors: [], fields };
}

/** Removes hidden fields from a record according to a decision. */
export function maskFields<T extends Record<string, unknown>>(record: T, decision: Decision): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (decision.fields[k] === 'hidden') continue;
    if (k === 'custom' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v).filter(([ck]) => decision.fields[`custom.${ck}`] !== 'hidden'));
      continue;
    }
    out[k] = v;
  }
  return out as Partial<T>;
}

/** Fields a principal may not write; used by update commands. */
export function readonlyFields(decision: Decision): string[] {
  return Object.entries(decision.fields)
    .filter(([, a]) => a !== 'write')
    .map(([f]) => f);
}
