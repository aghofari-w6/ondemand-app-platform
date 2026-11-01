import { CommandError } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Platform } from '../../platform/context.ts';
import { recordChange } from '../../platform/record.ts';
import { changeTenantStatus } from '../../platform/tenants.ts';
import { correlationId, parse, requireAuth, requirePermission } from '../app.ts';

export function tenantRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    // "Hello tenant": everything here is read under RLS for the session's tenant.
    app.get('/api/tenant', async (req) => {
      const a = requireAuth(req);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const t = await tx.selectFrom('tenant').selectAll().executeTakeFirstOrThrow();
        const apps = await tx.selectFrom('installed_app').select(['app', 'version', 'channel', 'status', 'retained_until']).where('status', '<>', 'removed').orderBy('installed_at').execute();
        const users = await tx.selectFrom('app_user').select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow();
        const fields = await tx.selectFrom('field_definition').select(sql<number>`count(*)`.as('n')).executeTakeFirstOrThrow();
        const sso = await tx.selectFrom('sso_config').select('kind').executeTakeFirst();
        const pw = await tx.selectFrom('app_user').select('id').where('role', '=', 'Owner').where('password_hash', 'is not', null).executeTakeFirst();
        const plan = p.ports.billing.plan(t.plan);
        const slotsUsed = apps.filter((x) => ['provisioning', 'active', 'failed', 'deprovisioning'].includes(x.status)).length;
        const active = apps.filter((x) => x.status === 'active').map((x) => x.app);
        const settings = t.settings as { onboarding_dismissed?: boolean; theme?: unknown };
        return {
          tenant: { id: t.id, slug: t.slug, name: t.name, status: t.status, plan: t.plan, planLabel: plan?.label ?? t.plan, trialEndsAt: t.trial_ends_at, purgeAfter: t.purge_after, theme: settings.theme ?? { accent: '#2856D9' }, version: t.version },
          slots: { used: slotsUsed, total: plan?.appSlots ?? 0 },
          apps,
          capabilities: p.config.capabilities.map((c) => ({ ...c, active: p.catalog.activeCapabilities(active).includes(c.id) })),
          onboarding: {
            dismissed: settings.onboarding_dismissed === true,
            steps: [
              { key: 'workspace', label: 'Create your workspace', done: true, to: '/' },
              { key: 'app', label: 'Provision your first app', done: active.length > 0, to: '/catalog' },
              { key: 'invite', label: 'Invite a teammate', done: Number(users.n) > 1, to: '/users' },
              { key: 'signin', label: 'Set up sign-in (SSO or an Owner password)', done: Boolean(sso || pw), to: '/settings' },
              { key: 'field', label: 'Add a custom field', done: Number(fields.n) > 0, to: '/settings' },
            ],
          },
        };
      });
    });

    app.post('/api/tenant/onboarding/dismiss', async (req) => {
      const a = requirePermission(req, 'platform:settings.manage');
      await p.database.withTenant(a.tenantId, (tx) => tx.updateTable('tenant').set({ settings: sql`settings || '{"onboarding_dismissed": true}'::jsonb` }).execute());
      return { ok: true };
    });

    app.patch('/api/tenant/settings', async (req) => {
      const a = requirePermission(req, 'platform:settings.manage');
      const input = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional() }), req.body);
      await p.database.withTenant(a.tenantId, async (tx) => {
        if (input.name) await tx.updateTable('tenant').set({ name: input.name, version: sql`version + 1` }).execute();
        if (input.accent) await tx.updateTable('tenant').set({ settings: sql`jsonb_set(settings, '{theme}', ${JSON.stringify({ accent: input.accent })}::jsonb)` }).execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:tenant.settings', resourceType: 'platform::Tenant', resourceId: a.tenantId, correlationId: correlationId(req), events: [{ type: 'tenant.updated', data: { fields: Object.keys(input) } }] });
      });
      return { ok: true };
    });

    // Lifecycle: trial -> active (choose a plan), suspend, delete (purged after 30 days).
    app.post('/api/tenant/lifecycle', async (req) => {
      const input = parse(z.object({ to: z.enum(['active', 'suspended', 'deleted']), plan: z.string().optional(), confirm: z.string().optional() }), req.body);
      const a = requirePermission(req, input.to === 'deleted' ? 'platform:tenant.delete' : 'platform:billing.manage');
      if (input.to === 'deleted' && input.confirm !== a.tenant.slug) throw new CommandError(422, 'confirm', 'type the workspace address to confirm');
      await p.database.withTenant(a.tenantId, (tx) => changeTenantStatus(p, tx, a.tenantId, input.to, a.principal, correlationId(req), input.plan ? { plan: input.plan } : {}));
      return { ok: true };
    });

    app.get('/api/audit', async (req) => {
      const a = requirePermission(req, 'platform:audit.read');
      const q = parse(z.object({ before: z.iso.datetime({ offset: true }).optional(), action: z.string().max(80).optional() }), req.query);
      return p.database.withTenant(a.tenantId, async (tx) => {
        let qb = tx.selectFrom('audit_log').select(['id', 'at', 'actor_type', 'actor_id', 'action', 'resource_type', 'resource_id', 'correlation_id', 'data']);
        if (q.before) qb = qb.where('at', '<', new Date(q.before));
        if (q.action) qb = qb.where('action', 'like', `%${q.action.replace(/[%_]/g, '')}%`);
        const rows = await qb.orderBy('at', 'desc').orderBy('id', 'desc').limit(50).execute();
        const users = await tx.selectFrom('app_user').select(['id', 'name']).execute();
        const names = new Map(users.map((u) => [u.id, u.name]));
        return { items: rows.map((r) => ({ ...r, actor_name: names.get(r.actor_id) ?? r.actor_id })), next: rows.length === 50 ? new Date(rows[49]!.at).toISOString() : null };
      });
    });
  };
}
