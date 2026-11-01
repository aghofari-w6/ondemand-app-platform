import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { z } from 'zod';
import { CommandError, defineCommand, invalid, notFound, updateVersioned, type TemplateModule } from '@aod/shared';

export const SHIPMENT_STATUSES = ['pending', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception'] as const;
type Status = (typeof SHIPMENT_STATUSES)[number];

/** Allowed transitions. `delivered` is final; `exception` can resume. */
const NEXT: Record<Status, Status[]> = {
  pending: ['picked_up', 'exception'],
  picked_up: ['in_transit', 'exception'],
  in_transit: ['out_for_delivery', 'delivered', 'exception'],
  out_for_delivery: ['delivered', 'exception'],
  exception: ['in_transit', 'out_for_delivery', 'delivered'],
  delivered: [],
};

export const canTransition = (from: Status, to: Status) => NEXT[from].includes(to);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const UpdateStatus = z
  .object({
    id: z.uuid().optional(),
    tracking_no: z.string().optional(),
    /** optional for carrier callbacks: the carrier is the source of truth */
    version: z.int().positive().optional(),
    status: z.enum(SHIPMENT_STATUSES),
    note: z.string().max(500).optional(),
    occurred_at: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((v) => v.id || v.tracking_no, 'id or tracking_no is required');

const CarrierCallback = z.object({
  event_id: z.string().min(1).max(100),
  tracking_no: z.string().min(1),
  status: z.enum(SHIPMENT_STATUSES),
  note: z.string().max(500).optional(),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
});

const logistics: TemplateModule = {
  id: 'logistics',
  dir: fileURLToPath(new URL('..', import.meta.url)),
  commands: {
    'shipment.create': defineCommand({
      input: z.object({
        order_id: z.uuid(),
        carrier: z.enum(['jne', 'sicepat', 'gosend', 'internal']),
        destination: z.string().max(200).optional(),
        tracking_no: z.string().min(3).max(60).optional(),
        custom: z.record(z.string(), z.unknown()).optional(),
      }),
      async handle(ctx, input) {
        const order = await ctx.tx.selectFrom('lgx_order').select(['number', 'status']).where('order_id', '=', input.order_id).executeTakeFirst();
        if (!order) throw invalid('unknown order (Logistics only ships orders it has seen from Ordering)');
        if (order.status === 'cancelled') throw new CommandError(409, 'order_cancelled', 'order is cancelled');
        const id = ctx.newId();
        const tracking = input.tracking_no ?? `${input.carrier.toUpperCase()}${randomBytes(5).toString('hex').toUpperCase()}`;
        const custom = await ctx.validateCustom('shipment', input.custom);
        await ctx.tx
          .insertInto('lgx_shipment')
          .values({ id, tenant_id: ctx.tenantId, order_id: input.order_id, order_number: order.number, carrier: input.carrier, tracking_no: tracking, status: 'pending', destination: input.destination ?? null, custom: JSON.stringify(custom) })
          .execute();
        await ctx.tx.insertInto('lgx_shipment_event').values({ id: ctx.newId(), tenant_id: ctx.tenantId, shipment_id: id, status: 'pending', source: 'user', note: null, occurred_at: ctx.now() }).execute();
        ctx.emit({ type: 'shipment.created', aggregateType: 'shipment', aggregateId: id, data: { shipment_id: id, order_id: input.order_id, order_number: order.number, carrier: input.carrier, tracking_no: tracking } });
        return { id, version: 1, tracking_no: tracking };
      },
    }),

    'shipment.update_status': defineCommand({
      input: UpdateStatus,
      async handle(ctx, input) {
        let q = ctx.tx.selectFrom('lgx_shipment').select(['id', 'status', 'version', 'order_id']);
        q = input.id ? q.where('id', '=', input.id) : q.where('tracking_no', '=', input.tracking_no!);
        const cur = await q.executeTakeFirst();
        if (!cur) throw notFound('shipment');
        const from = cur.status as Status;
        if (from === input.status) return { id: cur.id, version: cur.version, unchanged: true };
        if (!canTransition(from, input.status)) throw new CommandError(409, 'invalid_transition', `cannot go from ${from} to ${input.status}`);
        const at = input.occurred_at ? new Date(input.occurred_at) : ctx.now();
        const patch: Record<string, unknown> = { status: input.status };
        if (input.status === 'delivered') patch.delivered_at = at;
        if (input.status === 'exception') patch.exception_reason = input.note ?? 'unspecified';
        const row = await updateVersioned(ctx.tx, 'lgx_shipment', cur.id, input.version ?? cur.version, patch);
        const source = ctx.origin === 'carrier' ? 'carrier' : 'user';
        await ctx.tx.insertInto('lgx_shipment_event').values({ id: ctx.newId(), tenant_id: ctx.tenantId, shipment_id: cur.id, status: input.status, source, note: input.note ?? null, occurred_at: at }).execute();
        const base = { shipment_id: cur.id, order_id: cur.order_id };
        ctx.emit({ type: 'shipment.status_changed', aggregateType: 'shipment', aggregateId: cur.id, data: { ...base, from, to: input.status, source, note: input.note ?? null } });
        if (input.status === 'delivered') ctx.emit({ type: 'shipment.delivered', aggregateType: 'shipment', aggregateId: cur.id, data: { ...base, delivered_at: at.toISOString() } });
        if (input.status === 'exception') ctx.emit({ type: 'shipment.exception', aggregateType: 'shipment', aggregateId: cur.id, data: { ...base, reason: input.note ?? 'unspecified' } });
        return { id: cur.id, version: row.version, status: input.status };
      },
    }),

    'carrier.connect': defineCommand({
      input: z.object({ carrier: z.enum(['jne', 'sicepat', 'gosend', 'internal']) }),
      async handle(ctx, input) {
        const token = `cb_${randomBytes(24).toString('base64url')}`;
        await ctx.tx
          .insertInto('lgx_carrier_account')
          .values({ tenant_id: ctx.tenantId, carrier: input.carrier, token_hash: sha256(token) })
          .onConflict((oc) => oc.columns(['tenant_id', 'carrier']).doUpdateSet({ token_hash: sha256(token), created_at: sql`now()` }))
          .execute();
        ctx.emit({ type: 'carrier_account.connected', aggregateType: 'carrier_account', aggregateId: input.carrier, data: { carrier: input.carrier } });
        // The token is returned once and never stored in clear text.
        return { id: input.carrier, token };
      },
    }),
  },

  consumers: {
    // Capability `shipments_track_orders`: keep a local copy of the order facts Logistics needs.
    async orders(ctx, event) {
      const d = event.data as { order_id: string; number: number; store?: string | null; to?: string };
      if (event.type === 'order.created') {
        await ctx.tx
          .insertInto('lgx_order')
          .values({ order_id: d.order_id, tenant_id: ctx.tenantId, number: d.number, store: d.store ?? null, status: 'new' })
          .onConflict((oc) => oc.columns(['tenant_id', 'order_id']).doNothing())
          .execute();
      } else if (event.type === 'order.status_changed' && d.to) {
        await ctx.tx.updateTable('lgx_order').set({ status: d.to, updated_at: ctx.now() }).where('order_id', '=', d.order_id).execute();
      }
    },
  },

  queries: {
    // Orders Logistics knows about (projection), for "create shipment".
    shippable_orders: {
      permission: 'logistics:shipment.create',
      async run(ctx) {
        const orders = await ctx.tx
          .selectFrom('lgx_order as o')
          .leftJoin('lgx_shipment as s', 's.order_id', 'o.order_id')
          .select(['o.order_id', 'o.number', 'o.store', 'o.status'])
          .where('s.id', 'is', null)
          .where('o.status', 'not in', ['cancelled'])
          .orderBy('o.number', 'desc')
          .limit(100)
          .execute();
        return { orders };
      },
    },
    shipment_events: {
      permission: 'logistics:shipment.read',
      async run(ctx, params) {
        return {
          events: await ctx.tx.selectFrom('lgx_shipment_event').select(['status', 'source', 'note', 'occurred_at']).where('shipment_id', '=', params.id ?? '').orderBy('occurred_at').execute(),
        };
      },
    },
  },

  inbound: {
    // POST /v1/inbound/:tenantId/logistics/carrier/:carrier  (header: X-Carrier-Token)
    carrier: {
      async verify(ctx, req) {
        const token = req.headers['x-carrier-token'];
        if (!token) return false;
        const acct = await ctx.tx.selectFrom('lgx_carrier_account').select('token_hash').where('carrier', '=', req.params.carrier ?? '').executeTakeFirst();
        if (!acct) return false;
        const a = Buffer.from(acct.token_hash, 'hex');
        const b = Buffer.from(sha256(token), 'hex');
        return a.length === b.length && timingSafeEqual(a, b);
      },
      toCommand(req) {
        const body = CarrierCallback.parse(req.body);
        return {
          command: 'shipment.update_status',
          input: { tracking_no: body.tracking_no, status: body.status, note: body.note, occurred_at: body.occurred_at },
          idempotencyKey: `carrier:${req.params.carrier}:${body.event_id}`,
        };
      },
    },
  },

  async seed() {},

  async purge(ctx) {
    for (const t of ['lgx_shipment_event', 'lgx_shipment', 'lgx_order', 'lgx_carrier_account']) {
      await ctx.tx.deleteFrom(t).where('tenant_id', '=', ctx.tenantId).execute();
    }
  },

  async health(ctx) {
    await ctx.tx.selectFrom('lgx_shipment').select(sql`1`.as('x')).limit(1).execute();
    return { ok: true };
  },
};

export default logistics;
