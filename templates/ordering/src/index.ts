import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  CommandError,
  defineCommand,
  invalid,
  money,
  notFound,
  readonlyFields,
  updateVersioned,
  type EventDraft,
  type TemplateModule,
  type TenantTxContext,
} from '@aod/shared';

export const STATUSES = ['new', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];
const FLOW: Status[] = ['new', 'confirmed', 'preparing', 'ready', 'completed'];

const Line = z.object({
  sku: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  qty: z.int().positive().max(999),
  unit_price: z.number().nonnegative(),
});

const CreateOrder = z.object({
  channel: z.enum(['web', 'phone', 'pos', 'marketplace']),
  store: z.string().max(80).optional(),
  customer_name: z.string().max(120).optional(),
  customer_phone: z.string().max(40).optional(),
  notes: z.string().max(1000).optional(),
  lines: z.array(Line).min(1).max(200),
  custom: z.record(z.string(), z.unknown()).optional(),
  placed_at: z.iso.datetime({ offset: true }).optional(),
});

const Versioned = z.object({ id: z.uuid(), version: z.int().positive() });

interface NewOrder {
  channel: string;
  status?: Status;
  store?: string | undefined;
  customer_name?: string | undefined;
  customer_phone?: string | undefined;
  notes?: string | undefined;
  lines: z.infer<typeof Line>[];
  custom?: Record<string, unknown>;
  placed_at?: string | undefined;
  source_ref?: string;
}

async function nextNumber(ctx: TenantTxContext, start: number): Promise<number> {
  const row = await sql<{ n: number }>`
    INSERT INTO ord_counter (tenant_id, next_number) VALUES (${ctx.tenantId}, ${start + 1})
    ON CONFLICT (tenant_id) DO UPDATE SET next_number = ord_counter.next_number + 1
    RETURNING next_number - 1 AS n`.execute(ctx.tx);
  return row.rows[0]!.n;
}

/** Shared by the `order.create` command and the POS-sales consumer. */
async function insertOrder(
  ctx: TenantTxContext & { config: Record<string, unknown>; emit: (d: EventDraft) => void },
  o: NewOrder,
) {
  const id = ctx.newId();
  const number = await nextNumber(ctx, Number(ctx.config.number_start ?? 1001));
  const total = money(o.lines.reduce((s, l) => s + l.qty * l.unit_price, 0));
  const currency = String(ctx.config.currency ?? 'IDR');
  await ctx.tx
    .insertInto('ord_order')
    .values({
      id,
      tenant_id: ctx.tenantId,
      number,
      status: o.status ?? 'new',
      channel: o.channel,
      store: o.store ?? null,
      customer_name: o.customer_name ?? null,
      customer_phone: o.customer_phone ?? null,
      notes: o.notes ?? null,
      currency,
      total,
      source_ref: o.source_ref ?? null,
      custom: JSON.stringify(o.custom ?? {}),
      placed_at: o.placed_at ? new Date(o.placed_at) : ctx.now(),
    })
    .execute();
  await ctx.tx
    .insertInto('ord_order_line')
    .values(o.lines.map((l) => ({ id: ctx.newId(), tenant_id: ctx.tenantId, order_id: id, ...l })))
    .execute();
  ctx.emit({
    type: 'order.created',
    aggregateType: 'order',
    aggregateId: id,
    data: { order_id: id, number, channel: o.channel, store: o.store ?? null, total, currency, lines: o.lines, source_ref: o.source_ref ?? null, pos_sale_id: o.source_ref?.startsWith('pos:sale:') ? o.source_ref.slice(9) : null },
  });
  return { id, number, version: 1, total };
}

const advance = defineCommand({
  input: Versioned.extend({ to: z.enum(STATUSES).optional() }),
  async handle(ctx, input) {
    const cur = await ctx.tx.selectFrom('ord_order').select(['status', 'number']).where('id', '=', input.id).executeTakeFirst();
    if (!cur) throw notFound('order');
    const idx = FLOW.indexOf(cur.status as Status);
    const next = FLOW[idx + 1];
    if (idx < 0 || !next) throw new CommandError(409, 'invalid_transition', `order is ${cur.status}; it cannot advance`);
    if (input.to && input.to !== next) throw new CommandError(409, 'invalid_transition', `order is ${cur.status}; next status is ${next}`);
    const row = await updateVersioned(ctx.tx, 'ord_order', input.id, input.version, { status: next });
    ctx.emit({
      type: 'order.status_changed',
      aggregateType: 'order',
      aggregateId: input.id,
      data: { order_id: input.id, number: cur.number, from: cur.status, to: next },
    });
    return { id: input.id, version: row.version, status: next };
  },
});

async function cancelOrder(ctx: TenantTxContext & { emit: (d: EventDraft) => void }, id: string, version: number | null, reason: string) {
  const cur = await ctx.tx.selectFrom('ord_order').select(['status', 'number', 'version']).where('id', '=', id).executeTakeFirst();
  if (!cur) throw notFound('order');
  if (cur.status === 'cancelled') throw new CommandError(409, 'invalid_transition', 'order is already cancelled');
  const row = await updateVersioned(ctx.tx, 'ord_order', id, version ?? cur.version, { status: 'cancelled' });
  ctx.emit({ type: 'order.status_changed', aggregateType: 'order', aggregateId: id, data: { order_id: id, number: cur.number, from: cur.status, to: 'cancelled' } });
  ctx.emit({ type: 'order.cancelled', aggregateType: 'order', aggregateId: id, data: { order_id: id, number: cur.number, reason } });
  return { id, version: row.version as number, status: 'cancelled' };
}

const UpdateOrder = Versioned.extend({
  notes: z.string().max(1000).nullable().optional(),
  customer_name: z.string().max(120).nullable().optional(),
  customer_phone: z.string().max(40).nullable().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

const SaleCompleted = z.object({
  sale_id: z.string(),
  store: z.string().nullable().optional(),
  sold_at: z.string(),
  lines: z.array(Line).min(1),
});

const ordering: TemplateModule = {
  id: 'ordering',
  dir: fileURLToPath(new URL('..', import.meta.url)),

  commands: {
    'order.create': defineCommand({
      input: CreateOrder,
      async handle(ctx, input) {
        const custom = await ctx.validateCustom('order', input.custom);
        return insertOrder(ctx, { ...input, custom });
      },
    }),
    'order.advance': advance,
    'order.cancel': defineCommand({
      input: Versioned.extend({ reason: z.string().max(200).default('') }),
      handle: (ctx, input) => cancelOrder(ctx, input.id, input.version, input.reason),
    }),
    'order.update': defineCommand({
      input: UpdateOrder,
      async handle(ctx, input) {
        const { id, version, ...rest } = input;
        const locked = readonlyFields(ctx.decision);
        const touched = [...Object.keys(rest).filter((k) => k !== 'custom'), ...Object.keys(rest.custom ?? {}).map((k) => `custom.${k}`)];
        const denied = touched.filter((f) => locked.includes(f));
        if (denied.length) throw new CommandError(403, 'field_forbidden', `you may not change: ${denied.join(', ')}`);
        const cur = await ctx.tx.selectFrom('ord_order').select(['number', 'custom']).where('id', '=', id).executeTakeFirst();
        if (!cur) throw notFound('order');
        const patch: Record<string, unknown> = {};
        for (const k of ['notes', 'customer_name', 'customer_phone'] as const) if (rest[k] !== undefined) patch[k] = rest[k];
        if (rest.custom) patch.custom = JSON.stringify(await ctx.validateCustom('order', rest.custom, cur.custom));
        if (!Object.keys(patch).length) throw invalid('nothing to change');
        const row = await updateVersioned(ctx.tx, 'ord_order', id, version, patch);
        ctx.emit({ type: 'order.updated', aggregateType: 'order', aggregateId: id, data: { order_id: id, number: cur.number, changes: touched } });
        return { id, version: row.version };
      },
    }),
  },

  consumers: {
    // Capability `pos_sales_to_orders`: every completed POS sale becomes a completed order.
    async pos_sales(ctx, event) {
      const sale = SaleCompleted.parse(event.data);
      const ref = `pos:sale:${sale.sale_id}`;
      const exists = await ctx.tx.selectFrom('ord_order').select('id').where('source_ref', '=', ref).executeTakeFirst();
      if (exists) return;
      await insertOrder(ctx, { channel: 'pos', status: 'completed', store: sale.store ?? undefined, lines: sale.lines, placed_at: sale.sold_at, source_ref: ref });
    },
    async pos_voids(ctx, event) {
      const ref = `pos:sale:${String(event.data.sale_id)}`;
      const row = await ctx.tx.selectFrom('ord_order').select(['id', 'status']).where('source_ref', '=', ref).executeTakeFirst();
      if (!row || row.status === 'cancelled') return;
      await cancelOrder(ctx, row.id, null, 'POS sale voided');
    },
  },

  queries: {
    lines: {
      permission: 'ordering:order.read',
      async run(ctx, params) {
        return { lines: await ctx.tx.selectFrom('ord_order_line').select(['sku', 'name', 'qty', 'unit_price']).where('order_id', '=', params.id ?? '').execute() };
      },
    },
  },

  async seed(ctx) {
    // number_start is applied lazily by the counter; nothing else to create.
    void ctx;
  },

  async demoSeed(ctx, run) {
    // Synthetic demo data for "Acme Coffee": orders 1035–1044.
    await sql`INSERT INTO ord_counter (tenant_id, next_number) VALUES (${ctx.tenantId}, 1035)
              ON CONFLICT (tenant_id) DO UPDATE SET next_number = 1035`.execute(ctx.tx);
    const stores = ['Kemang', 'Senopati', 'Blok M', 'Cikini'];
    const menu = [
      { sku: 'ESP', name: 'Espresso', unit_price: 25000 },
      { sku: 'LAT', name: 'Caffè latte', unit_price: 38000 },
      { sku: 'KSU', name: 'Es kopi susu', unit_price: 32000 },
      { sku: 'CRO', name: 'Butter croissant', unit_price: 28000 },
      { sku: 'MAT', name: 'Matcha latte', unit_price: 42000 },
    ];
    const customers = ['Rina S.', 'Budi P.', 'Sari W.', 'Andi K.', 'Dewi L.', 'Joko T.', 'Maya R.', 'Tono H.', 'Lia M.', 'Eko F.'];
    const steps = [0, 1, 2, 3, 4, 4, 1, 0, 3, 2];
    const base = Date.now() - 6 * 3600_000;
    for (let i = 0; i < 10; i++) {
      const lines = [menu[i % 5]!, menu[(i + 2) % 5]!].map((m, j) => ({ ...m, qty: 1 + ((i + j) % 2) }));
      const created = await run('order.create', {
        channel: i % 3 === 0 ? 'phone' : 'web',
        store: stores[i % 4],
        customer_name: customers[i],
        lines,
        placed_at: new Date(base + i * 25 * 60_000).toISOString(),
      });
      let version = created.version ?? 1;
      for (let s = 0; s < steps[i]!; s++) {
        const r = await run('order.advance', { id: created.id, version });
        version = r.version ?? version + 1;
      }
    }
  },

  async purge(ctx) {
    await ctx.tx.deleteFrom('ord_order_line').where('tenant_id', '=', ctx.tenantId).execute();
    await ctx.tx.deleteFrom('ord_order').where('tenant_id', '=', ctx.tenantId).execute();
    await ctx.tx.deleteFrom('ord_counter').where('tenant_id', '=', ctx.tenantId).execute();
  },

  async health(ctx) {
    await ctx.tx.selectFrom('ord_order').select(sql`count(*)`.as('n')).executeTakeFirst();
    return { ok: true };
  },
};

export default ordering;
