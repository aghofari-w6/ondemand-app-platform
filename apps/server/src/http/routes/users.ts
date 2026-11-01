import { ChangeRoleInput, CommandError, CustomRoleInput, InviteInput, presetPermissions, ROLE_PRESETS, SetPasswordInput, SsoConfigInput } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { hashPassword } from '../../auth/crypto.ts';
import { isPreset, resolveRole } from '../../auth/principal.ts';
import { createLoginToken } from '../../auth/sessions.ts';
import { newId, type Tx } from '../../db/database.ts';
import type { Platform } from '../../platform/context.ts';
import { recordChange } from '../../platform/record.ts';
import { correlationId, parse, requireAuth, requirePermission } from '../app.ts';

async function assertRoleExists(tx: Tx, role: string) {
  if (isPreset(role)) return;
  const r = await tx.selectFrom('custom_role').select('id').where('id', '=', role).executeTakeFirst();
  if (!r) throw new CommandError(422, 'unknown_role', 'unknown role');
}

export function userRoutes(p: Platform) {
  const groupCatalog = (granted: Set<string> | 'all') => {
    const groups = new Map<string, { app: string; label: string; permissions: { id: string; label: string; level: string; granted: boolean; ownerOnly: boolean }[] }>();
    for (const perm of p.catalog.permissions) {
      const app = perm.id.split(':')[0]!;
      const label = app === 'platform' ? 'Platform' : (p.catalog.get(app)?.manifest.name ?? app);
      const g = groups.get(app) ?? { app, label, permissions: [] };
      g.permissions.push({ id: perm.id, label: perm.label, level: perm.level, ownerOnly: perm.ownerOnly === true, granted: granted === 'all' || granted.has(perm.id) });
      groups.set(app, g);
    }
    return [...groups.values()];
  };

  return async function (app: FastifyInstance) {
    app.get('/api/users', async (req) => {
      const a = requirePermission(req, 'platform:users.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const users = await tx.selectFrom('app_user').select(['id', 'email', 'name', 'role', 'status', 'last_login_at', 'created_at', 'version']).orderBy('created_at').execute();
        const roles = await tx.selectFrom('custom_role').select(['id', 'name']).execute();
        const names = new Map(roles.map((r) => [r.id, r.name]));
        return { users: users.map((u) => ({ ...u, role_name: isPreset(u.role) ? u.role : (names.get(u.role) ?? 'Unknown role') })) };
      });
    });

    app.post('/api/users/invite', async (req, reply) => {
      const a = requirePermission(req, 'platform:users.manage');
      const input = parse(InviteInput, req.body);
      if (input.role === 'Owner' && a.principal.roles[0]?.preset !== 'Owner') throw new CommandError(403, 'forbidden', 'only an Owner can invite an Owner');
      const r = await p.database.withTenant(a.tenantId, async (tx) => {
        await assertRoleExists(tx, input.role);
        const exists = await tx.selectFrom('app_user').select('id').where('email', '=', input.email).executeTakeFirst();
        if (exists) throw new CommandError(409, 'user_exists', `${input.email} is already a member`);
        const id = newId();
        await tx.insertInto('app_user').values({ id, tenant_id: a.tenantId, email: input.email, name: input.name, role: input.role, status: 'invited' }).execute();
        const token = await createLoginToken(tx, a.tenantId, id, 'invite');
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:user.invited', resourceType: 'platform::User', resourceId: id, correlationId: correlationId(req), events: [{ type: 'user.invited', data: { user_id: id, role: input.role } }] });
        return { id, token };
      });
      const delivery = await p.ports.channel.send({
        tenantId: a.tenantId,
        to: input.email,
        subject: `${a.user.name} invited you to ${a.tenant.name}`,
        body: 'Accept the invitation to join the workspace (valid 7 days).',
        link: `${p.env.PUBLIC_URL}/auth/verify?token=${encodeURIComponent(r.token)}`,
      });
      return reply.code(201).send({ id: r.id, delivery });
    });

    app.patch('/api/users/:id/role', async (req) => {
      const a = requirePermission(req, 'platform:users.manage');
      const { id } = req.params as { id: string };
      const input = parse(ChangeRoleInput, req.body);
      return p.database.withTenant(a.tenantId, async (tx) => {
        await assertRoleExists(tx, input.role);
        // Lock all Owners so two concurrent demotions cannot both pass the guard.
        const owners = await tx.selectFrom('app_user').select(['id']).where('role', '=', 'Owner').where('status', '<>', 'disabled').forUpdate().execute();
        const u = await tx.selectFrom('app_user').select(['role', 'version']).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!u) throw new CommandError(404, 'not_found', 'user not found');
        if (u.version !== input.version) throw new CommandError(409, 'version_conflict', `expected version ${input.version}, current version is ${u.version}`);
        const isOwner = a.principal.roles[0]?.preset === 'Owner';
        if ((u.role === 'Owner' || input.role === 'Owner') && !isOwner) throw new CommandError(403, 'forbidden', 'only an Owner can grant or remove the Owner role');
        if (u.role === 'Owner' && input.role !== 'Owner' && owners.length <= 1) {
          throw new CommandError(409, 'last_owner', 'a workspace needs at least one Owner; make someone else Owner first');
        }
        const row = await tx.updateTable('app_user').set({ role: input.role, version: sql`version + 1` }).where('id', '=', id).returning('version').executeTakeFirstOrThrow();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:user.role_changed', resourceType: 'platform::User', resourceId: id, correlationId: correlationId(req), events: [{ type: 'user.role_changed', data: { user_id: id, from: u.role, to: input.role } }] });
        return { id, version: row.version, role: input.role };
      });
    });

    app.post('/api/users/:id/status', async (req) => {
      const a = requirePermission(req, 'platform:users.manage');
      const { id } = req.params as { id: string };
      const { status } = parse(z.object({ status: z.enum(['active', 'disabled']) }), req.body);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const owners = await tx.selectFrom('app_user').select('id').where('role', '=', 'Owner').where('status', '<>', 'disabled').forUpdate().execute();
        const u = await tx.selectFrom('app_user').select(['role', 'status']).where('id', '=', id).executeTakeFirst();
        if (!u) throw new CommandError(404, 'not_found', 'user not found');
        if (status === 'disabled' && u.role === 'Owner' && owners.length <= 1) throw new CommandError(409, 'last_owner', 'you cannot disable the last Owner');
        await tx.updateTable('app_user').set({ status, version: sql`version + 1` }).where('id', '=', id).execute();
        if (status === 'disabled') await tx.updateTable('user_session').set({ revoked_at: new Date() }).where('user_id', '=', id).where('revoked_at', 'is', null).execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: `platform:user.${status}`, resourceType: 'platform::User', resourceId: id, correlationId: correlationId(req), events: [{ type: 'user.status_changed', data: { user_id: id, status } }] });
        return { ok: true };
      });
    });

    // ------------------------------------------------------------ roles

    app.get('/api/permissions', async (req) => {
      requirePermission(req, 'platform:users.read');
      return { groups: groupCatalog(new Set()) };
    });

    app.get('/api/roles', async (req) => {
      const a = requirePermission(req, 'platform:users.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const custom = await tx.selectFrom('custom_role').select(['id', 'name', 'description', 'permissions', 'field_rules', 'version']).orderBy('name').execute();
        const counts = await tx.selectFrom('app_user').select(['role', sql<number>`count(*)`.as('n')]).groupBy('role').execute();
        const n = new Map(counts.map((c) => [c.role, Number(c.n)]));
        return {
          presets: ROLE_PRESETS.map((r) => ({ id: r, name: r, permissions: presetPermissions(r, p.catalog.permissions), members: n.get(r) ?? 0 })),
          custom: custom.map((c) => ({ ...c, members: n.get(c.id) ?? 0 })),
        };
      });
    });

    /** Role preview: the permission catalog with what the role would grant. */
    app.get('/api/roles/preview', async (req) => {
      const a = requirePermission(req, 'platform:users.read');
      const { role } = parse(z.object({ role: z.string().min(1) }), req.query);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const r = await resolveRole(tx, p.catalog, role);
        if (!r) throw new CommandError(404, 'unknown_role', 'unknown role');
        return { role: r.name, preset: r.preset, groups: groupCatalog(r.preset === 'Owner' ? 'all' : new Set(r.permissions)), fieldRules: r.fieldRules };
      });
    });

    const validatePerms = (perms: string[]) => {
      const known = new Map(p.catalog.permissions.map((x) => [x.id, x]));
      const bad = perms.filter((x) => !known.has(x) || known.get(x)!.ownerOnly);
      if (bad.length) throw new CommandError(422, 'unknown_permission', `cannot grant: ${bad.join(', ')}`);
    };

    app.post('/api/roles', async (req, reply) => {
      const a = requirePermission(req, 'platform:roles.manage');
      const input = parse(CustomRoleInput, req.body);
      validatePerms(input.permissions);
      if (isPreset(input.name)) throw new CommandError(409, 'reserved', `${input.name} is a preset role name`);
      const id = await p.database.withTenant(a.tenantId, async (tx) => {
        const id = newId();
        await tx.insertInto('custom_role').values({ id, tenant_id: a.tenantId, name: input.name, description: input.description, permissions: input.permissions, field_rules: JSON.stringify(input.fieldRules) }).execute().catch((e) => {
          if (e?.code === '23505') throw new CommandError(409, 'role_exists', `a role named ${input.name} exists`);
          throw e;
        });
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:role.created', resourceType: 'platform::Role', resourceId: id, correlationId: correlationId(req), events: [{ type: 'role.created', data: { role_id: id, name: input.name, permissions: input.permissions.length } }] });
        return id;
      });
      return reply.code(201).send({ id, version: 1 });
    });

    app.put('/api/roles/:id', async (req) => {
      const a = requirePermission(req, 'platform:roles.manage');
      const { id } = req.params as { id: string };
      const input = parse(CustomRoleInput.extend({ version: z.int().positive() }), req.body);
      validatePerms(input.permissions);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const row = await tx
          .updateTable('custom_role')
          .set({ name: input.name, description: input.description, permissions: input.permissions, field_rules: JSON.stringify(input.fieldRules), version: sql`version + 1` })
          .where('id', '=', id)
          .where('version', '=', input.version)
          .returning('version')
          .executeTakeFirst();
        if (!row) {
          const exists = await tx.selectFrom('custom_role').select('version').where('id', '=', id).executeTakeFirst();
          throw exists ? new CommandError(409, 'version_conflict', `expected version ${input.version}, current version is ${exists.version}`) : new CommandError(404, 'not_found', 'role not found');
        }
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:role.updated', resourceType: 'platform::Role', resourceId: id, correlationId: correlationId(req), events: [{ type: 'role.updated', data: { role_id: id } }] });
        return { id, version: row.version };
      });
    });

    // ------------------------------------------------------------ SSO + Owner password

    app.get('/api/sso', async (req) => {
      const a = requirePermission(req, 'platform:settings.manage');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const row = await tx.selectFrom('sso_config').selectAll().executeTakeFirst();
        const ownerPw = await tx.selectFrom('app_user').select('id').where('id', '=', a.user.id).where('password_hash', 'is not', null).executeTakeFirst();
        return {
          config: row ? { kind: row.kind, ...(row.config as object), enforce: row.enforce, hasSecret: Boolean(row.secret_enc), lastTestAt: row.last_test_at, lastTestResult: row.last_test_result, version: row.version } : null,
          callbackUrls: { oidc: `${p.env.PUBLIC_URL}/api/auth/oidc/callback`, saml: `${p.env.PUBLIC_URL}/api/auth/saml/callback`, samlEntityId: `${p.env.PUBLIC_URL}/saml/${a.tenant.slug}` },
          ownerPasswordSet: Boolean(ownerPw),
        };
      });
    });

    app.put('/api/sso', async (req) => {
      const a = requirePermission(req, 'platform:settings.manage');
      const input = parse(SsoConfigInput, req.body);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const prev = await tx.selectFrom('sso_config').select(['secret_enc', 'kind']).executeTakeFirst();
        const { kind, enforce, ...rest } = input;
        let secretEnc: string | null = null;
        const cfg: Record<string, unknown> = { ...rest };
        if (input.kind === 'oidc') {
          delete cfg.clientSecret;
          // Write-only secret: encrypted with the Vault port; omitted on update keeps the old one.
          secretEnc = input.clientSecret ? p.ports.vault.encrypt(input.clientSecret, `sso:${a.tenantId}`) : prev?.kind === 'oidc' ? prev.secret_enc : null;
        }
        if (enforce) {
          const owner = await tx.selectFrom('app_user').select('id').where('role', '=', 'Owner').where('password_hash', 'is not', null).executeTakeFirst();
          if (!owner) throw new CommandError(409, 'owner_password_required', 'set an Owner password first so you cannot be locked out');
        }
        await tx
          .insertInto('sso_config')
          .values({ tenant_id: a.tenantId, kind, config: JSON.stringify(cfg), secret_enc: secretEnc, enforce })
          .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ kind, config: JSON.stringify(cfg), secret_enc: secretEnc, enforce, version: sql`sso_config.version + 1`, updated_at: new Date() }))
          .execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:sso.configured', resourceType: 'platform::SsoConfig', resourceId: a.tenantId, correlationId: correlationId(req), events: [{ type: 'sso.configured', data: { kind, enforce } }] });
        return { ok: true };
      });
    });

    app.delete('/api/sso', async (req) => {
      const a = requirePermission(req, 'platform:settings.manage');
      await p.database.withTenant(a.tenantId, async (tx) => {
        await tx.deleteFrom('sso_config').execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:sso.removed', resourceType: 'platform::SsoConfig', resourceId: a.tenantId, correlationId: correlationId(req) });
      });
      return { ok: true };
    });

    app.post('/api/me/password', async (req) => {
      const a = requireAuth(req);
      if (a.principal.roles[0]?.preset !== 'Owner') throw new CommandError(403, 'forbidden', 'password sign-in is the Owner fallback only');
      const { password } = parse(SetPasswordInput, req.body);
      const hash = await hashPassword(password);
      await p.database.withTenant(a.tenantId, async (tx) => {
        await tx.updateTable('app_user').set({ password_hash: hash, version: sql`version + 1` }).where('id', '=', a.user.id).execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:user.password_set', resourceType: 'platform::User', resourceId: a.user.id, correlationId: correlationId(req) });
      });
      return { ok: true };
    });
  };
}
