import { API_SCOPES, ApiKeyInput, CommandError, DelegatedTokenInput, OAuthClientInput } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { createApiKey, createDelegatedToken, createOAuthClient } from '../../auth/apiauth.ts';
import type { Platform } from '../../platform/context.ts';
import { recordChange } from '../../platform/record.ts';
import { correlationId, parse, requireAuth, requirePermission } from '../app.ts';

const UUID = z.uuid();

export function apiKeyRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    app.get('/api/api-access', async (req) => {
      const a = requirePermission(req, 'platform:apikeys.manage');
      return p.database.withTenant(a.tenantId, async (tx) => ({
        scopes: API_SCOPES,
        keys: await tx.selectFrom('api_key').select(['id', 'name', 'hint', 'scopes', 'created_at', 'last_used_at', 'expires_at', 'revoked_at']).orderBy('created_at', 'desc').execute(),
        clients: (await tx.selectFrom('oauth_client').select(['id', 'name', 'scopes', 'created_at', 'revoked_at']).orderBy('created_at', 'desc').execute()).map((c) => ({ ...c, client_id: `aod_client.${a.tenantId}.${c.id}` })),
        tokenUrl: `${p.env.PUBLIC_URL}/v1/oauth/token`,
        openapiUrl: `${p.env.PUBLIC_URL}/v1/openapi.json`,
      }));
    });

    app.post('/api/api-keys', async (req, reply) => {
      const a = requirePermission(req, 'platform:apikeys.manage');
      const input = parse(ApiKeyInput, req.body);
      return reply.code(201).send(await p.database.withTenant(a.tenantId, (tx) => createApiKey(p, tx, a.tenantId, a.principal, input, correlationId(req))));
    });

    app.post('/api/oauth-clients', async (req, reply) => {
      const a = requirePermission(req, 'platform:apikeys.manage');
      const input = parse(OAuthClientInput, req.body);
      return reply.code(201).send(await p.database.withTenant(a.tenantId, (tx) => createOAuthClient(p, tx, a.tenantId, a.principal, input, correlationId(req))));
    });

    app.post('/api/api-access/:kind/:id/revoke', async (req) => {
      const a = requirePermission(req, 'platform:apikeys.manage');
      const { kind, id } = req.params as { kind: string; id: string };
      const table = kind === 'keys' ? 'api_key' : kind === 'clients' ? 'oauth_client' : null;
      if (!table) throw new CommandError(404, 'not_found', 'not found');
      await p.database.withTenant(a.tenantId, async (tx) => {
        await tx.updateTable(table).set({ revoked_at: sql`now()` }).where('id', '=', parse(UUID, id)).where('revoked_at', 'is', null).execute();
        if (table === 'oauth_client') await tx.updateTable('access_token').set({ revoked_at: sql`now()` }).where('client_id', '=', id).where('revoked_at', 'is', null).execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: `platform:${table}.revoked`, resourceType: 'platform::Credential', resourceId: id, correlationId: correlationId(req) });
      });
      return { ok: true };
    });

    /** Delegated tokens: any signed-in user can issue one for themselves, never beyond their own permissions. */
    app.get('/api/tokens', async (req) => {
      const a = requireAuth(req);
      return p.database.withTenant(a.tenantId, async (tx) => ({
        tokens: await tx.selectFrom('access_token').select(['id', 'name', 'scopes', 'created_at', 'expires_at', 'revoked_at']).where('kind', '=', 'delegated').where('user_id', '=', a.user.id).orderBy('created_at', 'desc').limit(50).execute(),
        scopes: API_SCOPES,
      }));
    });

    app.post('/api/tokens', async (req, reply) => {
      const a = requireAuth(req);
      const input = parse(DelegatedTokenInput, req.body);
      return reply.code(201).send(await p.database.withTenant(a.tenantId, (tx) => createDelegatedToken(p, tx, a.tenantId, a.principal, input, correlationId(req))));
    });

    app.post('/api/tokens/:id/revoke', async (req) => {
      const a = requireAuth(req);
      const id = parse(UUID, (req.params as { id: string }).id);
      await p.database.withTenant(a.tenantId, (tx) => tx.updateTable('access_token').set({ revoked_at: sql`now()` }).where('id', '=', id).where('user_id', '=', a.user.id).execute());
      return { ok: true };
    });
  };
}
