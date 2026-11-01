import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { action, authorize, CommandError, type Principal } from '@aod/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { principalFor } from '../auth/principal.ts';
import { readSession, SESSION_COOKIE, type SessionUser } from '../auth/sessions.ts';
import { ROOT } from '../config.ts';
import type { Platform } from '../platform/context.ts';
import { appRoutes } from './routes/apps.ts';
import { authRoutes } from './routes/auth.ts';
import { opsRoutes } from './routes/ops.ts';
import { tenantRoutes } from './routes/tenant.ts';
import { userRoutes } from './routes/users.ts';

export interface AuthContext extends SessionUser {
  principal: Principal;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** Parse a body/query with Zod; 422 with the issues on failure. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw Object.assign(new CommandError(422, 'invalid_input', r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')), { details: r.error.issues });
  }
  return r.data;
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new CommandError(401, 'unauthenticated', 'sign in first');
  return req.auth;
}

/** Platform-level permission check (resource = the tenant). */
export function requirePermission(req: FastifyRequest, permission: string): AuthContext {
  const a = requireAuth(req);
  const d = authorize(a.principal, action(permission), { type: 'platform::Tenant', id: a.tenantId, tenantId: a.tenantId });
  if (d.decision === 'deny') throw new CommandError(403, 'forbidden', `missing permission ${permission}`);
  return a;
}

export const correlationId = (req: FastifyRequest) => String(req.id);

export function setSessionCookie(p: Platform, reply: FastifyReply, value: string, expires: Date) {
  reply.setCookie(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: p.env.PUBLIC_URL.startsWith('https://'),
    path: '/',
    expires,
  });
}

export async function buildApp(p: Platform): Promise<FastifyInstance> {
  const app = Fastify({
    logger: p.env.NODE_ENV === 'test' ? false : { level: p.env.LOG_LEVEL },
    genReqId: (req) => {
      const h = req.headers['x-correlation-id'];
      return typeof h === 'string' && /^[A-Za-z0-9_.:-]{8,100}$/.test(h) ? h : randomUUID();
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  await app.register(cookie);
  await app.register(formbody);
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    if (!req.url.startsWith('/api/')) return;
    // CSRF: state-changing API calls must be JSON (forms cannot send it cross-site) and
    // the session cookie is SameSite=Lax.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.url.startsWith('/api/auth/saml/')) {
      const ct = req.headers['content-type'] ?? '';
      if (req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined && !ct.startsWith('application/json')) {
        return reply.code(415).send({ error: 'unsupported_media_type', message: 'use application/json' });
      }
    }
    const s = await readSession(p.database, req.cookies[SESSION_COOKIE]);
    if (s) {
      const principal = await p.database.withTenant(s.tenantId, (tx) => principalFor(tx, p.catalog, s.tenantId, s.user));
      req.auth = { ...s, principal };
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof CommandError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...((err as any).details ? { details: (err as any).details } : {}) });
    }
    if (err?.validation) return reply.code(400).send({ error: 'bad_request', message: err.message });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log?.error({ err }, 'unhandled error');
    p.log.error({ err: String(err?.stack ?? err) }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'something went wrong', correlation_id: req.id });
  });

  await app.register(opsRoutes(p));
  await app.register(authRoutes(p));
  await app.register(tenantRoutes(p));
  await app.register(userRoutes(p));
  await app.register(appRoutes(p));

  const dist = `${ROOT}apps/web/dist`;
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/v1/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found', message: 'not found' });
    });
  }
  return app;
}
