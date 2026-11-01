import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { z } from 'zod';
import { CommandError, conflict, defineCommand, invalid, money, notFound, updateVersioned, type TemplateModule } from '@aod/shared';

const Line = z.object({
  sku: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  qty: z.int().positive().max(999),
  unit_price: z.number().nonnegative(),
});

const CompleteSale = z.object({
  /** generated on the device; the sale keeps it through offline sync */
  id: z.uuid(),
  receipt_no: z.string().min(3).max(40).optional(),
  register_id: z.uuid(),
  shift_id: z.uuid().optional(),
  lines: z.array(Line).min(1).max(200),
  tender: z.enum(['cash', 'card', 'qris']),
  tendered: z.number().nonnegative().optional(),
  /** original sale time on the device */
  sold_at: z.iso.datetime({ offset: true }),
  offline: z.boolean().default(false),
  custom: z.record(z.string(), z.unknown()).optional(),
});

const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_OFFLINE_AGE_MS = 7 * 24 * 3600_000;

const pos: TemplateModule = {
  id: 'pos',
  dir: fileURLToPath(new URL('..', import.meta.url)),
  commands: {
    'sale.complete': defineCommand({
      input: CompleteSale,
      async handle(ctx, input) {
        // Idempotent on the device-generated id: a re-sent offline sale returns the stored one.
        const existing = await ctx.tx.selectFrom('pos_sale').select(['id', 'version', 'receipt_no', 'total']).where('id', '=', input.id).executeTakeFirst();
        if (existing) return { id: existing.id, version: existing.version, receipt_no: existing.receipt_no, total: Number(existing.total), duplicate: true };

        const soldAt = new Date(input.sold_at);
        const now = ctx.now().getTime();
        if (soldAt.getTime() > now + MAX_CLOCK_SKEW_MS) throw invalid('sold_at is in the future');
        if (soldAt.getTime() < now - MAX_OFFLINE_AGE_MS) throw invalid('offline sale is older than 7 days; reconcile manually');

        const reg = await ctx.tx
          .selectFrom('pos_register as r')
          .innerJoin('pos_store as s', 's.id', 'r.store_id')
          .select(['r.id', 'r.name as register', 's.name as store'])
          .where('r.id', '=', input.register_id)
          .executeTakeFirst();
        if (!reg) throw notFound('register');
        const shift = input.shift_id
          ? await ctx.tx.selectFrom('pos_shift').select(['id', 'register_id']).where('id', '=', input.shift_id).executeTakeFirst()
          : await ctx.tx.selectFrom('pos_shift').select(['id', 'register_id']).where('register_id', '=', input.register_id).where('status', '=', 'open').executeTakeFirst();
        if (input.shift_id && (!shift || shift.register_id !== input.register_id)) throw invalid('shift does not belong to this register');
        // An offline sale may arrive after its shift was closed; it is still accepted and
        // attributed to the shift it was rung up in. An online sale needs an open shift.
        if (!shift && !input.offline) throw new CommandError(409, 'no_open_shift', 'open a shift on this register first');

        const total = money(input.lines.reduce((s, l) => s + l.qty * l.unit_price, 0));
        if (input.tender === 'cash' && input.tendered !== undefined && input.tendered < total) throw invalid('tendered amount is less than the total');
        const currency = String(ctx.config.currency ?? 'IDR');
        const receipt = input.receipt_no ?? `R-${input.id.slice(0, 8).toUpperCase()}`;
        const custom = await ctx.validateCustom('sale', input.custom);
        await ctx.tx
          .insertInto('pos_sale')
          .values({
            id: input.id,
            tenant_id: ctx.tenantId,
            receipt_no: receipt,
            register_id: input.register_id,
            shift_id: shift?.id ?? null,
            store: reg.store,
            status: 'completed',
            tender: input.tender,
            currency,
            total,
            tendered: input.tendered ?? total,
            change_due: input.tender === 'cash' && input.tendered !== undefined ? money(input.tendered - total) : 0,
            offline: input.offline,
            sold_at: soldAt,
            custom: JSON.stringify(custom),
          })
          .execute();
        await ctx.tx
          .insertInto('pos_sale_line')
          .values(input.lines.map((l) => ({ id: ctx.newId(), tenant_id: ctx.tenantId, sale_id: input.id, ...l })))
          .execute();
        ctx.emit({
          type: 'sale.completed',
          aggregateType: 'sale',
          aggregateId: input.id,
          data: {
            sale_id: input.id,
            receipt_no: receipt,
            store: reg.store,
            register: reg.register,
            total,
            currency,
            tender: input.tender,
            lines: input.lines,
            sold_at: soldAt.toISOString(),
            offline: input.offline,
          },
        });
        return { id: input.id, version: 1, receipt_no: receipt, total, created: true };
      },
    }),

    'sale.void': defineCommand({
      input: z.object({ id: z.uuid(), version: z.int().positive(), reason: z.string().min(1).max(200) }),
      async handle(ctx, input) {
        const s = await ctx.tx.selectFrom('pos_sale').select(['status', 'receipt_no', 'total', 'tender', 'store']).where('id', '=', input.id).executeTakeFirst();
        if (!s) throw notFound('sale');
        if (s.status === 'voided') throw conflict('sale is already voided');
        const row = await updateVersioned(ctx.tx, 'pos_sale', input.id, input.version, { status: 'voided', void_reason: input.reason });
        ctx.emit({ type: 'sale.voided', aggregateType: 'sale', aggregateId: input.id, data: { sale_id: input.id, receipt_no: s.receipt_no, reason: input.reason, total: Number(s.total), tender: s.tender, store: s.store } });
        return { id: input.id, version: row.version };
      },
    }),

    'shift.open': defineCommand({
      input: z.object({ register_id: z.uuid(), opening_float: z.number().nonnegative().default(0) }),
      async handle(ctx, input) {
        const reg = await ctx.tx
          .selectFrom('pos_register as r')
          .innerJoin('pos_store as s', 's.id', 'r.store_id')
          .select(['r.name as register', 's.name as store'])
          .where('r.id', '=', input.register_id)
          .executeTakeFirst();
        if (!reg) throw notFound('register');
        const open = await ctx.tx.selectFrom('pos_shift').select('id').where('register_id', '=', input.register_id).where('status', '=', 'open').executeTakeFirst();
        if (open) throw new CommandError(409, 'shift_open', 'this register already has an open shift');
        const id = ctx.newId();
        await ctx.tx
          .insertInto('pos_shift')
          .values({ id, tenant_id: ctx.tenantId, register_id: input.register_id, register: reg.register, store: reg.store, status: 'open', opening_float: money(input.opening_float), opened_by: ctx.principal.id })
          .execute();
        ctx.emit({ type: 'shift.opened', aggregateType: 'shift', aggregateId: id, data: { shift_id: id, register: reg.register, store: reg.store, opening_float: money(input.opening_float) } });
        return { id, version: 1 };
      },
    }),

    'shift.close': defineCommand({
      input: z.object({ id: z.uuid(), version: z.int().positive(), counted_cash: z.number().nonnegative() }),
      async handle(ctx, input) {
        const sh = await ctx.tx.selectFrom('pos_shift').select(['status', 'opening_float']).where('id', '=', input.id).executeTakeFirst();
        if (!sh) throw notFound('shift');
        if (sh.status !== 'open') throw conflict('shift is already closed');
        const agg = await ctx.tx
          .selectFrom('pos_sale')
          .select([sql<string>`coalesce(sum(total) FILTER (WHERE tender = 'cash'), 0)`.as('cash'), sql<string>`count(*)`.as('n')])
          .where('shift_id', '=', input.id)
          .where('status', '=', 'completed')
          .executeTakeFirstOrThrow();
        const expected = money(Number(sh.opening_float) + Number(agg.cash));
        const row = await updateVersioned(ctx.tx, 'pos_shift', input.id, input.version, {
          status: 'closed',
          closed_at: ctx.now(),
          expected_cash: expected,
          counted_cash: money(input.counted_cash),
        });
        const variance = money(input.counted_cash - expected);
        ctx.emit({ type: 'shift.closed', aggregateType: 'shift', aggregateId: input.id, data: { shift_id: input.id, expected_cash: expected, counted_cash: money(input.counted_cash), variance, sales: Number(agg.n) } });
        return { id: input.id, version: row.version, expected_cash: expected, variance };
      },
    }),

    'store.create': defineCommand({
      input: z.object({ name: z.string().trim().min(1).max(80), registers: z.array(z.string().trim().min(1).max(40)).min(1).max(20).default(['Register 1']) }),
      async handle(ctx, input) {
        const dupe = await ctx.tx.selectFrom('pos_store').select('id').where('name', '=', input.name).executeTakeFirst();
        if (dupe) throw conflict(`store ${input.name} already exists`);
        const id = ctx.newId();
        await ctx.tx.insertInto('pos_store').values({ id, tenant_id: ctx.tenantId, name: input.name }).execute();
        await ctx.tx
          .insertInto('pos_register')
          .values(input.registers.map((name) => ({ id: ctx.newId(), tenant_id: ctx.tenantId, store_id: id, name })))
          .execute();
        ctx.emit({ type: 'store.created', aggregateType: 'store', aggregateId: id, data: { store_id: id, name: input.name, registers: input.registers } });
        return { id, version: 1 };
      },
    }),
  },

  queries: {
    // Stores, registers and each register's open shift, for the register screen.
    registers: {
      permission: 'pos:sale.read',
      async run(ctx) {
        const regs = await ctx.tx
          .selectFrom('pos_register as r')
          .innerJoin('pos_store as s', 's.id', 'r.store_id')
          .leftJoin('pos_shift as sh', (j) => j.onRef('sh.register_id', '=', 'r.id').on('sh.status', '=', 'open'))
          .select(['r.id', 'r.name', 's.id as store_id', 's.name as store', 'sh.id as shift_id', 'sh.version as shift_version', 'sh.opened_at', 'sh.opening_float'])
          .orderBy('s.name')
          .orderBy('r.name')
          .execute();
        return { registers: regs };
      },
    },
    products: {
      permission: 'pos:sale.read',
      async run(ctx) {
        return { products: ctx.config.products ?? [], currency: ctx.config.currency ?? 'IDR' };
      },
    },
    sale_lines: {
      permission: 'pos:sale.read',
      async run(ctx, params) {
        return { lines: await ctx.tx.selectFrom('pos_sale_line').select(['sku', 'name', 'qty', 'unit_price']).where('sale_id', '=', params.id ?? '').execute() };
      },
    },
  },

  async seed(ctx) {
    // A default store so a fresh tenant can ring up a sale right away.
    const any = await ctx.tx.selectFrom('pos_store').select('id').executeTakeFirst();
    if (any) return;
    const id = ctx.newId();
    await ctx.tx.insertInto('pos_store').values({ id, tenant_id: ctx.tenantId, name: 'Main store' }).execute();
    await ctx.tx.insertInto('pos_register').values({ id: ctx.newId(), tenant_id: ctx.tenantId, store_id: id, name: 'Register 1' }).execute();
  },

  async demoSeed(ctx, run) {
    await ctx.tx.deleteFrom('pos_register').where('tenant_id', '=', ctx.tenantId).execute();
    await ctx.tx.deleteFrom('pos_store').where('tenant_id', '=', ctx.tenantId).execute();
    for (const name of ['Kemang', 'Senopati', 'Blok M', 'Cikini']) {
      await run('store.create', { name, registers: ['Register 1', 'Register 2'] });
    }
  },

  async purge(ctx) {
    for (const t of ['pos_sale_line', 'pos_sale', 'pos_shift', 'pos_register', 'pos_store']) {
      await ctx.tx.deleteFrom(t).where('tenant_id', '=', ctx.tenantId).execute();
    }
  },

  async health(ctx) {
    const r = await ctx.tx.selectFrom('pos_register').select('id').executeTakeFirst();
    return r ? { ok: true } : { ok: false, detail: 'no register' };
  },
};

export default pos;
