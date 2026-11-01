import { CommandError, SyncInbound } from '@aod/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientCredentialsGrant, resolveBearer, type BearerContext } from '../../auth/apiauth.ts';
import { activeApps, executeCommand } from '../../platform/commands.ts';
import type { Platform } from '../../platform/context.ts';
import { applyInbound } from '../../platform/hub.ts';
import { buildOpenApi } from '../../platform/openapi.ts';
import { executeRecordWrite, getRecord, listRecords } from '../../platform/records.ts';
import { getEntity, listEntity } from '../../platform/workspace.ts';
import { correlationId, parse } from '../app.ts';

/**
 * Public API. Bearer credentials only (API key, OAuth access token, delegated token);
 * cookies are ignored here. Every call runs as a scoped principal through the same
 * authorize(), RLS, idempotency, outbox and audit paths as the SPA.
 */

const UUID = z.uuid();
const requireScope = (b: BearerContext, scope: string) => {
  if (!b.scopes.includes(scope)) throw new CommandError(403, 'insufficient_scope', `this token lacks the ${scope} scope`);
};
const listQuery = (q: Record<string, string>) => {
  const filters: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(q)) if (k.startsWith('f.') && v) filters[k.slice(2)] = v.split(',').slice(0, 20);
  const base = parse(z.object({ q: z.string().max(200).optional(), sort: z.string().max(60).optional(), cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), { q: q.q, sort: q.sort, cursor: q.cursor, limit: q.limit });
  return { ...base, filters } as any;
};

export function v1Routes(p: Platform) {
  return async function (app: FastifyInstance) {
    const bearer = (req: FastifyRequest) => resolveBearer(p, req.headers.authorization);

    /** RFC 6749 client credentials. Accepts form or JSON, client auth by Basic or body. */
    app.post('/v1/oauth/token', async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, string>;
      let clientId = body.client_id;
      let clientSecret = body.client_secret;
      const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8') : null;
      if (basic) {
        const i = basic.indexOf(':');
        clientId = decodeURIComponent(basic.slice(0, i));
        clientSecret = decodeURIComponent(basic.slice(i + 1));
      }
      reply.header('cache-control', 'no-store');
      if (body.grant_type !== 'client_credentials') return reply.code(400).send({ error: 'unsupported_grant_type', error_description: 'only client_credentials is supported' });
      try {
        return await clientCredentialsGrant(p, clientId ?? '', clientSecret ?? '', body.scope);
      } catch (e: any) {
        if (e?.oauth) return reply.code(e.status).send({ error: e.code, error_description: e.message });
        throw e;
      }
    });

    app.get('/v1/openapi.json', async (req) => {
      const b = await bearer(req);
      return p.database.withTenant(b.tenantId, async (tx) => {
        const t = await tx.selectFrom('tenant').select(['slug', 'name']).executeTakeFirstOrThrow();
        return buildOpenApi(p, tx, t);
      });
    });

    const activeAppOr404 = async (tenantId: string, appId: string) =>
      p.database.withTenant(tenantId, async (tx) => {
        if (!(await activeApps(tx)).includes(appId)) throw new CommandError(404, 'not_found', `${appId} is not active`);
      });

    app.get('/v1/apps/:app/:entity', async (req) => {
      const b = await bearer(req);
      requireScope(b, 'apps:read');
      const { app: appId, entity } = req.params as { app: string; entity: string };
      await activeAppOr404(b.tenantId, appId);
      return p.database.withTenant(b.tenantId, (tx) => listEntity(p, tx, b.principal, appId, entity, listQuery(req.query as Record<string, string>)));
    });

    app.get('/v1/apps/:app/:entity/:id', async (req) => {
      const b = await bearer(req);
      requireScope(b, 'apps:read');
      const { app: appId, entity, id } = req.params as { app: string; entity: string; id: string };
      await activeAppOr404(b.tenantId, appId);
      return p.database.withTenant(b.tenantId, (tx) => getEntity(p, tx, b.principal, appId, entity, id));
    });

    app.post('/v1/apps/:app/commands/:command', async (req, reply) => {
      const b = await bearer(req);
      requireScope(b, 'apps:write');
      const { app: appId, command } = req.params as { app: string; command: string };
      const key = req.headers['idempotency-key'];
      const r = await executeCommand(p, { tenantId: b.tenantId, principal: b.principal, app: appId, command, input: req.body ?? {}, idempotencyKey: typeof key === 'string' ? key : undefined, origin: 'integration', correlationId: correlationId(req) });
      if (r.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(r.status).send(r.body);
    });

    app.get('/v1/records/:entity', async (req) => {
      const b = await bearer(req);
      requireScope(b, 'records:read');
      const { entity } = req.params as { entity: string };
      const r = await p.database.withTenant(b.tenantId, (tx) => listRecords(p, tx, b.principal, entity, listQuery(req.query as Record<string, string>)));
      return { items: r.items, nextCursor: r.nextCursor };
    });

    app.get('/v1/records/:entity/:id', async (req) => {
      const b = await bearer(req);
      requireScope(b, 'records:read');
      const { entity, id } = req.params as { entity: string; id: string };
      const r = await p.database.withTenant(b.tenantId, (tx) => getRecord(p, tx, b.principal, entity, id));
      return { item: r.item };
    });

    const write = async (req: FastifyRequest, reply: any, op: 'create' | 'update' | 'delete') => {
      const b = await bearer(req);
      requireScope(b, 'records:write');
      const { entity, id } = req.params as { entity: string; id?: string };
      const body = op === 'delete' ? { version: Number((req.query as { version?: string }).version) || undefined } : parse(z.object({ values: z.record(z.string(), z.unknown()), version: z.int().positive().optional() }), req.body);
      const key = req.headers['idempotency-key'];
      const r = await executeRecordWrite(p, {
        tenantId: b.tenantId,
        principal: b.principal,
        entity,
        op,
        ...(id ? { id: parse(UUID, id) } : {}),
        ...(body.version ? { version: body.version } : {}),
        ...('values' in body ? { values: body.values } : {}),
        idempotencyKey: typeof key === 'string' ? key : undefined,
        origin: 'integration',
        correlationId: correlationId(req),
      });
      if (r.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(r.status).send(r.body);
    };
    app.post('/v1/records/:entity', (req, reply) => write(req, reply, 'create'));
    app.patch('/v1/records/:entity/:id', (req, reply) => write(req, reply, 'update'));
    app.delete('/v1/records/:entity/:id', (req, reply) => write(req, reply, 'delete'));

    /** Two-way sync: changes pushed by the remote system. */
    app.post('/v1/sync/:syncId', async (req) => {
      const b = await bearer(req);
      requireScope(b, 'sync:write');
      const syncId = parse(UUID, (req.params as { syncId: string }).syncId);
      const change = parse(SyncInbound, req.body);
      return applyInbound(p, b.tenantId, b.principal, syncId, change, change.external_id.slice(0, 80));
    });
  };
}
