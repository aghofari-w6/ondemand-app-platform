import type { Principal } from '@aod/shared';

/**
 * Run data (trigger events, node inputs and outputs, variables) has no fixed shape, so
 * field rules are applied by name: any key that is hidden for the viewer on some
 * resource is masked wherever it appears. This errs on the side of hiding (a same-named
 * field elsewhere is masked too). PII never reaches run data (it is not in events).
 */
export function hiddenKeysFor(principal: Principal): Set<string> {
  if (principal.type === 'System' || principal.roles.some((r) => r.preset === 'Owner')) return new Set();
  const keys = new Set<string>();
  for (const role of principal.roles) for (const r of role.fieldRules) if (r.access === 'hidden') keys.add(r.field);
  // A field another role grants without a hidden rule stays visible.
  for (const k of [...keys]) {
    if (principal.roles.some((role) => !role.fieldRules.some((r) => r.field === k && r.access === 'hidden'))) keys.delete(k);
  }
  return keys;
}

export const HIDDEN = '[hidden]';

export function redact<T>(value: T, keys: Set<string>): T {
  if (!keys.size || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, keys)) as T;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, keys.has(k) ? HIDDEN : redact(v, keys)])) as T;
}
