import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { z } from 'zod';
import { CommandError, defineCommand, money, notFound, updateVersioned, type TemplateModule, type TenantTxContext } from '@aod/shared';

/**
 * Payment provider adapter. The prototype ships a fake provider: captures succeed
 * unless the tenant's `fail_next_capture` flag is set, which makes exactly the
 * next capture fail and then clears itself.
 */
export interface PaymentProvider {
  capture(req: { amount: number; currency: string; method: string; reference: string }): Promise<{ ok: true; providerRef: string } | { ok: false; reason: string }>;
  refund(req: { providerRef: string; amount: number }): Promise<{ ok: boolean }>;
}

export function fakeProvider(failNext: () => Promise<boolean>): PaymentProvider {
  return {
    async capture() {
      if (await failNext()) return { ok: false, reason: 'card_declined (test mode: fail-next flag)' };
      return { ok: true, providerRef: `fake_ch_${randomBytes(8).toString('hex')}` };
    },
    async refund() {
      return { ok: true };
    },
  };
}

/** Atomically reads and clears the fail-next flag. */
async function consumeFailNext(ctx: TenantTxContext): Promise<boolean> {
  const r = await sql<{ was: boolean }>`
    UPDATE pay_settings SET fail_next_capture = false, version = version + 1
    WHERE tenant_id = ${ctx.tenantId} AND fail_next_capture
    RETURNING true AS was`.execute(ctx.tx);
  return r.rows.length > 0;
}

const Capture = z.object({
  reference: z.string().min(1).max(120),
  amount: z.number().positive(),
  method: z.enum(['card', 'qris', 'ewallet']).default('card'),
  custom: z.record(z.string(), z.unknown()).optional(),
});

async function capture(ctx: TenantTxContext & { emit: (d: any) => void; config: Record<string, unknown> }, input: z.infer<typeof Capture>, custom: Record<string, unknown>) {
  const currency = String(ctx.config.currency ?? 'IDR');
  const provider = fakeProvider(() => consumeFailNext(ctx));
  const amount = money(input.amount);
  const res = await provider.capture({ amount, currency, method: input.method, reference: input.reference });
  const id = ctx.newId();
  await ctx.tx
    .insertInto('pay_payment')
    .values({
      id,
      tenant_id: ctx.tenantId,
      reference: input.reference,
      status: res.ok ? 'captured' : 'failed',
      method: input.method,
      amount,
      currency,
      provider_ref: res.ok ? res.providerRef : null,
      failure_reason: res.ok ? null : res.reason,
      custom: JSON.stringify(custom),
    })
    .execute();
  if (res.ok) {
    ctx.emit({ type: 'payment.captured', aggregateType: 'payment', aggregateId: id, data: { payment_id: id, reference: input.reference, amount, currency, method: input.method, provider_ref: res.providerRef, pos_sale_id: input.reference.startsWith('pos:sale:') ? input.reference.slice(9) : null } });
  } else {
    ctx.emit({ type: 'payment.failed', aggregateType: 'payment', aggregateId: id, data: { payment_id: id, reference: input.reference, amount, currency, reason: res.reason } });
  }
  return { id, version: 1, status: res.ok ? 'captured' : 'failed' };
}

const payments: TemplateModule = {
  id: 'payments',
  dir: fileURLToPath(new URL('..', import.meta.url)),
  commands: {
    'payment.capture': defineCommand({
      input: Capture,
      async handle(ctx, input) {
        return capture(ctx, input, await ctx.validateCustom('payment', input.custom));
      },
    }),
    'payment.refund': defineCommand({
      input: z.object({ id: z.uuid(), version: z.int().positive() }),
      async handle(ctx, input) {
        const p = await ctx.tx.selectFrom('pay_payment').selectAll().where('id', '=', input.id).executeTakeFirst();
        if (!p) throw notFound('payment');
        if (p.status !== 'captured') throw new CommandError(409, 'invalid_transition', `payment is ${p.status}`);
        await fakeProvider(async () => false).refund({ providerRef: p.provider_ref, amount: Number(p.amount) });
        const row = await updateVersioned(ctx.tx, 'pay_payment', input.id, input.version, { status: 'refunded' });
        ctx.emit({ type: 'payment.refunded', aggregateType: 'payment', aggregateId: input.id, data: { payment_id: input.id, reference: p.reference, amount: Number(p.amount) } });
        return { id: input.id, version: row.version };
      },
    }),
    'settings.update': defineCommand({
      input: z.object({ fail_next_capture: z.boolean() }),
      async handle(ctx, input) {
        await ctx.tx
          .insertInto('pay_settings')
          .values({ tenant_id: ctx.tenantId, fail_next_capture: input.fail_next_capture })
          .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ fail_next_capture: input.fail_next_capture, version: sql`pay_settings.version + 1` }))
          .execute();
        ctx.emit({ type: 'payment_settings.updated', aggregateType: 'settings', aggregateId: ctx.tenantId, data: { fail_next_capture: input.fail_next_capture } });
        return { id: ctx.tenantId };
      },
    }),
  },
  consumers: {
    // Capability `pos_card_tenders_use_payments`: card tenders from POS are captured here.
    async pos_card_tenders(ctx, event) {
      const d = z.object({ sale_id: z.string(), total: z.number(), tender: z.string() }).parse(event.data);
      if (d.tender !== 'card') return;
      const reference = `pos:sale:${d.sale_id}`;
      const exists = await ctx.tx.selectFrom('pay_payment').select('id').where('reference', '=', reference).executeTakeFirst();
      if (exists) return;
      await capture(ctx, { reference, amount: d.total, method: 'card' }, {});
    },
  },
  async seed(ctx) {
    await ctx.tx.insertInto('pay_settings').values({ tenant_id: ctx.tenantId }).onConflict((oc) => oc.column('tenant_id').doNothing()).execute();
  },
  async purge(ctx) {
    await ctx.tx.deleteFrom('pay_payment').where('tenant_id', '=', ctx.tenantId).execute();
    await ctx.tx.deleteFrom('pay_settings').where('tenant_id', '=', ctx.tenantId).execute();
  },
  async health(ctx) {
    const s = await ctx.tx.selectFrom('pay_settings').select('tenant_id').executeTakeFirst();
    return s ? { ok: true } : { ok: false, detail: 'settings row missing' };
  },
};

export default payments;
