import type { Principal } from '@aod/shared';
import { describe, expect, it } from 'vitest';
import { HIDDEN, hiddenKeysFor, redact } from './redact.ts';

const role = (name: string, fieldRules: { resource: string; field: string; access: 'hidden' | 'read' | 'write' }[], preset: string | null = null) => ({ name, preset, permissions: [], fieldRules }) as Principal['roles'][number];
const user = (...roles: Principal['roles']): Principal => ({ type: 'User', id: 'u', tenantId: 't', roles });

describe('run data redaction', () => {
  it('masks keys hidden for the viewer anywhere in run data', () => {
    const p = user(role('Manager', [{ resource: 'custom::employee', field: 'salary', access: 'hidden' }, { resource: 'custom::employee', field: 'name', access: 'read' }]));
    const keys = hiddenKeysFor(p);
    expect([...keys]).toEqual(['salary']);
    const data = { trigger: { data: { values: { name: 'Ana', salary: 9 } } }, steps: [{ output: { salary: 1, nested: { salary: 2 } } }] };
    expect(redact(data, keys)).toEqual({ trigger: { data: { values: { name: 'Ana', salary: HIDDEN } } }, steps: [{ output: { salary: HIDDEN, nested: { salary: HIDDEN } } }] });
  });

  it('hides nothing for Owners, or when another role shows the field', () => {
    expect(hiddenKeysFor(user(role('Owner', [{ resource: 'r', field: 'salary', access: 'hidden' }], 'Owner'))).size).toBe(0);
    expect(hiddenKeysFor(user(role('A', [{ resource: 'r', field: 'salary', access: 'hidden' }]), role('B', []))).size).toBe(0);
  });
});
