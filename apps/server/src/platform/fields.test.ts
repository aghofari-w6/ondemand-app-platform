import { describe, expect, it } from 'vitest';
import { createVault } from '../adapters/index.ts';
import { validateCustomValues, type FieldDefinition } from './fields.ts';

const defs: FieldDefinition[] = [
  { key: 'table', label: 'Table', type: 'number', options: [], required: true },
  { key: 'slot', label: 'Slot', type: 'select', options: ['am', 'pm'], required: false },
  { key: 'gift', label: 'Gift', type: 'boolean', options: [], required: false },
];

describe('custom field validation', () => {
  it('validates types, options, unknown keys and required fields', () => {
    expect(validateCustomValues(defs, { table: 4, slot: 'pm', gift: true })).toEqual({ table: 4, slot: 'pm', gift: true });
    expect(() => validateCustomValues(defs, { table: 'four' })).toThrow(/table/);
    expect(() => validateCustomValues(defs, { table: 1, slot: 'noon' })).toThrow(/slot/);
    expect(() => validateCustomValues(defs, { table: 1, nope: 1 })).toThrow(/unknown field/);
    expect(() => validateCustomValues(defs, { slot: 'am' })).toThrow(/table: required/);
  });
  it('merges with existing values and clears with null', () => {
    expect(validateCustomValues(defs, { slot: null }, { table: 2, slot: 'am' })).toEqual({ table: 2 });
  });
});

describe('vault (AES-256-GCM)', () => {
  const v = createVault(Buffer.alloc(32, 7).toString('base64'), () => {});
  it('round-trips and binds ciphertext to its owner', () => {
    const c = v.encrypt('s3cret', 'sso:t1');
    expect(c).not.toContain('s3cret');
    expect(v.decrypt(c, 'sso:t1')).toBe('s3cret');
    expect(() => v.decrypt(c, 'sso:t2')).toThrow();
  });
});
