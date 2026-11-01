/**
 * Demo seed: tenant "Acme Coffee" (synthetic data only).
 * Stores Kemang, Senopati, Blok M and Cikini; orders 1035–1044.
 *
 *   pnpm seed            create it if missing
 *   pnpm seed --reset    delete and re-create it
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { InlineJobs } from './adapters/inline-jobs.ts';
import { principalFor } from './auth/principal.ts';
import { executeCommand } from './platform/commands.ts';
import { createPlatform } from './platform/create.ts';
import { enqueueStep, handleStepJob, SAGAS, startRun } from './platform/provisioning.ts';
import { QUEUES } from './platform/queues.ts';
import { changeTenantStatus, signup } from './platform/tenants.ts';
import { createWorkflow, publishWorkflow } from './platform/workflows/definitions.ts';
import { newId } from './db/database.ts';

const SLUG = 'acme-coffee';
const OWNER = 'ayu@acme-coffee.example';

export async function seedAcme(opts: { reset?: boolean; adminUrl?: string; env?: Record<string, string> } = {}) {
  const p = createPlatform({ env: { ...opts.env, NODE_ENV: 'development' } as any, log: { info() {}, warn: console.warn, error: console.error } });
  const jobs = new InlineJobs();
  p.ports.jobs = jobs;
  await jobs.work(QUEUES.provisionStep, (d: any, j: any) => handleStepJob(p, d, j.retryCount));
  try {
    const existing = (await sql<{ id: string }>`SELECT id FROM resolve_tenant(${SLUG})`.execute(p.database.db)).rows[0];
    if (existing && opts.reset) {
      // Hard delete needs the owner role (bypasses the append-only grant on audit_log by design).
      const admin = new pg.Client({ connectionString: opts.adminUrl ?? p.env.MIGRATION_DATABASE_URL });
      await admin.connect();
      await admin.query('BEGIN');
      for (const t of (await admin.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id'`)).rows) {
        await admin.query(`DELETE FROM ${pg.escapeIdentifier(t.table_name)} WHERE tenant_id = $1`, [existing.id]);
      }
      await admin.query('DELETE FROM tenant WHERE id = $1', [existing.id]);
      await admin.query('COMMIT');
      await admin.end();
    } else if (existing) {
      console.log(`"${SLUG}" already exists. Use --reset to re-create it.`);
      return { tenantId: existing.id, created: false };
    }

    const { tenantId, userId } = await signup(p, { workspaceName: 'Acme Coffee', slug: SLUG, ownerName: 'Ayu Lestari', email: OWNER }, randomUUID());
    const owner = await p.database.withTenant(tenantId, (tx) => principalFor(tx, p.catalog, tenantId, { id: userId, role: 'Owner' }));
    await p.database.withTenant(tenantId, async (tx) => {
      await changeTenantStatus(p, tx, tenantId, 'active', owner, randomUUID(), { plan: 'growth' });
      await tx.updateTable('app_user').set({ status: 'active' }).where('id', '=', userId).execute();
      const staff = [
        { email: 'dimas@acme-coffee.example', name: 'Dimas Pratama', role: 'Manager' },
        { email: 'sari@acme-coffee.example', name: 'Sari Wulandari', role: 'Staff' },
        { email: 'budi@acme-coffee.example', name: 'Budi Santoso', role: 'Viewer' },
      ];
      for (const s of staff) await tx.insertInto('app_user').values({ id: newId(), tenant_id: tenantId, ...s, status: 'active' }).execute();
      await tx.insertInto('field_definition').values({ id: newId(), tenant_id: tenantId, app: 'ordering', entity: 'order', key: 'pickup_slot', label: 'Pickup slot', type: 'select', options: ['morning', 'lunch', 'afternoon'] }).execute();
    });

    for (const app of ['ordering', 'payments', 'pos', 'logistics']) {
      const runId = await p.database.withTenant(tenantId, (tx) => startRun(p, tx, { tenantId, app, kind: 'provision', actor: owner, correlationId: randomUUID() }));
      await enqueueStep(p, tenantId, runId, SAGAS.provision[0]!.name);
      await jobs.runAll();
      const run = await p.database.withTenant(tenantId, (tx) => tx.selectFrom('provisioning_run').select(['status', 'error']).where('id', '=', runId).executeTakeFirstOrThrow());
      if (run.status !== 'succeeded') throw new Error(`${app}: ${run.error}`);
    }

    // POS first (stores), then Ordering (orders 1035–1044).
    for (const app of ['pos', 'ordering']) {
      const t = p.catalog.get(app)!.template;
      await p.database.withTenant(tenantId, (tx) =>
        t.demoSeed!({ tx, tenantId, now: () => new Date(), newId }, async (command, input, o) =>
          (await executeCommand(p, { tenantId, principal: owner, app, command, input, origin: o?.origin ?? 'system', correlationId: randomUUID() }, tx)).body,
        ),
      );
    }
    // Workflow (J3): large voids need a manager's approval before the card refund.
    await p.database.withTenant(tenantId, async (tx) => {
      const n = (id: string, type: string, name: string, x: number, y: number, config: Record<string, unknown>) => ({ id, type, name, position: { x, y }, config });
      const graph = {
        nodes: [
          n('trigger', 'trigger', 'Large void', 0, 0, { event: 'sale.voided', filter: 'trigger.data.total > 1000000' }),
          n('approve', 'approval', 'Manager approval', 300, 0, { title: 'Refund voided sale {{ trigger.data.receipt_no }}', details: 'Total {{ trigger.data.total }} at {{ trigger.data.store }}. Reason: {{ trigger.data.reason }}', approver_roles: ['Manager'], quorum: 1, expires_in_hours: 24 }),
          n('refund', 'command', 'Refund payment', 600, -90, { app: 'payments', command: 'payment.refund_by_reference', input: { reference: 'pos:sale:{{ trigger.data.sale_id }}', reason: 'voided: {{ trigger.data.reason }}' } }),
          n('notify_store', 'notify', 'Notify store', 900, -90, { roles: ['Manager'], subject: 'Refund issued for {{ trigger.data.receipt_no }}', message: 'Refunded {{ steps.refund.output.refunded }}.' }),
          n('notify_cashier', 'notify', 'Notify cashier', 600, 120, { roles: ['Staff'], subject: 'Void refund rejected', message: 'The refund for {{ trigger.data.receipt_no }} was rejected.' }),
        ],
        edges: [
          { id: 'e1', from: 'trigger', port: 'out', to: 'approve' },
          { id: 'e2', from: 'approve', port: 'approved', to: 'refund' },
          { id: 'e3', from: 'refund', port: 'out', to: 'notify_store' },
          { id: 'e4', from: 'approve', port: 'rejected', to: 'notify_cashier' },
        ],
      };
      const { id } = await createWorkflow(p, tx, tenantId, owner, { name: 'Large void refund', description: 'Voids over Rp 1,000,000 need a manager before the card is refunded.', graph }, randomUUID());
      await publishWorkflow(p, tx, tenantId, owner, id, 1, 'Manager', randomUUID());
    });
    // Deliver events now unless a running server is the dispatcher (it will deliver them).
    await p.ports.eventBus.drain().catch(() => console.log('A running server holds the dispatcher lock; it will deliver the seed events.'));
    console.log(`Seeded "Acme Coffee" (${SLUG}). Sign in with workspace "${SLUG}" and ${OWNER}.`);
    return { tenantId, created: true };
  } finally {
    await p.ports.eventBus.stop();
    await p.database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedAcme({ reset: process.argv.includes('--reset') }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
