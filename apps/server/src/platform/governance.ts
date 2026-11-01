import { action, authorize, CommandError, customResource, ROLE_PRESETS, type Principal } from '@aod/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { scopePermissions } from '../auth/apiauth.ts';
import { publishedFieldRules, resolveRole, systemPrincipal } from '../auth/principal.ts';
import { newId, type Tx } from '../db/database.ts';
import { activeApps } from './commands.ts';
import type { Platform } from './context.ts';
import { publishedDefinition } from './datastudio.ts';
import { decryptAll, decryptValue, isEncrypted } from './fields.ts';
import { recordChange } from './record.ts';
import { executeRecordWrite, recordTarget } from './records.ts';
import { readPermission } from './workspace.ts';

/**
 * Data governance: PII inventory, access review, retention policies, data subject
 * requests (export / erase) and the audit-log export.
 *
 * Writes to app tables here (anonymising PII columns) are platform maintenance writes,
 * like Data studio backfills: they bypass app commands because no app has an
 * "anonymise" command, they touch only PII columns (never amounts, statuses or ids, so
 * accounting stays intact), and each run is recorded with `recordChange` (outbox + audit)
 * without any PII in the event or audit data. Custom records go through
 * `executeRecordWrite` as usual.
 */

const RESOURCE = 'platform::Governance';

function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new CommandError(422, 'invalid_input', r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  return r.data;
}
const ANON = '[anonymised]';
const ERASED = '[erased]';
/** Bounded work per run (memory-safe-code §7). */
const BATCH = 500;
const MAX_PER_RUN = 20_000;
const MAX_SCAN = 50_000;
const MAX_FOUND = 500;

// ------------------------------------------------------------------ inventory

export interface PiiField {
  /** `<app>:<entity>` or `custom:<entity>` */
  target: string;
  /** resource type for authorize() */
  resource: string;
  table: string;
  /** field key as field rules name it: built-in key, `custom.<key>` on app entities, or the custom entity's key */
  field: string;
  label: string;
  source: 'manifest' | 'data studio';
  /** where the value lives */
  storage: 'column' | 'custom' | 'record';
  encrypted: boolean;
  readPermission: string;
}

export async function piiInventory(p: Platform, tx: Tx): Promise<PiiField[]> {
  const out: PiiField[] = [];
  const active = new Set(await activeApps(tx));
  const { definition } = await publishedDefinition(tx);
  for (const m of p.catalog.manifests()) {
    if (!active.has(m.id)) continue;
    for (const e of m.entities) {
      const base = { target: `${m.id}:${e.name}`, resource: e.resource, table: e.table, readPermission: readPermission(m.id, e) };
      for (const f of e.fields.filter((x) => x.pii)) out.push({ ...base, field: f.key, label: `${e.label}: ${f.label}`, source: 'manifest', storage: 'column', encrypted: false });
      for (const f of definition.app_fields.find((s) => s.app === m.id && s.entity === e.name)?.fields.filter((x) => x.pii) ?? []) {
        out.push({ ...base, field: `custom.${f.key}`, label: `${e.label}: ${f.label}`, source: 'data studio', storage: 'custom', encrypted: true });
      }
    }
  }
  for (const e of definition.entities) {
    for (const f of e.fields.filter((x) => x.pii)) {
      out.push({ target: recordTarget(e.key), resource: customResource(e.key), table: 'custom_record', field: f.key, label: `${e.label}: ${f.label}`, source: 'data studio', storage: 'record', encrypted: true, readPermission: 'platform:records.read' });
    }
  }
  return out;
}

// ------------------------------------------------------------------ access review

export async function accessReview(p: Platform, tx: Tx) {
  const fields = await piiInventory(p, tx);
  const custom = await tx.selectFrom('custom_role').select(['id', 'name']).execute();
  const roles: { id: string; name: string; principal: Principal }[] = [];
  for (const r of [...ROLE_PRESETS.map((x) => ({ id: x as string, name: x as string })), ...custom.map((c) => ({ id: c.id as string, name: c.name as string }))]) {
    const resolved = await resolveRole(tx, p.catalog, r.id);
    if (!resolved) continue;
    const published = resolved.preset === 'Owner' ? [] : await publishedFieldRules(tx, r.id);
    const own = resolved.fieldRules.filter((x) => !published.some((y) => y.resource === x.resource && y.field === x.field));
    roles.push({ ...r, principal: { type: 'User', id: `review:${r.id}`, tenantId: '', roles: [{ ...resolved, fieldRules: [...own, ...published] }] } });
  }
  const keys = await tx.selectFrom('api_key').select(['id', 'name', 'scopes']).where('revoked_at', 'is', null).execute();
  const clients = await tx.selectFrom('oauth_client').select(['id', 'name', 'scopes']).where('revoked_at', 'is', null).execute();
  const creds = [...keys.map((k) => ({ kind: 'api key', id: k.id as string, name: k.name as string, scopes: k.scopes as string[] })), ...clients.map((c) => ({ kind: 'oauth client', id: c.id as string, name: c.name as string, scopes: c.scopes as string[] }))];
  return fields.map((f) => ({
    ...f,
    roles: roles.flatMap((r) => {
      const d = authorize({ ...r.principal, tenantId: 't' }, action(f.readPermission), { type: f.resource, id: '*', tenantId: 't' });
      if (d.decision === 'deny') return [];
      const access = d.fields[f.field] ?? 'write';
      return access === 'hidden' ? [] : [{ role: r.id, name: r.name, access }];
    }),
    // Machine credentials carry scopes, not roles: they see every field their scopes allow.
    credentials: creds.filter((c) => scopePermissions(p.catalog, c.scopes).includes(f.readPermission)).map(({ kind, id, name }) => ({ kind, id, name })),
    delegated_tokens: 'limited to the issuing user’s role (see roles)',
  }));
}

// ------------------------------------------------------------------ retention

export const RetentionInput = z.object({
  target: z.string().regex(/^(custom|[a-z][a-z0-9_]*):[a-z][a-z0-9_]*$/),
  action: z.enum(['anonymise', 'purge']),
  after_days: z.int().min(1).max(3650),
  enabled: z.boolean().default(true),
});

export async function saveRetentionPolicy(p: Platform, tx: Tx, tenantId: string, actor: Principal, raw: unknown, correlationId: string) {
  const parsed = RetentionInput.safeParse(raw);
  if (!parsed.success) throw new CommandError(422, 'invalid_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const input = parsed.data;
  const inv = (await piiInventory(p, tx)).filter((f) => f.target === input.target);
  const isCustom = input.target.startsWith('custom:');
  if (input.action === 'anonymise' && !inv.length) throw new CommandError(422, 'no_pii', `${input.target} has no PII fields to anonymise`);
  if (input.action === 'purge' && !isCustom) throw new CommandError(422, 'purge_not_allowed', 'app records keep their accounting history: use anonymise for app entities');
  if (isCustom) {
    const { definition } = await publishedDefinition(tx);
    if (!definition.entities.some((e) => `custom:${e.key}` === input.target)) throw new CommandError(404, 'unknown_entity', `unknown entity ${input.target}`);
  }
  const id = newId();
  const row = await tx
    .insertInto('retention_policy')
    .values({ id, tenant_id: tenantId, target: input.target, action: input.action, after_days: input.after_days, enabled: input.enabled, created_by: actor.id })
    .onConflict((oc) => oc.columns(['tenant_id', 'target']).doUpdateSet({ action: input.action, after_days: input.after_days, enabled: input.enabled, version: sql`retention_policy.version + 1` }))
    .returning('id')
    .executeTakeFirstOrThrow();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:retention.saved', resourceType: RESOURCE, resourceId: row.id, correlationId, events: [{ type: 'retention.policy_saved', data: { policy_id: row.id, target: input.target, action: input.action, after_days: input.after_days, enabled: input.enabled } }] });
  return { id: row.id };
}

/** Anonymises the PII columns of the given app rows (in the caller's transaction). */
async function anonymiseAppRows(tx: Tx, fields: PiiField[], ids: string[], marker: string) {
  if (!ids.length || !fields.length) return 0;
  const table = fields[0]!.table;
  const cols = fields.filter((f) => f.storage === 'column').map((f) => f.field);
  const customKeys = fields.filter((f) => f.storage === 'custom').map((f) => f.field.slice('custom.'.length));
  const set: Record<string, unknown> = { version: sql`version + 1` };
  for (const c of cols) set[c] = sql`CASE WHEN ${sql.ref(c)} IS NULL THEN NULL ELSE ${marker} END`;
  if (customKeys.length) set.custom = sql`custom - ${sql.val(customKeys)}::text[]`;
  // Table and column names come from manifests (validated), never from input.
  const r = await tx.updateTable(table).set(set).where('id', 'in', ids).executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/**
 * Empties a custom record's PII fields through the record pipeline. A required field
 * cannot be emptied there (validation), so the record falls back to removing the keys
 * directly; the run is audited by the caller.
 */
async function clearRecordPii(p: Platform, tenantId: string, actor: Principal, entity: string, id: string, version: number, keys: string[], correlationId: string) {
  try {
    await executeRecordWrite(p, { tenantId, principal: actor, entity, op: 'update', id, version, values: Object.fromEntries(keys.map((k) => [k, null])), origin: 'system', correlationId });
  } catch (e) {
    p.log.warn({ err: String(e), record: id }, 'governance: clearing PII through the record pipeline failed; removing the fields directly');
    await p.database.withTenant(tenantId, (tx) => tx.updateTable('custom_record').set({ data: sql`data - ${sql.val(keys)}::text[]`, version: sql`version + 1`, updated_at: new Date() }).where('id', '=', id).execute());
  }
}

/** Runs one tenant's retention policies (nightly job, or "Run now"). */
export async function runRetention(p: Platform, tenantId: string, opts: { policyId?: string; actor?: Principal; correlationId: string }) {
  const actor = opts.actor ?? systemPrincipal(tenantId, 'retention');
  const policies = await p.database.withTenant(tenantId, (tx) => {
    let q = tx.selectFrom('retention_policy').selectAll().where('enabled', '=', true);
    if (opts.policyId) q = q.where('id', '=', opts.policyId);
    return q.execute();
  });
  const results = [];
  for (const pol of policies) {
    const cutoff = new Date(Date.now() - pol.after_days * 86_400_000);
    let affected = 0;
    if (pol.target.startsWith('custom:')) {
      const entity = pol.target.slice('custom:'.length);
      const pii = (await p.database.withTenant(tenantId, (tx) => piiInventory(p, tx))).filter((f) => f.target === pol.target);
      for (;;) {
        const batch = await p.database.withTenant(tenantId, (tx) =>
          tx
            .selectFrom('custom_record')
            .select(['id', 'version', 'data'])
            .where('entity', '=', entity)
            .where('created_at', '<', cutoff)
            // anonymise: only records that still hold a PII value
            .$if(pol.action === 'anonymise', (q) => q.where((eb) => eb.or(pii.map((f) => eb(sql`data ->> ${f.field}`, 'is not', null)))))
            .orderBy('id')
            .limit(BATCH)
            .execute(),
        );
        let n = 0;
        for (const r of batch) {
          if (pol.action === 'purge') {
            await executeRecordWrite(p, { tenantId, principal: actor, entity, op: 'delete', id: r.id, version: r.version, origin: 'system', correlationId: opts.correlationId });
          } else {
            await clearRecordPii(p, tenantId, actor, entity, r.id as string, r.version as number, pii.map((f) => f.field), opts.correlationId);
          }
          n++;
        }
        affected += n;
        if (batch.length < BATCH || affected >= MAX_PER_RUN) break;
      }
    } else {
      const pii = (await p.database.withTenant(tenantId, (tx) => piiInventory(p, tx))).filter((f) => f.target === pol.target);
      if (pii.length) {
        const cols = pii.filter((f) => f.storage === 'column').map((f) => f.field);
        const customKeys = pii.filter((f) => f.storage === 'custom').map((f) => f.field.slice('custom.'.length));
        for (;;) {
          const n = await p.database.withTenant(tenantId, async (tx) => {
            // Rows past the cutoff that still hold any PII value.
            const ids = await tx
              .selectFrom(pii[0]!.table)
              .select('id')
              .where('created_at', '<', cutoff)
              .where((eb) => eb.or([...cols.map((c) => eb.and([eb(sql.ref(c), 'is not', null), eb(sql.ref(c), '<>', ANON)])), ...customKeys.map((k) => eb(sql<boolean>`custom ? ${k}`, '=', true))]))
              .orderBy('id')
              .limit(BATCH)
              .execute();
            return anonymiseAppRows(tx, pii, ids.map((i) => i.id as string), ANON);
          });
          affected += n;
          if (n < BATCH || affected >= MAX_PER_RUN) break;
        }
      }
    }
    const result = { target: pol.target, action: pol.action, records: affected, cutoff: cutoff.toISOString() };
    await p.database.withTenant(tenantId, async (tx) => {
      await tx.updateTable('retention_policy').set({ last_run_at: new Date(), last_result: JSON.stringify(result) }).where('id', '=', pol.id).execute();
      await recordChange(p, tx, { tenantId, actor, action: 'platform:retention.applied', resourceType: RESOURCE, resourceId: pol.id, correlationId: opts.correlationId, events: [{ type: 'governance.retention_applied', data: { policy_id: pol.id, ...result } }], data: result });
    });
    results.push({ policy_id: pol.id, ...result });
  }
  return results;
}

export async function retentionAll(p: Platform) {
  const tenants = (await sql<{ tenant_id: string }>`SELECT tenant_id FROM retention_tenants()`.execute(p.database.db)).rows;
  for (const t of tenants) {
    await runRetention(p, t.tenant_id, { correlationId: `retention:${t.tenant_id}:${new Date().toISOString().slice(0, 10)}` }).catch((e: unknown) => p.log.error({ err: String(e), tenant: t.tenant_id }, 'retention failed'));
  }
}

// ------------------------------------------------------------------ data subject requests

export const DsrInput = z.object({
  kind: z.enum(['export', 'erase']),
  subject: z.string().trim().min(5).max(200),
});

const digits = (s: string) => s.replace(/\D/g, '');
/** Phone numbers match on their last 9 digits, so `+62 813…` and `0813…` are the same number. */
const PHONE_DIGITS = 9;
function matcher(subject: string) {
  const isEmail = subject.includes('@');
  const want = isEmail ? subject.trim().toLowerCase() : digits(subject).slice(-PHONE_DIGITS);
  if (!isEmail && want.length < PHONE_DIGITS) throw new CommandError(422, 'invalid_subject', `give an email address or a phone number (at least ${PHONE_DIGITS} digits)`);
  return { isEmail, want, test: (v: unknown) => typeof v === 'string' && (isEmail ? v.trim().toLowerCase() === want : digits(v).length >= PHONE_DIGITS && digits(v).slice(-PHONE_DIGITS) === want) };
}

interface Found {
  target: string;
  resource: string;
  id: string;
  /** PII fields this record holds */
  fields: string[];
  via: 'match' | 'link';
}

async function findSubject(p: Platform, tx: Tx, tenantId: string, subject: string): Promise<Found[]> {
  const m = matcher(subject);
  const inv = await piiInventory(p, tx);
  const found = new Map<string, Found>();
  const add = (f: Found) => {
    if (found.size < MAX_FOUND && !found.has(`${f.target}|${f.id}`)) found.set(`${f.target}|${f.id}`, f);
  };
  const byTarget = new Map<string, PiiField[]>();
  for (const f of inv) byTarget.set(f.target, [...(byTarget.get(f.target) ?? []), f]);
  for (const [target, fields] of byTarget) {
    const allFields = fields.map((f) => f.field);
    if (fields[0]!.storage === 'record') {
      const entity = target.slice('custom:'.length);
      let after = '00000000-0000-0000-0000-000000000000';
      for (let scanned = 0; scanned < MAX_SCAN; ) {
        const rows = await tx.selectFrom('custom_record').select(['id', 'data']).where('entity', '=', entity).where('id', '>', after).orderBy('id').limit(BATCH).execute();
        for (const r of rows) {
          const data = r.data as Record<string, unknown>;
          if (fields.some((f) => m.test(decryptValue(p.ports.vault, tenantId, target, f.field, data[f.field])))) add({ target, resource: fields[0]!.resource, id: r.id as string, fields: allFields, via: 'match' });
        }
        scanned += rows.length;
        if (rows.length < BATCH) break;
        after = rows.at(-1)!.id as string;
      }
      continue;
    }
    // App entities: plain PII columns are matched in SQL; encrypted custom fields are scanned.
    const cols = fields.filter((f) => f.storage === 'column').map((f) => f.field);
    if (cols.length) {
      const rows = await tx
        .selectFrom(fields[0]!.table)
        .select('id')
        .where((eb) => eb.or(cols.map((c) => (m.isEmail ? eb(sql`lower(trim(${sql.ref(c)}))`, '=', m.want) : eb(sql`right(regexp_replace(${sql.ref(c)}, '\\D', '', 'g'), ${PHONE_DIGITS})`, '=', m.want)))))
        .limit(MAX_FOUND)
        .execute();
      for (const r of rows) add({ target, resource: fields[0]!.resource, id: r.id as string, fields: allFields, via: 'match' });
    }
    const customKeys = fields.filter((f) => f.storage === 'custom').map((f) => f.field.slice('custom.'.length));
    if (customKeys.length) {
      let after = '00000000-0000-0000-0000-000000000000';
      for (let scanned = 0; scanned < MAX_SCAN; ) {
        const rows = await tx.selectFrom(fields[0]!.table).select(['id', 'custom']).where('id', '>', after).orderBy('id').limit(BATCH).execute();
        for (const r of rows) {
          const c = (r.custom ?? {}) as Record<string, unknown>;
          if (customKeys.some((k) => isEncrypted(c[k]) && m.test(decryptValue(p.ports.vault, tenantId, target, k, c[k])))) add({ target, resource: fields[0]!.resource, id: r.id as string, fields: allFields, via: 'match' });
        }
        scanned += rows.length;
        if (rows.length < BATCH) break;
        after = rows.at(-1)!.id as string;
      }
    }
  }
  // Follow the link index one hop: records linked to a match (e.g. the shipment of an order).
  const matched = [...found.values()];
  if (matched.length) {
    const ids = matched.map((f) => f.id);
    const links = await tx.selectFrom('record_link').select(['from_type', 'from_id', 'to_type', 'to_id']).where((eb) => eb.or([eb('from_id', 'in', ids), eb('to_id', 'in', ids)])).limit(MAX_FOUND).execute();
    for (const l of links) {
      for (const [type, id] of [[l.from_type, l.from_id], [l.to_type, l.to_id]] as const) {
        if (ids.includes(id as string)) continue;
        const pii = inv.filter((f) => f.resource === type);
        const target = pii[0]?.target ?? targetForResource(p, type as string);
        if (target) add({ target, resource: type as string, id: id as string, fields: pii.map((f) => f.field), via: 'link' });
      }
    }
  }
  return [...found.values()];
}

function targetForResource(p: Platform, resource: string): string | null {
  for (const m of p.catalog.manifests()) for (const e of m.entities) if (e.resource === resource) return `${m.id}:${e.name}`;
  return null;
}

/** The full record (PII decrypted) for an export. */
async function exportRecord(p: Platform, tx: Tx, tenantId: string, f: Found): Promise<Record<string, unknown> | null> {
  if (f.target.startsWith('custom:')) {
    const r = await tx.selectFrom('custom_record').selectAll().where('id', '=', f.id).executeTakeFirst();
    return r ? { id: r.id, entity: r.entity, created_at: r.created_at, ...decryptAll(p.ports.vault, tenantId, f.target, r.data as Record<string, unknown>) } : null;
  }
  const [app, entity] = f.target.split(':') as [string, string];
  const e = p.catalog.entity(app, entity);
  if (!e) return null;
  const r = await tx.selectFrom(e.table).selectAll().where('id', '=', f.id).executeTakeFirst();
  if (!r) return null;
  const { tenant_id: _t, search: _s, ...rest } = r as Record<string, unknown>;
  if (rest.custom) rest.custom = decryptAll(p.ports.vault, tenantId, f.target, rest.custom as Record<string, unknown>);
  return rest;
}

export async function runDsr(p: Platform, tenantId: string, actor: Principal, raw: unknown, correlationId: string) {
  const input = parseInput(DsrInput, raw);
  matcher(input.subject);
  const id = newId();
  await p.database.withTenant(tenantId, (tx) =>
    tx.insertInto('dsr_request').values({ id, tenant_id: tenantId, kind: input.kind, subject_enc: p.ports.vault.encrypt(input.subject, `dsr:${tenantId}:${id}`), status: 'running', requested_by: actor.id }).execute(),
  );
  try {
    const found = await p.database.withTenant(tenantId, (tx) => findSubject(p, tx, tenantId, input.subject));
    let fileId: string | null = null;
    if (input.kind === 'export') {
      // Streamed record by record into the Files port (never the whole export in memory).
      async function* lines() {
        yield `{"generated_at":${JSON.stringify(new Date().toISOString())},"request_id":${JSON.stringify(id)},"records":[`;
        let first = true;
        for (const f of found) {
          const rec = await p.database.withTenant(tenantId, (tx) => exportRecord(p, tx, tenantId, f));
          if (!rec) continue;
          yield `${first ? '' : ','}\n${JSON.stringify({ type: f.target, found_by: f.via, record: rec })}`;
          first = false;
        }
        yield '\n]}\n';
      }
      const file = await p.ports.files.put(tenantId, { name: `data-subject-export-${id.slice(0, 8)}.json`, contentType: 'application/json', purpose: `dsr:${id}`, createdBy: actor.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) }, lines(), { maxBytes: 50 * 1024 * 1024 });
      fileId = file.id;
    } else {
      // Erase: PII fields only; amounts, statuses and the audit log stay.
      for (const f of found.filter((x) => x.fields.length)) {
        if (f.target.startsWith('custom:')) {
          const entity = f.target.slice('custom:'.length);
          const cur = await p.database.withTenant(tenantId, (tx) => tx.selectFrom('custom_record').select('version').where('id', '=', f.id).executeTakeFirst());
          if (!cur) continue;
          await clearRecordPii(p, tenantId, actor, entity, f.id, cur.version, f.fields, correlationId);
        } else {
          const pii = (await p.database.withTenant(tenantId, (tx) => piiInventory(p, tx))).filter((x) => x.target === f.target);
          await p.database.withTenant(tenantId, (tx) => anonymiseAppRows(tx, pii, [f.id], ERASED));
        }
      }
    }
    const summary = found.map((f) => ({ type: f.target, id: f.id, fields: f.fields, found_by: f.via }));
    await p.database.withTenant(tenantId, async (tx) => {
      await tx.updateTable('dsr_request').set({ status: 'succeeded', found: JSON.stringify(summary), file_id: fileId, finished_at: new Date() }).where('id', '=', id).execute();
      // No PII in the event or audit data: counts and record ids only.
      await recordChange(p, tx, { tenantId, actor, action: `platform:dsr.${input.kind}`, resourceType: 'platform::DataSubjectRequest', resourceId: id, correlationId, events: [{ type: 'governance.dsr_completed', data: { request_id: id, kind: input.kind, records: summary.length } }], data: { records: summary.map((s) => `${s.type}:${s.id}`) } });
    });
    return { id, kind: input.kind, found: summary, file_id: fileId };
  } catch (e) {
    await p.database.withTenant(tenantId, (tx) => tx.updateTable('dsr_request').set({ status: 'failed', error: (e as Error).message.slice(0, 300), finished_at: new Date() }).where('id', '=', id).execute());
    throw e;
  }
}

// ------------------------------------------------------------------ audit export

export const AuditExportInput = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .refine((v) => Date.parse(v.to) > Date.parse(v.from) && Date.parse(v.to) - Date.parse(v.from) <= 400 * 86_400_000, 'the range must be positive and at most 400 days');

export async function exportAuditLog(p: Platform, tenantId: string, actor: Principal, raw: unknown, correlationId: string) {
  const input = parseInput(AuditExportInput, raw);
  const from = new Date(input.from);
  const to = new Date(input.to);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  let rows = 0;
  async function* lines() {
    yield 'at,actor_type,actor_id,action,resource_type,resource_id,correlation_id,data\r\n';
    let cursor: { at: Date; id: string } | null = null;
    for (;;) {
      const c: { at: Date; id: string } | null = cursor;
      const batch = (await p.database.withTenant(tenantId, (tx) =>
        tx
          .selectFrom('audit_log')
          .selectAll()
          .where('at', '>=', from)
          .where('at', '<', to)
          .$if(c !== null, (q) => q.where((eb) => eb.or([eb('at', '>', c!.at), eb.and([eb('at', '=', c!.at), eb('id', '>', c!.id)])])))
          .orderBy('at')
          .orderBy('id')
          .limit(BATCH)
          .execute(),
      )) as { at: Date; id: string; [k: string]: unknown }[];
      for (const r of batch) yield `${[new Date(r.at).toISOString(), r.actor_type, r.actor_id, r.action, r.resource_type, r.resource_id, r.correlation_id, r.data].map(cell).join(',')}\r\n`;
      rows += batch.length;
      if (batch.length < BATCH) return;
      cursor = { at: batch.at(-1)!.at as Date, id: batch.at(-1)!.id as string };
    }
  }
  const file = await p.ports.files.put(tenantId, { name: `audit-log ${input.from.slice(0, 10)} to ${input.to.slice(0, 10)}.csv`, contentType: 'text/csv; charset=utf-8', purpose: 'audit-export', createdBy: actor.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) }, lines(), { maxBytes: 200 * 1024 * 1024 });
  await p.database.withTenant(tenantId, (tx) =>
    recordChange(p, tx, { tenantId, actor, action: 'platform:audit.exported', resourceType: 'platform::AuditLog', resourceId: file.id, correlationId, events: [{ type: 'governance.audit_exported', data: { file_id: file.id, from: input.from, to: input.to, rows } }], data: { rows } }),
  );
  return { file_id: file.id, rows };
}

