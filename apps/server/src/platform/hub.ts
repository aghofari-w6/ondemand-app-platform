import { randomBytes } from 'node:crypto';
import { backoffMs, CommandError, ConnectorSpec, expr, type EndpointInput, type EventEnvelope, type Principal } from '@aod/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { newId, type Tx } from '../db/database.ts';
import type { Consumer, DeliveryTarget, OutboundMessage, Vault } from '../ports/index.ts';
import type { Platform } from './context.ts';
import { executeRecordWrite, loadEntity } from './records.ts';
import { recordChange } from './record.ts';

/**
 * Integration Hub.
 *
 * Fan-out: a `*` consumer on the event bus turns every event into one `hub_delivery`
 * row per matching endpoint (event type, filter expression, schema version pin) — in the
 * same transaction that marks the event processed, so nothing is lost or doubled.
 *
 * Delivery: an in-process worker claims due deliveries (lease, SKIP LOCKED), sends them
 * outside any transaction, and records each attempt. Failures retry with exponential
 * backoff + jitter until `HUB_MAX_ATTEMPTS`, then land in the DLQ (status `dead`). A
 * per-endpoint circuit breaker opens after `HUB_BREAKER_THRESHOLD` consecutive failures
 * and lets one trial through after the cool-down. Replays reuse the original event id.
 */

const aadCreds = (tenantId: string, endpointId: string) => `hub:creds:${tenantId}:${endpointId}`;
const aadSecret = (tenantId: string, endpointId: string) => `hub:whsec:${tenantId}:${endpointId}`;

type EndpointSecrets = { ok: true; credentials: Record<string, any> | null; signingSecret: string | null } | { ok: false; unreadable: 'credentials' | 'signing_secret' };

/**
 * Decrypts an endpoint's stored credentials and signing secret. A value that cannot be
 * decrypted (the vault key changed, or the ciphertext was altered) is reported by field
 * instead of thrown, so callers can fail the delivery visibly. Never exposes the cause:
 * it could carry ciphertext.
 */
function openSecrets(vault: Vault, tenantId: string, e: { id: string; credentials_enc?: string | null; signing_secret_enc?: string | null }): EndpointSecrets {
  let credentials: Record<string, any> | null = null;
  let signingSecret: string | null = null;
  try {
    if (e.credentials_enc) credentials = JSON.parse(vault.decrypt(e.credentials_enc, aadCreds(tenantId, e.id)));
  } catch {
    return { ok: false, unreadable: 'credentials' };
  }
  try {
    if (e.signing_secret_enc) signingSecret = vault.decrypt(e.signing_secret_enc, aadSecret(tenantId, e.id));
  } catch {
    return { ok: false, unreadable: 'signing_secret' };
  }
  return { ok: true, credentials, signingSecret };
}

const UNREADABLE_ERROR = {
  credentials: 'endpoint credentials cannot be decrypted (was the vault key changed?); re-enter the credentials',
  signing_secret: 'endpoint signing secret cannot be decrypted (was the vault key changed?); rotate the signing secret',
} as const;

// ------------------------------------------------------------------ endpoints

function eventCatalog(p: Platform): Map<string, number> {
  const m = new Map<string, number>();
  for (const man of p.catalog.manifests()) for (const e of man.events.publishes) m.set(e.type, e.version);
  for (const t of ['record.created', 'record.updated', 'record.deleted']) m.set(t, 1);
  return m;
}

export const matchesType = (pattern: string, type: string) => pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)));

async function planLimit(p: Platform, tx: Tx, key: 'hub_endpoints' | 'api_keys') {
  const t = await tx.selectFrom('tenant').select('plan').executeTakeFirstOrThrow();
  return p.ports.billing.plan(t.plan)?.limits[key] ?? 0;
}

function toTarget(kind: string, config: Record<string, any>, credentials: Record<string, any> | null, signingSecret: string | null): DeliveryTarget {
  return { kind: kind as DeliveryTarget['kind'], config, credentials, signingSecret };
}

export async function saveEndpoint(p: Platform, tx: Tx, tenantId: string, actor: Principal, input: EndpointInput, correlationId: string, existing?: { id: string; version: number }) {
  const catalog = eventCatalog(p);
  for (const t of input.event_types) if (!t.includes('*') && !catalog.has(t)) throw new CommandError(422, 'unknown_event', `unknown event type ${t}`);
  if (input.filter) {
    try {
      expr.parse(input.filter);
    } catch (e) {
      throw new CommandError(422, 'invalid_filter', `filter: ${(e as Error).message}`);
    }
  }
  // Schema pins: explicit pins must exist; every concrete subscribed type is pinned to its current version.
  const pins: Record<string, number> = {};
  for (const [type, v] of Object.entries(input.schema_pins)) {
    if (catalog.get(type) === undefined) throw new CommandError(422, 'unknown_event', `cannot pin unknown event ${type}`);
    if (v > catalog.get(type)!) throw new CommandError(422, 'unknown_version', `${type} has no version ${v}`);
    pins[type] = v;
  }
  for (const [type, v] of catalog) if (input.event_types.some((pt) => matchesType(pt, type)) && pins[type] === undefined) pins[type] = v;

  const credentials = 'credentials' in input ? (input.credentials ?? null) : null;
  if (input.kind === 'custom') {
    const c = await tx.selectFrom('hub_connector').select('id').where('id', '=', input.config.connector_id).executeTakeFirst();
    if (!c) throw new CommandError(422, 'unknown_connector', 'connector not found');
  } else {
    // SSRF / policy check at save time.
    try {
      await p.ports.webhooks.checkTarget(toTarget(input.kind, input.config, credentials, null));
    } catch (e) {
      throw new CommandError(422, 'endpoint_rejected', (e as Error).message);
    }
  }

  const id = existing?.id ?? newId();
  let signingSecret: string | null = null;
  const values: Record<string, unknown> = {
    name: input.name,
    kind: input.kind,
    config: JSON.stringify(input.config),
    connector_id: input.kind === 'custom' ? input.config.connector_id : null,
    event_types: input.event_types,
    filter: input.filter ?? null,
    schema_pins: JSON.stringify(pins),
  };
  // Write-only credentials: replaced when given, kept when omitted on update.
  if (credentials) values.credentials_enc = p.ports.vault.encrypt(JSON.stringify(credentials), aadCreds(tenantId, id));
  if (existing) {
    const row = await tx.updateTable('hub_endpoint').set({ ...values, version: sql`version + 1`, updated_at: new Date() }).where('id', '=', id).where('version', '=', existing.version).returning('version').executeTakeFirst();
    if (!row) throw new CommandError(409, 'version_conflict', 'the endpoint changed');
  } else {
    const count = await tx.selectFrom('hub_endpoint').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
    const limit = await planLimit(p, tx, 'hub_endpoints');
    if (count.n >= limit) throw new CommandError(409, 'plan_limit', `your plan allows ${limit} endpoints`);
    if (input.kind === 'webhook') {
      signingSecret = `whsec_${randomBytes(24).toString('base64')}`;
      values.signing_secret_enc = p.ports.vault.encrypt(signingSecret, aadSecret(tenantId, id));
    }
    await tx
      .insertInto('hub_endpoint')
      .values({ id, tenant_id: tenantId, ...values })
      .execute()
      .catch((e) => {
        if (e?.code === '23505') throw new CommandError(409, 'name_taken', `an endpoint named ${input.name} exists`);
        throw e;
      });
  }
  await recordChange(p, tx, { tenantId, actor, action: existing ? 'platform:hub.endpoint_updated' : 'platform:hub.endpoint_created', resourceType: 'platform::HubEndpoint', resourceId: id, correlationId, events: [{ type: existing ? 'hub.endpoint_updated' : 'hub.endpoint_created', data: { endpoint_id: id, kind: input.kind, event_types: input.event_types } }] });
  // The signing secret is shown once, at creation.
  return { id, signingSecret, schema_pins: pins };
}

export async function rotateSecret(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, correlationId: string) {
  const e = await tx.selectFrom('hub_endpoint').select('kind').where('id', '=', id).executeTakeFirst();
  if (!e) throw new CommandError(404, 'not_found', 'endpoint not found');
  if (e.kind !== 'webhook') throw new CommandError(409, 'not_webhook', 'only webhook endpoints have a signing secret');
  const secret = `whsec_${randomBytes(24).toString('base64')}`;
  await tx.updateTable('hub_endpoint').set({ signing_secret_enc: p.ports.vault.encrypt(secret, aadSecret(tenantId, id)), version: sql`version + 1` }).where('id', '=', id).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:hub.secret_rotated', resourceType: 'platform::HubEndpoint', resourceId: id, correlationId });
  return secret;
}

/**
 * Public view: never includes credentials or secrets. `*_unreadable` flags a stored value
 * the vault can no longer decrypt, so the admin can re-enter it.
 */
export function endpointView(vault: Vault, r: any) {
  const credentialsUnreadable = Boolean(r.credentials_enc) && !openSecrets(vault, r.tenant_id, { id: r.id, credentials_enc: r.credentials_enc }).ok;
  const secretUnreadable = Boolean(r.signing_secret_enc) && !openSecrets(vault, r.tenant_id, { id: r.id, signing_secret_enc: r.signing_secret_enc }).ok;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    config: r.config,
    event_types: r.event_types,
    filter: r.filter,
    schema_pins: r.schema_pins,
    status: r.status,
    circuit_state: r.circuit_state,
    circuit_opened_at: r.circuit_opened_at,
    consecutive_failures: r.consecutive_failures,
    has_credentials: Boolean(r.credentials_enc),
    has_signing_secret: Boolean(r.signing_secret_enc),
    credentials_unreadable: credentialsUnreadable,
    signing_secret_unreadable: secretUnreadable,
    version: r.version,
    created_at: r.created_at,
  };
}

// ------------------------------------------------------------------ fan-out

export function hubFanoutConsumer(_p: Platform): Consumer {
  return {
    name: 'platform.hub_fanout',
    types: ['*'],
    async handle(event: EventEnvelope, tx) {
      const endpoints = await tx.selectFrom('hub_endpoint').select(['id', 'event_types', 'filter', 'schema_pins']).where('status', '=', 'active').execute();
      if (!endpoints.length) return;
      const syncs = await tx.selectFrom('hub_sync').select(['id', 'endpoint_id']).execute();
      for (const e of endpoints) {
        if (!(e.event_types as string[]).some((pt) => matchesType(pt, event.type))) continue;
        // An endpoint never receives the Hub's own events about itself (a dead endpoint
        // subscribed to `*` would otherwise feed itself dead-letter events forever).
        if (event.type.startsWith('hub.') && event.data.endpoint_id === e.id) continue;
        // Loop prevention: never send a change back to the system it came from.
        if (syncs.some((s) => s.endpoint_id === e.id && event.correlation_id.startsWith(`sync:${s.id}:`))) continue;
        let status: 'pending' | 'skipped' = 'pending';
        let note: string | null = null;
        const pin = (e.schema_pins as Record<string, number>)[event.type];
        if (pin !== undefined && pin !== event.version) {
          status = 'skipped';
          note = `schema version ${event.version} does not match the pinned version ${pin}`;
        } else if (e.filter) {
          try {
            if (!expr.truthy(expr.evaluate(expr.parse(e.filter), event as unknown as Record<string, unknown>, { maxSteps: 5000 }))) continue;
          } catch (err) {
            status = 'skipped';
            note = `filter error: ${(err as Error).message}`;
          }
        }
        await tx
          .insertInto('hub_delivery')
          .values({ id: newId(), tenant_id: event.tenant_id, endpoint_id: e.id, event_id: event.id, event_type: event.type, status, last_error: note })
          .onConflict((oc) => oc.columns(['endpoint_id', 'event_id']).doNothing())
          .execute();
      }
    },
  };
}

// ------------------------------------------------------------------ delivery worker

interface HubOptions {
  maxAttempts: number;
  backoffBaseMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  leaseSeconds: number;
}

export const hubOptions = (p: Platform): HubOptions => ({
  maxAttempts: p.env.HUB_MAX_ATTEMPTS,
  backoffBaseMs: p.env.HUB_BACKOFF_BASE_MS,
  breakerThreshold: p.env.HUB_BREAKER_THRESHOLD,
  breakerCooldownMs: p.env.HUB_BREAKER_COOLDOWN_MS,
  leaseSeconds: 60,
});

/** Runs a custom connector's steps over the event; http steps are sent through the Webhooks port. */
export async function runConnector(p: Platform, spec: ConnectorSpec, envelope: EventEnvelope, credentials: Record<string, any> | null, opts: { dryRun: boolean }) {
  let value: unknown = envelope;
  const trace: { step: number; kind: string; ok: boolean; detail?: string }[] = [];
  let last: { ok: boolean; status?: number; error?: string; response?: string } = { ok: true };
  for (const [i, step] of spec.steps.entries()) {
    if (step.kind === 'map') {
      const src = value as Record<string, unknown>;
      value = Object.fromEntries(Object.entries(step.fields).map(([k, path]) => [k, path.split('.').reduce<any>((o, seg) => (o && typeof o === 'object' && Object.hasOwn(o, seg) ? o[seg] : null), src)]));
      trace.push({ step: i, kind: 'map', ok: true });
    } else if (step.kind === 'code') {
      try {
        value = await p.ports.sandbox.run(step.source, value, { timeoutMs: step.timeout_ms, memoryMb: step.memory_mb });
        trace.push({ step: i, kind: 'code', ok: true });
      } catch (e) {
        trace.push({ step: i, kind: 'code', ok: false, detail: (e as Error).message });
        return { ok: false, error: `code step ${i}: ${(e as Error).message}`, output: value, trace };
      }
    } else {
      if (opts.dryRun) {
        trace.push({ step: i, kind: 'http', ok: true, detail: `dry run: would ${step.method} ${step.url}` });
        continue;
      }
      last = await p.ports.webhooks.deliver({ kind: 'http', config: { url: step.url, method: step.method }, credentials }, { id: envelope.id, type: envelope.type, timestamp: new Date(envelope.occurred_at), body: JSON.stringify(value) });
      trace.push({ step: i, kind: 'http', ok: last.ok, ...(last.error ? { detail: last.error } : {}) });
      if (!last.ok) return { ok: false, status: last.status, error: last.error, output: value, trace };
    }
  }
  return { ok: true, status: last.status, response: last.response, output: value, trace };
}

export class HubDeliverer {
  private readonly p: Platform;
  private readonly o: HubOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking: Promise<unknown> | null = null;

  constructor(p: Platform, o?: Partial<HubOptions>) {
    this.p = p;
    this.o = { ...hubOptions(p), ...o };
  }

  start() {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      this.ticking = this.tick().catch((e) => this.p.log.error({ err: String(e) }, 'hub tick failed'));
      await this.ticking;
      this.ticking = null;
      if (this.running) this.timer = setTimeout(loop, this.p.env.HUB_INTERVAL_MS);
    };
    void loop();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.ticking) await this.ticking;
  }

  /** Claims and processes due deliveries; returns how many were attempted. */
  async tick(limit = 20): Promise<number> {
    const claimed = (await sql<{ tenant_id: string; id: string }>`SELECT * FROM hub_claim_deliveries(${limit}, ${this.o.leaseSeconds})`.execute(this.p.database.db)).rows;
    await Promise.all(claimed.map((c) => this.process(c.tenant_id, c.id).catch((e) => this.p.log.error({ err: String(e), delivery: c.id }, 'delivery failed unexpectedly'))));
    return claimed.length;
  }

  /** Drain everything that is due now (tests, demo). */
  async drain() {
    for (let i = 0; i < 100; i++) if ((await this.tick(50)) === 0) return;
  }

  private async process(tenantId: string, deliveryId: string) {
    const p = this.p;
    const loaded = await p.database.withTenant(tenantId, async (tx) => {
      const d = await tx.selectFrom('hub_delivery').selectAll().where('id', '=', deliveryId).executeTakeFirst();
      if (!d || d.status !== 'delivering') return null;
      const e = await tx.selectFrom('hub_endpoint').selectAll().where('id', '=', d.endpoint_id).executeTakeFirst();
      const ev = await tx.selectFrom('event_log').select('payload').where('id', '=', d.event_id).executeTakeFirst();
      if (!e || !ev) {
        await tx.updateTable('hub_delivery').set({ status: 'dead', last_error: !e ? 'endpoint removed' : 'event not found', lease_until: null }).where('id', '=', d.id).execute();
        return null;
      }
      const now = Date.now();
      // Paused endpoints hold their deliveries.
      if (e.status === 'paused') {
        await tx.updateTable('hub_delivery').set({ status: 'pending', next_attempt_at: new Date(now + 60_000), lease_until: null }).where('id', '=', d.id).execute();
        return null;
      }
      // Circuit breaker: while open, defer without spending an attempt; after the cool-down let one trial through.
      if (e.circuit_state === 'open') {
        const reopenAt = new Date(e.circuit_opened_at).getTime() + this.o.breakerCooldownMs;
        if (now < reopenAt) {
          await tx.updateTable('hub_delivery').set({ status: 'pending', next_attempt_at: new Date(reopenAt), lease_until: null }).where('id', '=', d.id).execute();
          return null;
        }
        const won = await tx.updateTable('hub_endpoint').set({ circuit_state: 'half_open' }).where('id', '=', e.id).where('circuit_state', '=', 'open').returning('id').executeTakeFirst();
        if (!won) {
          await tx.updateTable('hub_delivery').set({ status: 'pending', next_attempt_at: new Date(now + 1000), lease_until: null }).where('id', '=', d.id).execute();
          return null;
        }
      } else if (e.circuit_state === 'half_open') {
        await tx.updateTable('hub_delivery').set({ status: 'pending', next_attempt_at: new Date(now + 1000), lease_until: null }).where('id', '=', d.id).execute();
        return null;
      }
      const sync = await tx.selectFrom('hub_sync').selectAll().where('endpoint_id', '=', e.id).execute();
      const recordId = (ev.payload as EventEnvelope).data.record_id;
      const map = sync.length && typeof recordId === 'string' ? await tx.selectFrom('external_id_map').selectAll().where('local_id', '=', recordId).execute() : [];
      const connector = e.connector_id ? await tx.selectFrom('hub_connector').select('spec').where('id', '=', e.connector_id).executeTakeFirst() : null;
      return { d, e, envelope: ev.payload as EventEnvelope, sync, map, connector };
    });
    if (!loaded) return;
    const { d, e, envelope } = loaded;

    const secrets = openSecrets(p.ports.vault, tenantId, { id: e.id, credentials_enc: e.credentials_enc, signing_secret_enc: e.signing_secret_enc });
    const { credentials, signingSecret } = secrets.ok ? secrets : { credentials: null, signingSecret: null };
    const sync = loaded.sync.find((s) => envelope.type.startsWith('record.') && envelope.data.entity === s.entity) ?? null;
    const body = sync ? syncBody(sync, envelope, loaded.map.find((m) => m.sync_id === sync.id)?.external_id ?? null) : JSON.stringify(envelope);
    const msg: OutboundMessage = { id: envelope.id, type: envelope.type, timestamp: new Date(), body };

    let result: { ok: boolean; status?: number | undefined; error?: string | undefined; response?: string | undefined; durationMs: number };
    const started = Date.now();
    if (!secrets.ok) {
      // Not sendable, but still an attempt: it is logged, counts toward the breaker and
      // dead-letters like any other failure instead of being re-claimed forever.
      p.log.warn({ delivery: d.id, endpoint: e.id, field: secrets.unreadable }, 'hub endpoint secret cannot be decrypted');
      result = { ok: false, error: UNREADABLE_ERROR[secrets.unreadable], durationMs: 0 };
    } else if (e.kind === 'custom') {
      const spec = ConnectorSpec.parse(loaded.connector?.spec);
      const r = await runConnector(p, spec, envelope, credentials, { dryRun: false });
      result = { ok: r.ok, status: r.status, error: r.error, response: r.response, durationMs: Date.now() - started };
    } else {
      result = await p.ports.webhooks.deliver(toTarget(e.kind, e.config as Record<string, any>, credentials, signingSecret), msg);
    }
    p.ports.metrics.increment('aod_hub_deliveries_total', { kind: e.kind, ok: String(result.ok) });

    await p.database.withTenant(tenantId, async (tx) => {
      const attempt = d.attempts + 1;
      await tx.insertInto('hub_delivery_attempt').values({ id: newId(), tenant_id: tenantId, delivery_id: d.id, attempt, ok: result.ok, status_code: result.status ?? null, error: result.error ?? null, duration_ms: result.durationMs }).execute();
      if (result.ok) {
        await tx.updateTable('hub_delivery').set({ status: 'succeeded', attempts: attempt, last_status: result.status ?? null, last_error: null, lease_until: null, updated_at: new Date() }).where('id', '=', d.id).execute();
        await tx.updateTable('hub_endpoint').set({ consecutive_failures: 0, circuit_state: 'closed', circuit_opened_at: null }).where('id', '=', e.id).execute();
        if (sync) await recordSyncedOut(tx, tenantId, sync.id, envelope, result.response);
        return;
      }
      const dead = attempt >= this.o.maxAttempts;
      await tx
        .updateTable('hub_delivery')
        .set({
          status: dead ? 'dead' : 'pending',
          attempts: attempt,
          last_status: result.status ?? null,
          last_error: result.error ?? 'failed',
          next_attempt_at: new Date(Date.now() + backoffMs(attempt - 1, { baseMs: this.o.backoffBaseMs })),
          lease_until: null,
          updated_at: new Date(),
        })
        .where('id', '=', d.id)
        .execute();
      // Atomic: concurrent failures on the same endpoint must all count.
      await sql`
        UPDATE hub_endpoint SET
          consecutive_failures = consecutive_failures + 1,
          circuit_opened_at = CASE WHEN circuit_state <> 'closed' OR consecutive_failures + 1 >= ${this.o.breakerThreshold} THEN now() ELSE circuit_opened_at END,
          circuit_state = CASE WHEN circuit_state <> 'closed' OR consecutive_failures + 1 >= ${this.o.breakerThreshold} THEN 'open' ELSE circuit_state END
        WHERE id = ${e.id}`.execute(tx);
      if (dead) {
        await recordChange(p, tx, {
          tenantId,
          actor: { type: 'System', id: 'hub' },
          action: 'platform:hub.dead_lettered',
          resourceType: 'platform::HubDelivery',
          resourceId: d.id,
          correlationId: envelope.correlation_id,
          events: [{ type: 'hub.delivery_dead', data: { delivery_id: d.id, endpoint_id: e.id, event_id: d.event_id, event_type: d.event_type, attempts: attempt } }],
        });
      }
    });
  }
}

// ------------------------------------------------------------------ DLQ replay

export async function replayDeliveries(p: Platform, tx: Tx, tenantId: string, actor: Principal, sel: { ids?: string[]; endpointId?: string; status?: 'dead' | 'skipped' }, correlationId: string) {
  let q = tx.updateTable('hub_delivery').set({ status: 'pending', attempts: 0, next_attempt_at: new Date(), lease_until: null, last_error: null, replays: sql`replays + 1`, updated_at: new Date() });
  if (sel.ids?.length) q = q.where('id', 'in', sel.ids).where('status', 'in', ['dead', 'succeeded', 'skipped']);
  else if (sel.endpointId) q = q.where('endpoint_id', '=', sel.endpointId).where('status', '=', sel.status ?? 'dead');
  else throw new CommandError(422, 'invalid_input', 'give delivery ids or an endpoint');
  const rows = await q.returning(['id', 'event_id']).execute();
  if (sel.endpointId || sel.ids?.length) {
    // A replay is a fresh chance: close the breaker so the endpoint is tried right away.
    const endpoints = sel.endpointId ? [sel.endpointId] : (await tx.selectFrom('hub_delivery').select('endpoint_id').where('id', 'in', rows.map((r) => r.id).concat(['00000000-0000-0000-0000-000000000000'])).execute()).map((r) => r.endpoint_id);
    if (endpoints.length) await tx.updateTable('hub_endpoint').set({ circuit_state: 'closed', consecutive_failures: 0, circuit_opened_at: null }).where('id', 'in', endpoints).execute();
  }
  await recordChange(p, tx, { tenantId, actor, action: 'platform:hub.replayed', resourceType: 'platform::HubDelivery', resourceId: sel.endpointId ?? 'selection', correlationId, events: [{ type: 'hub.replayed', data: { deliveries: rows.length, event_ids: rows.map((r) => r.event_id).slice(0, 100) } }] });
  return rows.length;
}

// ------------------------------------------------------------------ two-way sync

const mapOut = (fieldMap: Record<string, string>, values: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [fieldMap[k] ?? k, v]));
const mapIn = (fieldMap: Record<string, string>, data: Record<string, unknown>) => {
  const reverse = Object.fromEntries(Object.entries(fieldMap).map(([l, r]) => [r, l]));
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [reverse[k] ?? k, v]));
};

function syncBody(sync: any, env: EventEnvelope, externalId: string | null) {
  const d = env.data as { record_id: string; version: number | null; values: Record<string, unknown> | null };
  return JSON.stringify({
    sync: sync.name,
    event_id: env.id,
    op: env.type.split('.')[1],
    local_id: d.record_id,
    external_id: externalId,
    version: d.version,
    data: d.values ? mapOut(sync.field_map as Record<string, string>, d.values) : null,
    occurred_at: env.occurred_at,
  });
}

async function recordSyncedOut(tx: Tx, tenantId: string, syncId: string, env: EventEnvelope, response?: string) {
  const d = env.data as { record_id: string; version: number | null };
  if (env.type === 'record.deleted') {
    await tx.deleteFrom('external_id_map').where('sync_id', '=', syncId).where('local_id', '=', d.record_id).execute();
    return;
  }
  let externalId: string | null = null;
  try {
    const body = JSON.parse(response ?? '{}');
    externalId = typeof body.external_id === 'string' ? body.external_id : typeof body.id === 'string' ? body.id : null;
  } catch {
    /* remote did not answer JSON */
  }
  const existing = await tx.selectFrom('external_id_map').selectAll().where('sync_id', '=', syncId).where('local_id', '=', d.record_id).executeTakeFirst();
  if (existing) {
    await tx.updateTable('external_id_map').set({ local_version: Math.max(existing.local_version, d.version ?? 0), last_synced_at: new Date() }).where('sync_id', '=', syncId).where('local_id', '=', d.record_id).execute();
  } else if (externalId) {
    await tx.insertInto('external_id_map').values({ tenant_id: tenantId, sync_id: syncId, local_id: d.record_id, external_id: externalId, local_version: d.version ?? 1 }).onConflict((oc) => oc.doNothing()).execute();
  }
}

export const SyncInboundBody = z.object({ external_id: z.string(), updated_at: z.string(), data: z.record(z.string(), z.unknown()), deleted: z.boolean() });

/**
 * Applies a change pushed by the remote system. Conflict = both sides changed since the
 * last sync; the sync's rule decides (platform_wins, remote_wins, last_write_wins).
 */
export async function applyInbound(p: Platform, tenantId: string, principal: Principal, syncId: string, change: z.infer<typeof SyncInboundBody>, correlationSuffix: string) {
  return p.database.withTenant(tenantId, async (tx) => {
    const sync = await tx.selectFrom('hub_sync').selectAll().where('id', '=', syncId).executeTakeFirst();
    if (!sync) throw new CommandError(404, 'not_found', 'sync not found');
    await loadEntity(tx, sync.entity);
    const remoteAt = new Date(change.updated_at);
    const correlationId = `sync:${sync.id}:${correlationSuffix}`;
    const values = mapIn(sync.field_map as Record<string, string>, change.data);
    const map = await tx.selectFrom('external_id_map').selectAll().where('sync_id', '=', sync.id).where('external_id', '=', change.external_id).executeTakeFirst();
    const base = { tenantId, principal, entity: sync.entity, origin: 'integration' as const, correlationId };

    if (!map) {
      if (change.deleted) return { result: 'ignored', reason: 'unknown record' };
      const r = await executeRecordWrite(p, { ...base, op: 'create', values }, tx);
      await tx.insertInto('external_id_map').values({ tenant_id: tenantId, sync_id: sync.id, local_id: r.body.id, external_id: change.external_id, local_version: r.body.version, remote_updated_at: remoteAt }).execute();
      return { result: 'created', local_id: r.body.id };
    }
    if (map.remote_updated_at && remoteAt <= new Date(map.remote_updated_at)) return { result: 'stale', local_id: map.local_id };
    const cur = await tx.selectFrom('custom_record').select(['version', 'updated_at']).where('id', '=', map.local_id).executeTakeFirst();
    if (!cur) {
      await tx.deleteFrom('external_id_map').where('sync_id', '=', sync.id).where('local_id', '=', map.local_id).execute();
      return { result: 'ignored', reason: 'local record was deleted' };
    }
    const localChanged = cur.version > map.local_version;
    if (localChanged) {
      const remoteWins = sync.conflict_rule === 'remote_wins' || (sync.conflict_rule === 'last_write_wins' && remoteAt > new Date(cur.updated_at));
      if (!remoteWins) {
        await tx.updateTable('external_id_map').set({ remote_updated_at: remoteAt, last_synced_at: new Date() }).where('sync_id', '=', sync.id).where('local_id', '=', map.local_id).execute();
        await recordChange(p, tx, { tenantId, actor: principal, action: 'platform:hub.sync_conflict', resourceType: 'platform::HubSync', resourceId: sync.id, correlationId, events: [{ type: 'hub.sync_conflict', data: { sync_id: sync.id, local_id: map.local_id, external_id: change.external_id, rule: sync.conflict_rule, winner: 'platform' } }] });
        return { result: 'conflict', winner: 'platform', local_id: map.local_id };
      }
    }
    if (change.deleted) {
      await executeRecordWrite(p, { ...base, op: 'delete', id: map.local_id, version: cur.version }, tx);
      await tx.deleteFrom('external_id_map').where('sync_id', '=', sync.id).where('local_id', '=', map.local_id).execute();
      return { result: 'deleted', local_id: map.local_id };
    }
    const r = await executeRecordWrite(p, { ...base, op: 'update', id: map.local_id, version: cur.version, values }, tx);
    await tx.updateTable('external_id_map').set({ local_version: r.body.version, remote_updated_at: remoteAt, last_synced_at: new Date() }).where('sync_id', '=', sync.id).where('local_id', '=', map.local_id).execute();
    return { result: localChanged ? 'conflict' : 'updated', winner: localChanged ? 'remote' : undefined, local_id: map.local_id };
  });
}
