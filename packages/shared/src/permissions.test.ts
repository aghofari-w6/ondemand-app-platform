import { describe, expect, it } from 'vitest';
import { action, authorize, maskFields, PLATFORM_PERMISSIONS, presetPermissions, type Principal, type ResolvedRole } from './permissions.ts';

const T = '00000000-0000-4000-8000-000000000001';
const catalog = [
  ...PLATFORM_PERMISSIONS,
  { id: 'ordering:order.read', label: 'Read orders', level: 'read' as const },
  { id: 'ordering:order.update', label: 'Update orders', level: 'operate' as const },
];
const role = (preset: ResolvedRole['preset'], extra: Partial<ResolvedRole> = {}): ResolvedRole => ({
  name: preset ?? 'custom',
  preset,
  permissions: preset ? presetPermissions(preset, catalog) : [],
  fieldRules: [],
  ...extra,
});
const user = (...roles: ResolvedRole[]): Principal => ({ type: 'User', id: 'u1', tenantId: T, roles });
const order = { type: 'ordering::Order', id: 'o1', tenantId: T };

describe('authorize', () => {
  it('maps presets to permission levels', () => {
    expect(presetPermissions('Viewer', catalog)).toContain('ordering:order.read');
    expect(presetPermissions('Viewer', catalog)).not.toContain('ordering:order.update');
    expect(presetPermissions('Staff', catalog)).toContain('ordering:order.update');
    expect(presetPermissions('Admin', catalog)).toContain('platform:users.manage');
    expect(presetPermissions('Admin', catalog)).not.toContain('platform:tenant.delete');
    expect(presetPermissions('Owner', catalog)).toContain('platform:tenant.delete');
  });

  it('denies by default and allows granted actions', () => {
    expect(authorize(user(), action('ordering:order.read'), order).decision).toBe('deny');
    expect(authorize(user(role('Viewer')), action('ordering:order.read'), order).decision).toBe('allow');
    expect(authorize(user(role('Viewer')), action('ordering:order.update'), order).decision).toBe('deny');
  });

  it('denies cross-tenant resources even for Owners', () => {
    const d = authorize(user(role('Owner')), action('ordering:order.read'), { ...order, tenantId: 'other' });
    expect(d.decision).toBe('deny');
    expect(d.errors).toContain('cross-tenant request');
  });

  it('honours custom roles and field rules', () => {
    const cashier = role(null, {
      name: 'Cashier',
      permissions: ['ordering:order.read'],
      fieldRules: [{ resource: 'ordering::Order', field: 'total', access: 'hidden' }],
    });
    const d = authorize(user(cashier), action('ordering:order.read'), order);
    expect(d.decision).toBe('allow');
    expect(d.fields.total).toBe('hidden');
    expect(maskFields({ id: 'o1', total: 5 }, d)).toEqual({ id: 'o1' });

    // a second granting role without a rule lifts the restriction
    const both = authorize(user(cashier, role('Viewer')), action('ordering:order.read'), order);
    expect(both.fields.total).toBeUndefined();
  });

  it('allows system principals', () => {
    expect(authorize({ type: 'System', id: 'saga', tenantId: T, roles: [] }, action('x:y.z'), order).decision).toBe('allow');
  });
});
