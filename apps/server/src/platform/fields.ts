import { z } from 'zod';
import { CommandError } from '@aod/shared';
import type { Tx } from '../db/database.ts';
import type { Vault } from '../ports/index.ts';

/**
 * Custom field values (JSONB on app entities, `data` on custom records): validation
 * against the published field definitions, and AES-256-GCM encryption of PII fields.
 */

export interface FieldDefinition {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'select' | 'link';
  options: string[];
  required: boolean;
  pii?: boolean;
  formula?: string | undefined;
}

export async function fieldDefinitions(tx: Tx, app: string, entity: string): Promise<FieldDefinition[]> {
  return tx
    .selectFrom('field_definition')
    .select(['key', 'label', 'type', 'options', 'required', 'pii'])
    .where('app', '=', app)
    .where('entity', '=', entity)
    .orderBy('created_at')
    .execute() as Promise<FieldDefinition[]>;
}

function schemaFor(def: FieldDefinition): z.ZodType {
  switch (def.type) {
    case 'text':
      return z.string().max(2000);
    case 'number':
      return z.number().finite();
    case 'boolean':
      return z.boolean();
    case 'date':
      return z.iso.date();
    case 'select':
      return z.enum(def.options as [string, ...string[]]);
    case 'link':
      return z.uuid();
  }
}

/**
 * Validates values against definitions. Unknown keys and formula (computed) fields are
 * rejected; `null` clears a value. Required fields must be present after merging with
 * existing values.
 */
export function validateCustomValues(defs: FieldDefinition[], values: Record<string, unknown> = {}, existing: Record<string, unknown> = {}): Record<string, unknown> {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const problems: string[] = [];
  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(values)) {
    const def = byKey.get(k);
    if (!def) {
      problems.push(`${k}: unknown field`);
      continue;
    }
    if (def.formula) {
      problems.push(`${k}: computed field, read-only`);
      continue;
    }
    if (v === null) {
      delete merged[k];
      continue;
    }
    const r = schemaFor(def).safeParse(v);
    if (!r.success) problems.push(`${k}: ${r.error.issues[0]?.message ?? 'invalid'}`);
    else merged[k] = r.data;
  }
  for (const d of defs) if (d.required && !d.formula && (merged[d.key] === undefined || merged[d.key] === '')) problems.push(`${d.key}: required`);
  if (problems.length) throw new CommandError(422, 'invalid_custom_fields', problems.join('; '));
  return merged;
}

// ------------------------------------------------------------------ PII encryption

export const ENC_PREFIX = 'enc:';
export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && v.startsWith(ENC_PREFIX);

/** AAD binds a ciphertext to its tenant, record type and field: it cannot be moved elsewhere. */
const aad = (tenantId: string, target: string, key: string) => `pii|${tenantId}|${target}|${key}`;

export function encryptValue(vault: Vault, tenantId: string, target: string, key: string, value: unknown): string {
  return ENC_PREFIX + vault.encrypt(JSON.stringify(value), aad(tenantId, target, key));
}

export function decryptValue(vault: Vault, tenantId: string, target: string, key: string, value: unknown): unknown {
  if (!isEncrypted(value)) return value;
  try {
    return JSON.parse(vault.decrypt(value.slice(ENC_PREFIX.length), aad(tenantId, target, key)));
  } catch {
    return null; // key rotated or tampered: never leak ciphertext
  }
}

/** Encrypts every PII value that is not encrypted yet. */
export function encryptPii(vault: Vault, tenantId: string, target: string, defs: FieldDefinition[], values: Record<string, unknown>): Record<string, unknown> {
  const out = { ...values };
  for (const d of defs) {
    if (d.pii && out[d.key] !== undefined && out[d.key] !== null && !isEncrypted(out[d.key])) out[d.key] = encryptValue(vault, tenantId, target, d.key, out[d.key]);
  }
  return out;
}

/**
 * Decrypts the values of currently defined fields only. Values of fields that were
 * removed from the data model stay exactly as stored (still encrypted if they were PII),
 * so an edit never writes them back in clear text.
 */
export function decryptDefined(vault: Vault, tenantId: string, target: string, defs: { key: string }[], values: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const keys = new Set(defs.map((d) => d.key));
  const out: Record<string, unknown> = { ...(values ?? {}) };
  for (const [k, v] of Object.entries(out)) if (keys.has(k) && isEncrypted(v)) out[k] = decryptValue(vault, tenantId, target, k, v);
  return out;
}

/** Only the values of currently defined fields (removed fields are kept in storage but hidden). */
export const definedOnly = (defs: { key: string }[], values: Record<string, unknown>) => {
  const keys = new Set(defs.map((d) => d.key));
  return Object.fromEntries(Object.entries(values).filter(([k]) => keys.has(k)));
};

/** Decrypts every encrypted value (a field that stopped being PII may still hold ciphertext until its backfill runs). */
export function decryptAll(vault: Vault, tenantId: string, target: string, values: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(values ?? {}) };
  for (const [k, v] of Object.entries(out)) if (isEncrypted(v)) out[k] = decryptValue(vault, tenantId, target, k, v);
  return out;
}
