import { sql, type Kysely, type Transaction } from 'kysely';
import type { z } from 'zod';
import type { EventDraft, EventEnvelope, EventOrigin } from './envelope.ts';
import type { Decision, Principal } from './permissions.ts';

/**
 * Contract between the platform and an app template module.
 *
 * Templates are separate packages. They depend on `@aod/shared` only (enforced by a
 * lint rule) and talk to each other exclusively through events. All database access
 * goes through the tenant-scoped transaction handed to them, so RLS applies.
 */

// Templates own their tables; the platform does not know their shape.
export type Db = Kysely<any>;
export type Tx = Transaction<any>;

export class CommandError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CommandError';
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what: string) => new CommandError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new CommandError(409, 'conflict', message);
export const invalid = (message: string) => new CommandError(422, 'invalid', message);

export interface TenantTxContext {
  tx: Tx;
  tenantId: string;
  now: () => Date;
  newId: () => string;
}

export interface CommandContext extends TenantTxContext {
  principal: Principal;
  decision: Decision;
  origin: EventOrigin;
  /** Queue an event; it is written to the outbox in this transaction. Must be in the command's `may_emit`. */
  emit: (draft: EventDraft) => void;
  /** App config (manifest defaults merged with tenant overrides) */
  config: Record<string, unknown>;
  /** Validated custom fields for an entity (throws 422 on invalid input) */
  validateCustom: (entity: string, values: Record<string, unknown> | undefined, existing?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface CommandResult {
  /** aggregate id the command acted on */
  id: string;
  /** new version after the write, if versioned */
  version?: number;
  [k: string]: unknown;
}

export interface CommandSpec<S extends z.ZodType = z.ZodType> {
  input: S;
  handle: (ctx: CommandContext, input: z.infer<S>) => Promise<CommandResult>;
}

export const defineCommand = <S extends z.ZodType>(spec: CommandSpec<S>): CommandSpec<S> => spec;

export interface ConsumerContext extends TenantTxContext {
  /** Queue an event; it must be listed in the app's events.publishes. */
  emit: (draft: EventDraft) => void;
  config: Record<string, unknown>;
}

export interface InboundRequest {
  tenantId: string;
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string | undefined>;
}

export interface TemplateModule {
  id: string;
  /** absolute path of the template directory (manifest.yaml, migrations/) */
  dir: string;
  commands: Record<string, CommandSpec<any>>;
  /** event consumers keyed by `events.consumes[].consumer` */
  consumers?: Record<string, (ctx: ConsumerContext, event: EventEnvelope) => Promise<void>>;
  /** default tenant data created when the app is provisioned */
  seed: (ctx: TenantTxContext) => Promise<void>;
  /** demo data for the seed script (optional, synthetic only) */
  demoSeed?: (ctx: TenantTxContext, run: (command: string, input: unknown, opts?: { origin?: EventOrigin; at?: Date }) => Promise<CommandResult>) => Promise<void>;
  /** remove all of this tenant's data for the app */
  purge: (ctx: TenantTxContext) => Promise<void>;
  /** cheap check that the app's storage is usable for this tenant */
  health: (ctx: TenantTxContext) => Promise<{ ok: boolean; detail?: string }>;
  /** read models the SPA needs beyond list/detail, e.g. POS registers; each guarded by a permission */
  queries?: Record<
    string,
    {
      permission: string;
      run: (ctx: TenantTxContext & { config: Record<string, unknown> }, params: Record<string, string>) => Promise<unknown>;
    }
  >;
  /** public inbound endpoints (e.g. carrier webhooks): name -> handler that returns a command to run */
  inbound?: Record<
    string,
    {
      /** verify the request (e.g. shared token) inside the tenant transaction */
      verify: (ctx: TenantTxContext, req: InboundRequest) => Promise<boolean>;
      toCommand: (req: InboundRequest) => { command: string; input: unknown; idempotencyKey?: string };
    }
  >;
}

/**
 * Optimistic concurrency: update a row only if its `version` matches.
 * 404 when the row does not exist, 409 when the version moved on.
 */
export async function updateVersioned(
  tx: Tx,
  table: string,
  id: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
  opts: { touch?: boolean } = { touch: true },
): Promise<Record<string, any>> {
  const set: Record<string, unknown> = { ...patch, version: sql`version + 1` };
  if (opts.touch !== false) set.updated_at = new Date();
  const row = await tx
    .updateTable(table)
    .set(set)
    .where('id', '=', id)
    .where('version', '=', expectedVersion)
    .returningAll()
    .executeTakeFirst();
  if (row) return row;
  const current = await tx.selectFrom(table).select(['version']).where('id', '=', id).executeTakeFirst();
  if (!current) throw notFound(table);
  throw new CommandError(409, 'version_conflict', `expected version ${expectedVersion}, current version is ${current.version}`);
}

export const money = (n: unknown): number => Math.round(Number(n) * 100) / 100;
