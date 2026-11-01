import { CommandError, type Principal, type SignupInput } from '@aod/shared';
import { sql } from 'kysely';
import { createLoginToken } from '../auth/sessions.ts';
import { newId, type Tx } from '../db/database.ts';
import type { Platform } from './context.ts';
import { QUEUES } from './queues.ts';
import { recordChange } from './record.ts';

export type TenantStatus = 'trial' | 'active' | 'suspended' | 'deleted';

/** Allowed lifecycle transitions. */
const TRANSITIONS: Record<TenantStatus, TenantStatus[]> = {
  trial: ['active', 'suspended', 'deleted'],
  active: ['suspended', 'deleted'],
  suspended: ['active', 'deleted'],
  deleted: ['active'], // restore within the purge window
};

/** Creates the tenant and its Owner in one transaction; returns the Owner's magic link token. */
export async function signup(p: Platform, input: SignupInput, correlationId: string) {
  const tenantId = newId();
  const userId = newId();
  const available = await sql<{ ok: boolean }>`SELECT slug_available(${input.slug}) AS ok`.execute(p.database.db);
  if (!available.rows[0]?.ok) throw new CommandError(409, 'slug_taken', 'that workspace address is taken');
  const trialEnds = new Date(Date.now() + p.ports.billing.trialDays() * 86_400_000);
  try {
    return await p.database.withTenant(tenantId, async (tx) => {
      await tx.insertInto('tenant').values({ id: tenantId, slug: input.slug, name: input.workspaceName, status: 'trial', plan: 'trial', trial_ends_at: trialEnds }).execute();
      await tx.insertInto('app_user').values({ id: userId, tenant_id: tenantId, email: input.email, name: input.ownerName, role: 'Owner', status: 'invited' }).execute();
      const token = await createLoginToken(tx, tenantId, userId, 'magic');
      await recordChange(p, tx, {
        tenantId,
        actor: { type: 'User', id: userId },
        action: 'platform:tenant.signup',
        resourceType: 'platform::Tenant',
        resourceId: tenantId,
        correlationId,
        events: [
          { type: 'tenant.created', data: { tenant_id: tenantId, slug: input.slug, plan: 'trial', trial_ends_at: trialEnds.toISOString() } },
          { type: 'user.created', data: { user_id: userId, role: 'Owner' } },
        ],
      });
      return { tenantId, userId, token };
    });
  } catch (e: any) {
    if (e?.code === '23505') throw new CommandError(409, 'slug_taken', 'that workspace address is taken');
    throw e;
  }
}

export async function changeTenantStatus(p: Platform, tx: Tx, tenantId: string, to: TenantStatus, actor: Principal | { type: 'System'; id: string }, correlationId: string, extra: { plan?: string } = {}) {
  const t = await tx.selectFrom('tenant').select(['status', 'version', 'plan']).executeTakeFirst();
  if (!t) throw new CommandError(404, 'tenant_not_found', 'workspace not found');
  const from = t.status as TenantStatus;
  if (from === to && !extra.plan) return;
  if (from !== to && !TRANSITIONS[from].includes(to)) throw new CommandError(409, 'invalid_transition', `cannot go from ${from} to ${to}`);
  if (to === 'active' && from === 'deleted') {
    const d = await tx.selectFrom('tenant').select('purge_after').executeTakeFirstOrThrow();
    if (d.purge_after && new Date(d.purge_after) < new Date()) throw new CommandError(410, 'purged', 'the restore window has passed');
  }
  const plan = extra.plan ?? (to === 'active' && t.plan === 'trial' ? 'starter' : t.plan);
  if (!p.ports.billing.plan(plan)) throw new CommandError(422, 'unknown_plan', `unknown plan ${plan}`);
  const now = new Date();
  await tx
    .updateTable('tenant')
    .set({
      status: to,
      plan,
      version: sql`version + 1`,
      suspended_at: to === 'suspended' ? now : null,
      deleted_at: to === 'deleted' ? now : null,
      purge_after: to === 'deleted' ? new Date(now.getTime() + p.config.trial.purge_after_days * 86_400_000) : null,
    })
    .execute();
  if (to === 'deleted') await tx.updateTable('user_session').set({ revoked_at: now }).where('revoked_at', 'is', null).execute();
  await recordChange(p, tx, {
    tenantId,
    actor,
    action: 'platform:tenant.status',
    resourceType: 'platform::Tenant',
    resourceId: tenantId,
    correlationId,
    events: [{ type: 'tenant.status_changed', data: { tenant_id: tenantId, from, to, plan } }],
  });
}

/** Scheduled sweep: expire trials, purge deleted tenants, purge retained app data. */
export async function lifecycleSweep(p: Platform) {
  const due = async (kind: string) => (await sql<{ tenant_id: string; app: string | null }>`SELECT * FROM tenants_due(${kind})`.execute(p.database.db)).rows;
  for (const r of await due('trial_expired')) await p.ports.jobs.send(QUEUES.tenantLifecycle, { kind: 'expire_trial', tenantId: r.tenant_id }, { singletonKey: `expire:${r.tenant_id}` });
  for (const r of await due('purge')) await p.ports.jobs.send(QUEUES.tenantLifecycle, { kind: 'purge_tenant', tenantId: r.tenant_id }, { singletonKey: `purge:${r.tenant_id}` });
  for (const r of await due('retained_app')) await p.ports.jobs.send(QUEUES.tenantLifecycle, { kind: 'purge_app', tenantId: r.tenant_id, app: r.app }, { singletonKey: `purge-app:${r.tenant_id}:${r.app}` });
}

export async function handleLifecycleJob(p: Platform, job: { kind: string; tenantId: string; app?: string }) {
  const system = { type: 'System' as const, id: 'lifecycle' };
  const correlationId = `lifecycle:${job.kind}:${job.tenantId}`;
  if (job.kind === 'expire_trial') {
    await p.database.withTenant(job.tenantId, async (tx) => {
      const t = await tx.selectFrom('tenant').select(['status', 'trial_ends_at']).executeTakeFirst();
      if (t?.status === 'trial' && new Date(t.trial_ends_at) < new Date()) await changeTenantStatus(p, tx, job.tenantId, 'suspended', system, correlationId);
    });
  } else if (job.kind === 'purge_app' && job.app) {
    const app = p.catalog.get(job.app);
    if (!app) return;
    await p.database.withTenant(job.tenantId, async (tx) => {
      const row = await tx.selectFrom('installed_app').select(['id', 'retained_until']).where('app', '=', job.app!).where('status', '=', 'retained').executeTakeFirst();
      if (!row || new Date(row.retained_until) > new Date()) return;
      await app.template.purge({ tx, tenantId: job.tenantId, now: () => new Date(), newId });
      await tx.updateTable('installed_app').set({ status: 'removed', updated_at: new Date() }).where('id', '=', row.id).execute();
      await recordChange(p, tx, { tenantId: job.tenantId, actor: system, action: 'platform:app.purged', resourceType: 'platform::App', resourceId: job.app!, correlationId, events: [{ type: 'app.data_purged', data: { app: job.app } }] });
    });
  } else if (job.kind === 'purge_tenant') {
    await purgeTenant(p, job.tenantId);
  }
}

/** Removes all of a deleted tenant's data (audit log is retained). */
export async function purgeTenant(p: Platform, tenantId: string) {
  await p.database.withTenant(tenantId, async (tx) => {
    const t = await tx.selectFrom('tenant').select(['status', 'purge_after']).executeTakeFirst();
    if (!t || t.status !== 'deleted' || new Date(t.purge_after) > new Date()) return;
    for (const { template } of p.catalog.apps.values()) await template.purge({ tx, tenantId, now: () => new Date(), newId });
    for (const table of ['processed_event', 'idempotency_key', 'outbox_event', 'event_log']) await tx.deleteFrom(table).where('tenant_id', '=', tenantId).execute();
    // Cascades to every platform table that references tenant(id).
    await tx.deleteFrom('tenant').where('id', '=', tenantId).execute();
  });
  p.log.info({ tenantId }, 'tenant purged');
}
