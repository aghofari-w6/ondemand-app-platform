import { CommandError, ConnectorInput, EndpointInput, SyncInput, type EventEnvelope } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { newId } from '../../db/database.ts';
import type { Platform } from '../../platform/context.ts';
import { endpointView, replayDeliveries, rotateSecret, runConnector, saveEndpoint } from '../../platform/hub.ts';
import { loadEntity } from '../../platform/records.ts';
import { recordChange } from '../../platform/record.ts';
import { correlationId, parse, requirePermission } from '../app.ts';

const UUID = z.uuid();

export function hubRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    /** Event types an endpoint can subscribe to, with their current schema versions. */
    app.get('/api/hub/events', async (req) => {
      requirePermission(req, 'platform:hub.read');
      const types = p.catalog.manifests().flatMap((m) => m.events.publishes.map((e) => ({ type: e.type, version: e.version, app: m.id, description: e.description })));
      types.push(...['created', 'updated', 'deleted'].map((v) => ({ type: `record.${v}`, version: 1, app: 'custom', description: `A custom entity record was ${v}.` })));
      return { types };
    });

    app.get('/api/hub/endpoints', async (req) => {
      const a = requirePermission(req, 'platform:hub.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const rows = await tx.selectFrom('hub_endpoint').selectAll().orderBy('created_at').execute();
        const stats = await tx.selectFrom('hub_delivery').select(['endpoint_id', 'status', sql<number>`count(*)::int`.as('n')]).groupBy(['endpoint_id', 'status']).execute();
        return { endpoints: rows.map((r) => ({ ...endpointView(r), stats: Object.fromEntries(stats.filter((s) => s.endpoint_id === r.id).map((s) => [s.status, s.n])) })) };
      });
    });

    app.post('/api/hub/endpoints', async (req, reply) => {
      const a = requirePermission(req, 'platform:hub.manage');
      const input = parse(EndpointInput, req.body);
      const r = await p.database.withTenant(a.tenantId, (tx) => saveEndpoint(p, tx, a.tenantId, a.principal, input, correlationId(req)));
      return reply.code(201).send(r);
    });

    app.put('/api/hub/endpoints/:id', async (req) => {
      const a = requirePermission(req, 'platform:hub.manage');
      const id = parse(UUID, (req.params as { id: string }).id);
      const { version, ...rest } = req.body as { version: number };
      const input = parse(EndpointInput, rest);
      return p.database.withTenant(a.tenantId, (tx) => saveEndpoint(p, tx, a.tenantId, a.principal, input, correlationId(req), { id, version: parse(z.int().positive(), version) }));
    });

    app.post('/api/hub/endpoints/:id/status', async (req) => {
      const a = requirePermission(req, 'platform:hub.manage');
      const id = parse(UUID, (req.params as { id: string }).id);
      const { status } = parse(z.object({ status: z.enum(['active', 'paused']) }), req.body);
      await p.database.withTenant(a.tenantId, async (tx) => {
        const r = await tx.updateTable('hub_endpoint').set({ status, ...(status === 'active' ? { circuit_state: 'closed', consecutive_failures: 0, circuit_opened_at: null } : {}), version: sql`version + 1` }).where('id', '=', id).executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw new CommandError(404, 'not_found', 'endpoint not found');
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: `platform:hub.endpoint_${status}`, resourceType: 'platform::HubEndpoint', resourceId: id, correlationId: correlationId(req) });
      });
      return { ok: true };
    });

    app.post('/api/hub/endpoints/:id/rotate-secret', async (req) => {
      const a = requirePermission(req, 'platform:hub.manage');
      const id = parse(UUID, (req.params as { id: string }).id);
      return { signingSecret: await p.database.withTenant(a.tenantId, (tx) => rotateSecret(p, tx, a.tenantId, a.principal, id, correlationId(req))) };
    });

    app.delete('/api/hub/endpoints/:id', async (req) => {
      const a = requirePermission(req, 'platform:hub.manage');
      const id = parse(UUID, (req.params as { id: string }).id);
      await p.database.withTenant(a.tenantId, async (tx) => {
        await tx.updateTable('hub_sync').set({ endpoint_id: null }).where('endpoint_id', '=', id).execute();
        await tx.deleteFrom('hub_endpoint').where('id', '=', id).execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:hub.endpoint_deleted', resourceType: 'platform::HubEndpoint', resourceId: id, correlationId: correlationId(req) });
      });
      return { ok: true };
    });

    /** Delivery log for an endpoint (optionally only the DLQ), with attempts. */
    app.get('/api/hub/endpoints/:id/deliveries', async (req) => {
      const a = requirePermission(req, 'platform:hub.read');
      const id = parse(UUID, (req.params as { id: string }).id);
      const q = parse(z.object({ status: z.enum(['pending', 'delivering', 'succeeded', 'dead', 'skipped']).optional() }), req.query);
      return p.database.withTenant(a.tenantId, async (tx) => {
        let qb = tx.selectFrom('hub_delivery').selectAll().where('endpoint_id', '=', id);
        if (q.status) qb = qb.where('status', '=', q.status);
        const deliveries = await qb.orderBy('created_at', 'desc').limit(100).execute();
        const attempts = deliveries.length ? await tx.selectFrom('hub_delivery_attempt').selectAll().where('delivery_id', 'in', deliveries.map((d) => d.id)).orderBy('attempt').execute() : [];
        return { deliveries: deliveries.map((d) => ({ ...d, attempts_log: attempts.filter((x) => x.delivery_id === d.id) })) };
      });
    });

    /** DLQ replay: single deliveries by id, or every dead delivery of an endpoint. Event ids are kept. */
    app.post('/api/hub/replay', async (req) => {
      const a = requirePermission(req, 'platform:hub.manage');
      const sel = parse(z.object({ ids: z.array(UUID).max(500).optional(), endpointId: UUID.optional(), status: z.enum(['dead', 'skipped']).optional() }), req.body);
      const n = await p.database.withTenant(a.tenantId, (tx) => replayDeliveries(p, tx, a.tenantId, a.principal, sel, correlationId(req)));
      return { replayed: n };
    });

    // ------------------------------------------------------------ connectors

    app.get('/api/hub/connectors', async (req) => {
      const a = requirePermission(req, 'platform:hub.read');
      return p.database.withTenant(a.tenantId, async (tx) => ({ connectors: await tx.selectFrom('hub_connector').select(['id', 'name', 'spec', 'version', 'created_at']).orderBy('name').execute() }));
    });

    app.post('/api/hub/connectors', async (req, reply) => {
      const a = requirePermission(req, 'platform:hub.manage');
      const input = parse(ConnectorInput, req.body);
      const id = await p.database.withTenant(a.tenantId, async (tx) => {
        const id = newId();
        await tx.insertInto('hub_connector').values({ id, tenant_id: a.tenantId, name: input.name, spec: JSON.stringify(input.spec) }).execute().catch((e) => {
          if (e?.code === '23505') throw new CommandError(409, 'name_taken', `a connector named ${input.name} exists`);
          throw e;
        });
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:hub.connector_created', resourceType: 'platform::HubConnector', resourceId: id, correlationId: correlationId(req) });
        return id;
      });
      return reply.code(201).send({ id });
    });

    /** Dry run of a connector over a sample event (http steps are not sent). */
    app.post('/api/hub/connectors/test', async (req) => {
      const a = requirePermission(req, 'platform:hub.manage');
      const input = parse(z.object({ spec: ConnectorInput.shape.spec, event: z.record(z.string(), z.unknown()).optional() }), req.body);
      const sample: EventEnvelope = {
        id: newId(),
        type: 'order.created',
        version: 1,
        tenant_id: a.tenantId,
        app: 'ordering',
        occurred_at: new Date().toISOString(),
        traceparent: null,
        correlation_id: 'test',
        causation_id: null,
        origin: 'user',
        workflow_hop: 0,
        workflow_chain: [],
        data: { order_id: newId(), number: 1001, total: 76000, channel: 'web' },
        schema_ref: 'aod://ordering/order.created/v1',
        ...(input.event as object),
      };
      return runConnector(p, input.spec, sample, null, { dryRun: true });
    });

    // ------------------------------------------------------------ two-way sync

    app.get('/api/hub/syncs', async (req) => {
      const a = requirePermission(req, 'platform:hub.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const syncs = await tx.selectFrom('hub_sync').selectAll().orderBy('name').execute();
        const counts = await tx.selectFrom('external_id_map').select(['sync_id', sql<number>`count(*)::int`.as('n')]).groupBy('sync_id').execute();
        return { syncs: syncs.map((s) => ({ ...s, mapped: counts.find((c) => c.sync_id === s.id)?.n ?? 0, inbound_url: `${p.env.PUBLIC_URL}/v1/sync/${s.id}` })) };
      });
    });

    app.post('/api/hub/syncs', async (req, reply) => {
      const a = requirePermission(req, 'platform:hub.manage');
      const input = parse(SyncInput, req.body);
      const id = await p.database.withTenant(a.tenantId, async (tx) => {
        await loadEntity(tx, input.entity);
        if (input.endpoint_id) {
          const e = await tx.selectFrom('hub_endpoint').select('kind').where('id', '=', input.endpoint_id).executeTakeFirst();
          if (!e || !['webhook', 'rest_push'].includes(e.kind)) throw new CommandError(422, 'invalid_endpoint', 'outbound sync needs a webhook or REST push endpoint');
        }
        const id = newId();
        await tx.insertInto('hub_sync').values({ id, tenant_id: a.tenantId, name: input.name, entity: input.entity, endpoint_id: input.endpoint_id ?? null, conflict_rule: input.conflict_rule, field_map: JSON.stringify(input.field_map) }).execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:hub.sync_created', resourceType: 'platform::HubSync', resourceId: id, correlationId: correlationId(req) });
        return id;
      });
      return reply.code(201).send({ id, inbound_url: `${p.env.PUBLIC_URL}/v1/sync/${id}` });
    });
  };
}
