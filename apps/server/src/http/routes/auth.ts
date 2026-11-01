import { CommandError, LoginInput, PasswordLoginInput, presetPermissions, SignupInput } from '@aod/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { randomToken, verifyPassword } from '../../auth/crypto.ts';
import { consumeLoginToken, createLoginToken, createSession, revokeSession, SESSION_COOKIE, splitToken } from '../../auth/sessions.ts';
import { newId, type Tx } from '../../db/database.ts';
import type { Platform } from '../../platform/context.ts';
import { recordChange } from '../../platform/record.ts';
import { signup } from '../../platform/tenants.ts';
import { correlationId, parse, requireAuth, setSessionCookie } from '../app.ts';

async function resolveTenant(p: Platform, slug: string) {
  const r = await sql<{ id: string; status: string; name: string }>`SELECT * FROM resolve_tenant(${slug})`.execute(p.database.db);
  return r.rows[0] ?? null;
}

export async function ssoSettings(p: Platform, tx: Tx, tenantId: string) {
  const row = await tx.selectFrom('sso_config').selectAll().executeTakeFirst();
  if (!row) return null;
  const cfg = row.config as Record<string, string>;
  const secret = row.secret_enc ? p.ports.vault.decrypt(row.secret_enc, `sso:${tenantId}`) : undefined;
  return { kind: row.kind as 'oidc' | 'saml', enforce: row.enforce as boolean, cfg, secret };
}

export function authRoutes(p: Platform) {
  const link = (path: string) => `${p.env.PUBLIC_URL}${path}`;

  return async function (app: FastifyInstance) {
    app.post('/api/auth/signup', async (req, reply) => {
      const input = parse(SignupInput, req.body);
      const r = await signup(p, input, correlationId(req));
      const delivery = await p.ports.channel.send({
        tenantId: r.tenantId,
        to: input.email,
        subject: `Sign in to ${input.workspaceName}`,
        body: 'Use this link to finish creating your workspace.',
        link: link(`/auth/verify?token=${encodeURIComponent(r.token)}`),
      });
      return reply.code(201).send({ tenant: { id: r.tenantId, slug: input.slug }, delivery });
    });

    app.post('/api/auth/login', async (req) => {
      const input = parse(LoginInput, req.body);
      const t = await resolveTenant(p, input.slug);
      if (!t || t.status === 'deleted') return { sent: true, delivery: null };
      return p.database.withTenant(t.id, async (tx) => {
        const u = await tx.selectFrom('app_user').select(['id', 'role', 'status']).where('email', '=', input.email).executeTakeFirst();
        if (!u || u.status === 'disabled') return { sent: true, delivery: null };
        const sso = await tx.selectFrom('sso_config').select(['enforce']).executeTakeFirst();
        if (sso?.enforce && u.role !== 'Owner') {
          throw Object.assign(new CommandError(409, 'sso_required', 'this workspace signs in with single sign-on'), { details: { start: `/api/auth/sso/${input.slug}/start` } });
        }
        const token = await createLoginToken(tx, t.id, u.id, 'magic');
        const delivery = await p.ports.channel.send({ tenantId: t.id, to: input.email, subject: `Sign in to ${t.name}`, body: 'Your sign-in link (valid 15 minutes).', link: link(`/auth/verify?token=${encodeURIComponent(token)}`) });
        return { sent: true, delivery };
      });
    });

    app.post('/api/auth/verify', async (req, reply) => {
      const { token } = parse(z.object({ token: z.string().max(200) }), req.body);
      const t = splitToken(token);
      if (!t) throw new CommandError(400, 'invalid_token', 'this link is invalid or has expired');
      const session = await p.database.withTenant(t.tenantId, async (tx) => {
        const used = await consumeLoginToken(tx, t.secret);
        if (!used) return null;
        const tenant = await tx.selectFrom('tenant').select('status').executeTakeFirst();
        if (!tenant || tenant.status === 'deleted') return null;
        const s = await createSession(tx, t.tenantId, used.userId, used.purpose === 'invite' ? 'invite' : 'magic_link');
        await recordChange(p, tx, { tenantId: t.tenantId, actor: { type: 'User', id: used.userId }, action: 'platform:session.created', resourceType: 'platform::User', resourceId: used.userId, correlationId: correlationId(req), data: { method: used.purpose } });
        return s;
      });
      if (!session) throw new CommandError(400, 'invalid_token', 'this link is invalid or has expired');
      setSessionCookie(p, reply, session.cookie, session.expiresAt);
      return { ok: true };
    });

    app.post('/api/auth/password', async (req, reply) => {
      const input = parse(PasswordLoginInput, req.body);
      const t = await resolveTenant(p, input.slug);
      const fail = () => new CommandError(401, 'invalid_credentials', 'wrong workspace, email or password');
      if (!t || t.status === 'deleted') throw fail();
      const session = await p.database.withTenant(t.id, async (tx) => {
        const u = await tx.selectFrom('app_user').select(['id', 'role', 'status', 'password_hash']).where('email', '=', input.email).executeTakeFirst();
        // Password sign-in is the Owner's fallback when SSO is misconfigured.
        if (!u || u.role !== 'Owner' || u.status === 'disabled' || !(await verifyPassword(input.password, u.password_hash))) return null;
        const s = await createSession(tx, t.id, u.id, 'password');
        await recordChange(p, tx, { tenantId: t.id, actor: { type: 'User', id: u.id }, action: 'platform:session.created', resourceType: 'platform::User', resourceId: u.id, correlationId: correlationId(req), data: { method: 'password' } });
        return s;
      });
      if (!session) throw fail();
      setSessionCookie(p, reply, session.cookie, session.expiresAt);
      return { ok: true };
    });

    app.post('/api/auth/logout', async (req, reply) => {
      await revokeSession(p.database, req.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/api/auth/me', async (req) => {
      const a = requireAuth(req);
      const role = a.principal.roles[0];
      const permissions = role?.preset === 'Owner' ? presetPermissions('Owner', p.catalog.permissions) : (role?.permissions ?? []);
      return {
        user: a.user,
        tenant: a.tenant,
        role: role ? { name: role.name, preset: role.preset } : null,
        permissions,
        fieldRules: role?.fieldRules ?? [],
        demoMode: p.env.DEMO_MODE,
      };
    });

    // ---------------------------------------------------------------- SSO

    async function startSso(tenantId: string, slug: string, isTest: boolean) {
      return p.database.withTenant(tenantId, async (tx) => {
        const s = await ssoSettings(p, tx, tenantId);
        if (!s) throw new CommandError(404, 'sso_not_configured', 'single sign-on is not configured');
        const state = `${tenantId}.${randomToken(18)}`;
        const nonce = randomToken(18);
        const codeVerifier = randomToken(32);
        await tx.insertInto('sso_attempt').values({ id: newId(), tenant_id: tenantId, kind: s.kind, state, code_verifier: codeVerifier, nonce, is_test: isTest }).execute();
        if (s.kind === 'oidc') {
          return p.ports.auth.oidcAuthorizationUrl(
            { issuer: s.cfg.issuer!, clientId: s.cfg.clientId!, ...(s.secret ? { clientSecret: s.secret } : {}) },
            { redirectUri: link('/api/auth/oidc/callback'), state, nonce, codeVerifier },
          );
        }
        return p.ports.auth.samlAuthorizationUrl(
          { entryPoint: s.cfg.entryPoint!, idpIssuer: s.cfg.idpIssuer!, idpCert: s.cfg.idpCert!, spIssuer: link(`/saml/${slug}`) },
          { callbackUrl: link('/api/auth/saml/callback'), relayState: state },
        );
      });
    }

    app.get('/api/auth/sso/:slug/start', async (req, reply) => {
      const { slug } = req.params as { slug: string };
      const t = await resolveTenant(p, slug);
      if (!t || t.status === 'deleted') throw new CommandError(404, 'not_found', 'workspace not found');
      return reply.redirect(await startSso(t.id, slug, false));
    });

    /** "Test sign-in" from Settings: same flow, but the result is recorded instead of signing in. */
    app.post('/api/sso/test', async (req) => {
      const a = requireAuth(req);
      return { url: await startSso(a.tenantId, a.tenant.slug, true) };
    });

    async function finishSso(reply: FastifyReply, state: string, identify: (tenantId: string, attempt: { code_verifier: string; nonce: string }, slug: string) => Promise<{ email: string }>, cid: string) {
      const t = splitToken(state);
      if (!t) throw new CommandError(400, 'invalid_state', 'invalid sign-in state');
      const attempt = await p.database.withTenant(t.tenantId, async (tx) => {
        const a = await tx.updateTable('sso_attempt').set({ used_at: new Date() }).where('state', '=', state).where('used_at', 'is', null).where('created_at', '>', sql<Date>`now() - interval '10 minutes'`).returningAll().executeTakeFirst();
        const slug = (await tx.selectFrom('tenant').select('slug').executeTakeFirst())?.slug as string;
        return a ? ({ ...(a as Record<string, any>), slug } as { kind: string; is_test: boolean; code_verifier: string; nonce: string; slug: string }) : null;
      });
      if (!attempt) throw new CommandError(400, 'invalid_state', 'this sign-in attempt expired; start again');
      let email: string;
      try {
        ({ email } = await identify(t.tenantId, attempt, attempt.slug));
      } catch (e) {
        if (attempt.is_test) {
          await p.database.withTenant(t.tenantId, (tx) => tx.updateTable('sso_config').set({ last_test_at: new Date(), last_test_result: `failed: ${(e as Error).message}` }).execute());
          return reply.redirect('/settings?sso_test=failed');
        }
        throw new CommandError(401, 'sso_failed', `single sign-on failed: ${(e as Error).message}`);
      }
      const session = await p.database.withTenant(t.tenantId, async (tx) => {
        const u = await tx.selectFrom('app_user').select(['id', 'status']).where('email', '=', email).executeTakeFirst();
        if (attempt.is_test) {
          await tx.updateTable('sso_config').set({ last_test_at: new Date(), last_test_result: u ? `ok: signed in as ${email}` : `identity ok (${email}) but no such user in this workspace` }).execute();
          return 'test';
        }
        if (!u || u.status === 'disabled') return null;
        const s = await createSession(tx, t.tenantId, u.id, 'sso');
        await recordChange(p, tx, { tenantId: t.tenantId, actor: { type: 'User', id: u.id }, action: 'platform:session.created', resourceType: 'platform::User', resourceId: u.id, correlationId: cid, data: { method: attempt.kind } });
        return s;
      });
      if (session === 'test') return reply.redirect('/settings?sso_test=done');
      if (!session) throw new CommandError(403, 'no_user', `${email} is not a member of this workspace`);
      setSessionCookie(p, reply, session.cookie, session.expiresAt);
      return reply.redirect('/');
    }

    app.get('/api/auth/oidc/callback', async (req, reply) => {
      const q = req.query as { state?: string };
      return finishSso(
        reply,
        q.state ?? '',
        async (tenantId, a) => {
          const s = await p.database.withTenant(tenantId, (tx) => ssoSettings(p, tx, tenantId));
          if (!s || s.kind !== 'oidc') throw new Error('OIDC is not configured');
          return p.ports.auth.oidcCallback(
            { issuer: s.cfg.issuer!, clientId: s.cfg.clientId!, ...(s.secret ? { clientSecret: s.secret } : {}) },
            { currentUrl: link(req.url), state: q.state!, nonce: a.nonce, codeVerifier: a.code_verifier },
          );
        },
        correlationId(req),
      );
    });

    app.post('/api/auth/saml/callback', async (req, reply) => {
      const body = req.body as Record<string, string>;
      return finishSso(
        reply,
        body.RelayState ?? '',
        async (tenantId, _a, slug) => {
          const s = await p.database.withTenant(tenantId, (tx) => ssoSettings(p, tx, tenantId));
          if (!s || s.kind !== 'saml') throw new Error('SAML is not configured');
          return p.ports.auth.samlCallback(
            { entryPoint: s.cfg.entryPoint!, idpIssuer: s.cfg.idpIssuer!, idpCert: s.cfg.idpCert!, spIssuer: link(`/saml/${slug}`) },
            { callbackUrl: link('/api/auth/saml/callback'), body },
          );
        },
        correlationId(req),
      );
    });
  };
}
