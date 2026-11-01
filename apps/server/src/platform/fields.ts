import { z } from 'zod';
import { CommandError } from '@aod/shared';
import type { Tx } from '../db/database.ts';

export interface FieldDefinition {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'select';
  options: string[];
  required: boolean;
}

export async function fieldDefinitions(tx: Tx, app: string, entity: string): Promise<FieldDefinition[]> {
  return tx.selectFrom('field_definition').select(['key', 'label', 'type', 'options', 'required']).where('app', '=', app).where('entity', '=', entity).orderBy('created_at').execute() as Promise<FieldDefinition[]>;
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
  }
}

/**
 * Validates custom field values (stored in the entity's `custom` JSONB column)
 * against the tenant's field definitions. Unknown keys are rejected; `null` clears
 * a value. Required fields must be present after merging with existing values.
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
    if (v === null) {
      delete merged[k];
      continue;
    }
    const r = schemaFor(def).safeParse(v);
    if (!r.success) problems.push(`${k}: ${r.error.issues[0]?.message ?? 'invalid'}`);
    else merged[k] = r.data;
  }
  for (const d of defs) if (d.required && (merged[d.key] === undefined || merged[d.key] === '')) problems.push(`${d.key}: required`);
  if (problems.length) throw new CommandError(422, 'invalid_custom_fields', problems.join('; '));
  return merged;
}
