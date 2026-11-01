import { createHash } from 'node:crypto';
import {
  action,
  authorize,
  CommandError,
  type CommandResult,
  type EventDraft,
  type EventOrigin,
  type Principal,
} from '@aod/shared';
import { newId, type Tx } from '../db/database.ts';
import { writeAudit } from './audit.ts';
import type { Platform } from './context.ts';
import { encryptPii, fieldDefinitions, validateCustomValues } from './fields.ts';
import { assertIdempotencyKey, claimIdempotencyKey, storeIdempotentResponse } from './idempotency.ts';
import { writeOutbox } from './outbox.ts';

export interface CommandRequest {
  tenantId: string;
  principal: Principal;
  app: string;
  command: string;
  input: unknown;
  idempotencyKey?: string | undefined;
  origin?: EventOrigin;
  correlationId: string;
  causationId?: string | null;
  /** set when a workflow runs the command (loop protection) */
  workflowHop?: number;
  workflowChain?: string[];
  /** override the clock (demo seed back-dating) */
  now?: () => Date;
}

export interface CommandResponse {
  status: number;
  body: CommandResult;
  replayed: boolean;
}

export const requestHash = (app: string, command: string, input: unknown) =>
  createHash('sha256').update(JSON.stringify([app, command, input])).digest('hex');

/** Tenant must be usable for writes. */
export async function assertWritableTenant(tx: Tx) {
  const t = await tx.selectFrom('tenant').select(['status']).executeTakeFirst();
  if (!t) throw new CommandError(404, 'tenant_not_found', 'workspace not found');
  if (t.status === 'suspended') throw new CommandError(423, 'tenant_suspended', 'this workspace is suspended; upgrade the plan to continue');
  if (t.status === 'deleted') throw new CommandError(410, 'tenant_deleted', 'this workspace was deleted');
}

export async function activeApps(tx: Tx): Promise<string[]> {
  const rows = await tx.selectFrom('installed_app').select('app').where('status', '=', 'active').execute();
  return rows.map((r) => r.app as string);
}

/**
 * The single write path for app commands:
 * tenant + app checks -> authorize -> idempotency -> validate -> handler ->
 * outbox + audit -> store idempotent response. All in one tenant transaction.
 */
export async function executeCommand(p: Platform, req: CommandRequest, existingTx?: Tx): Promise<CommandResponse> {
  const found = p.catalog.command(req.app, req.command);
  if (!found) throw new CommandError(404, 'unknown_command', `unknown command ${req.app}/${req.command}`);
  const { def, spec, entity } = found;
  assertIdempotencyKey(req.idempotencyKey);

  const run = async (tx: Tx): Promise<CommandResponse> => {
    await assertWritableTenant(tx);
    const installed = await tx.selectFrom('installed_app').select(['status', 'config']).where('app', '=', req.app).where('status', '<>', 'removed').executeTakeFirst();
    if (!installed || installed.status !== 'active') throw new CommandError(409, 'app_not_active', `${req.app} is not active in this workspace`);

    const rawId = (req.input as { id?: unknown } | null)?.id;
    const decision = authorize(req.principal, action(def.permission), {
      type: entity.resource,
      id: typeof rawId === 'string' ? rawId : 'new',
      tenantId: req.tenantId,
    });
    if (decision.decision === 'deny') throw new CommandError(403, 'forbidden', `missing permission ${def.permission}`);

    const hash = requestHash(req.app, req.command, req.input);
    if (req.idempotencyKey) {
      const prior = await claimIdempotencyKey(tx, req.tenantId, req.idempotencyKey, `${req.app}/${req.command}`, hash);
      if (prior) return { status: prior.status, body: prior.body, replayed: true };
    }

    const parsed = spec.input.safeParse(req.input);
    if (!parsed.success) {
      throw Object.assign(new CommandError(422, 'invalid_input', parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')), {
        details: parsed.error.issues,
      });
    }

    const manifest = p.catalog.get(req.app)!.manifest;
    const drafts: EventDraft[] = [];
    const now = req.now ?? (() => new Date());
    const result = await p.ports.telemetry.span(`${req.app}.command`, { 'aod.command': req.command, 'aod.tenant': req.tenantId }, () =>
      spec.handle(
        {
          tx,
          tenantId: req.tenantId,
          now,
          newId,
          principal: req.principal,
          decision,
          origin: req.origin ?? 'user',
          config: { ...manifest.config, ...(installed.config as object) },
          emit(d) {
            if (!def.may_emit.includes(d.type)) {
              throw new CommandError(500, 'contract_violation', `${req.command} may not emit ${d.type} (not in may_emit)`);
            }
            drafts.push(d);
          },
          async validateCustom(entityName, values, existing) {
            const ent = p.catalog.entity(req.app, entityName);
            if (!ent?.custom_fields) {
              if (values && Object.keys(values).length) throw new CommandError(422, 'invalid_custom_fields', `${entityName} has no custom fields`);
              return existing ?? {};
            }
            const defs = await fieldDefinitions(tx, req.app, entityName);
            // PII values are encrypted at rest (AES-256-GCM, Vault port).
            return encryptPii(p.ports.vault, req.tenantId, `${req.app}:${entityName}`, defs, validateCustomValues(defs, values, existing));
          },
        },
        parsed.data,
      ),
    );

    const envelopes = await writeOutbox(tx, drafts, {
      tenantId: req.tenantId,
      app: req.app,
      correlationId: req.correlationId,
      causationId: req.causationId ?? null,
      traceparent: p.ports.telemetry.traceparent(),
      origin: req.origin ?? 'user',
      workflowHop: req.workflowHop ?? 0,
      workflowChain: req.workflowChain ?? [],
      now,
      newId,
    });
    await writeAudit(tx, {
      tenantId: req.tenantId,
      actor: req.principal,
      action: `${req.app}:${req.command}`,
      resourceType: entity.resource,
      resourceId: String(result.id),
      correlationId: req.correlationId,
      data: { events: envelopes.map((e) => e.type), input_fields: Object.keys((req.input as object) ?? {}), origin: req.origin ?? 'user' },
    });
    const status = result.duplicate ? 200 : (result.created ?? typeof rawId !== 'string') ? 201 : 200;
    if (req.idempotencyKey) await storeIdempotentResponse(tx, req.idempotencyKey, status, result);
    p.ports.metrics.increment('aod_commands_total', { app: req.app, command: req.command });
    return { status, body: result, replayed: false };
  };

  return existingTx ? run(existingTx) : p.database.withTenant(req.tenantId, run);
}
