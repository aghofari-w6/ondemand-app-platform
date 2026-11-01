import { CommandError, EventEnvelope, ROLE_PRESETS } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { activeApps } from '../../platform/commands.ts';
import type { Platform } from '../../platform/context.ts';
import { decideApproval, listApprovals } from '../../platform/approvals.ts';
import { publishedDefinition } from '../../platform/datastudio.ts';
import { traceQuery } from '../../platform/trace.ts';
import { checkGraph, createWorkflow, discardWorkflowDraft, getWorkflow, publishWorkflow, rollbackWorkflow, saveDraft, setWorkflowStatus } from '../../platform/workflows/definitions.ts';
import { dryRun } from '../../platform/workflows/dryrun.ts';
import { cancelRun, retryRun } from '../../platform/workflows/engine.ts';
import { correlationId, parse, requireAuth, requirePermission } from '../app.ts';

const UUID = z.uuid();
const idParam = (req: { params: unknown }) => parse(UUID, (req.params as { id: string }).id);

const CreateBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  template: z.object({ app: z.string().min(1), name: z.string().min(1) }).optional(),
  graph: z.unknown().optional(),
});
const DraftBody = z.object({ graph: z.unknown(), version: z.int().positive().optional(), note: z.string().max(200).optional() });
const PublishBody = z.object({ version: z.int().positive(), service_role: z.string().min(1).max(80) });
const TestBody = z.object({
  graph: z.unknown().optional(),
  event_id: z.uuid().optional(),
  sample: z.object({ data: z.record(z.string(), z.unknown()) }).optional(),
  approval: z.enum(['approved', 'rejected', 'expired']).optional(),
  wait: z.enum(['event', 'timeout']).optional(),
});

function jsonSchemaOf(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return {};
  }
}

export function workflowRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    /** What the editor can offer: events, commands (with input schemas), entities, endpoints, roles, users, templates. */
    app.get('/api/workflows/meta', async (req) => {
      const a = requirePermission(req, 'platform:workflows.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const active = new Set(await activeApps(tx));
        const manifests = p.catalog.manifests().filter((m) => active.has(m.id));
        const events = manifests.flatMap((m) => m.events.publishes.map((e) => ({ type: e.type, app: m.id, description: e.description ?? '', data: e.data ?? [] })));
        events.push(...['created', 'updated', 'deleted'].map((v) => ({ type: `record.${v}`, app: 'custom', description: `A custom record was ${v}.`, data: ['entity', 'record_id', 'version', 'values', 'changed'] })));
        const commands = manifests.flatMap((m) =>
          m.commands.map((c) => ({ app: m.id, command: c.name, description: c.description ?? '', permission: c.permission, may_emit: c.may_emit, input: jsonSchemaOf(p.catalog.command(m.id, c.name)!.spec.input) })),
        );
        const { definition } = await publishedDefinition(tx);
        const endpoints = await tx.selectFrom('hub_endpoint').select(['id', 'name', 'kind']).orderBy('name').execute();
        const custom = await tx.selectFrom('custom_role').select(['id', 'name']).orderBy('name').execute();
        const users = await tx.selectFrom('app_user').select(['id', 'name', 'role']).where('status', '=', 'active').orderBy('name').execute();
        const templates = manifests.flatMap((m) => m.workflows.templates.map((t) => ({ app: m.id, name: t.name, label: t.label, trigger: t.trigger })));
        return {
          events,
          commands,
          entities: definition.entities.map((e) => ({ key: e.key, label: e.label, fields: e.fields.filter((f) => !f.formula).map((f) => ({ key: f.key, label: f.label, type: f.type })) })),
          endpoints,
          roles: [...ROLE_PRESETS.map((r) => ({ id: r, name: r })), ...custom],
          users,
          templates,
        };
      });
    });

    app.get('/api/workflows', async (req) => {
      const a = requirePermission(req, 'platform:workflows.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const rows = await tx.selectFrom('workflow').selectAll().orderBy('name').execute();
        const versions = await tx.selectFrom('workflow_version').select(['workflow_id', 'number', 'status', 'trigger_event', 'service_role']).where('status', 'in', ['draft', 'published']).execute();
        const stats = await tx
          .selectFrom('workflow_run')
          .select(['workflow_id', 'status', sql<number>`count(*)::int`.as('n'), sql<Date>`max(started_at)`.as('last')])
          .where('started_at', '>', sql<Date>`now() - interval '30 days'`)
          .groupBy(['workflow_id', 'status'])
          .execute();
        return {
          workflows: rows.map((w) => {
            const mine = versions.filter((v) => v.workflow_id === w.id);
            const s = stats.filter((x) => x.workflow_id === w.id);
            return {
              ...w,
              published: mine.find((v) => v.status === 'published') ?? null,
              draft: mine.find((v) => v.status === 'draft') ?? null,
              runs_30d: Object.fromEntries(s.map((x) => [x.status, x.n])),
              last_run_at: s.reduce<Date | null>((m, x) => (!m || x.last > m ? x.last : m), null),
            };
          }),
        };
      });
    });

    app.post('/api/workflows', async (req, reply) => {
      const a = requirePermission(req, 'platform:workflows.manage');
      const body = parse(CreateBody, req.body);
      const r = await p.database.withTenant(a.tenantId, (tx) => createWorkflow(p, tx, a.tenantId, a.principal, body, correlationId(req)));
      return reply.code(201).send(r);
    });

    app.get('/api/workflows/:id', async (req) => {
      const a = requirePermission(req, 'platform:workflows.read');
      const id = idParam(req);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const w = await getWorkflow(tx, id);
        const versions = await tx.selectFrom('workflow_version').select(['id', 'number', 'status', 'trigger_event', 'based_on', 'note', 'created_by', 'created_at', 'published_by', 'published_at', 'service_role', 'version']).where('workflow_id', '=', id).orderBy('number', 'desc').execute();
        const current = versions.find((v) => v.status === 'draft') ?? versions.find((v) => v.status === 'published') ?? null;
        const graph = current ? (await tx.selectFrom('workflow_version').select('graph').where('id', '=', current.id).executeTakeFirstOrThrow()).graph : null;
        const check = graph ? await checkGraph(p, tx, graph) : { problems: [] };
        return { workflow: w, current, graph, problems: check.problems, versions };
      });
    });

    app.get('/api/workflows/:id/versions/:number', async (req) => {
      const a = requirePermission(req, 'platform:workflows.read');
      const id = idParam(req);
      const number = parse(z.coerce.number().int().positive(), (req.params as { number: string }).number);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const v = await tx.selectFrom('workflow_version').selectAll().where('workflow_id', '=', id).where('number', '=', number).executeTakeFirst();
        if (!v) throw new CommandError(404, 'not_found', 'version not found');
        return { version: v };
      });
    });

    app.put('/api/workflows/:id/draft', async (req) => {
      const a = requirePermission(req, 'platform:workflows.manage');
      const id = idParam(req);
      const body = parse(DraftBody, req.body);
      return p.database.withTenant(a.tenantId, (tx) => saveDraft(p, tx, a.tenantId, a.principal, id, body.graph, body.version, body.note, correlationId(req)));
    });

    app.delete('/api/workflows/:id/draft', async (req) => {
      const a = requirePermission(req, 'platform:workflows.manage');
      const id = idParam(req);
      await p.database.withTenant(a.tenantId, (tx) => discardWorkflowDraft(p, tx, a.tenantId, a.principal, id, correlationId(req)));
      return { ok: true };
    });

    /** Validates a graph (the body's, or the current draft) without saving. */
    app.post('/api/workflows/validate', async (req) => {
      const a = requirePermission(req, 'platform:workflows.read');
      const body = parse(z.object({ graph: z.unknown() }), req.body);
      return p.database.withTenant(a.tenantId, async (tx) => ({ problems: (await checkGraph(p, tx, body.graph)).problems }));
    });

    app.post('/api/workflows/:id/publish', async (req) => {
      const a = requirePermission(req, 'platform:workflows.manage');
      const id = idParam(req);
      const body = parse(PublishBody, req.body);
      return p.database.withTenant(a.tenantId, (tx) => publishWorkflow(p, tx, a.tenantId, a.principal, id, body.version, body.service_role, correlationId(req)));
    });

    app.post('/api/workflows/:id/rollback', async (req) => {
      const a = requirePermission(req, 'platform:workflows.manage');
      const id = idParam(req);
      const body = parse(z.object({ number: z.int().positive(), service_role: z.string().min(1).optional() }), req.body);
      return p.database.withTenant(a.tenantId, (tx) => rollbackWorkflow(p, tx, a.tenantId, a.principal, id, body.number, body.service_role, correlationId(req)));
    });

    app.post('/api/workflows/:id/status', async (req) => {
      const a = requirePermission(req, 'platform:workflows.manage');
      const id = idParam(req);
      const { status } = parse(z.object({ status: z.enum(['active', 'disabled']) }), req.body);
      await p.database.withTenant(a.tenantId, (tx) => setWorkflowStatus(p, tx, a.tenantId, a.principal, id, status, correlationId(req)));
      return { ok: true };
    });

    /** Past events of the trigger's type, for picking a test-run sample. */
    app.get('/api/workflows/:id/samples', async (req) => {
      const a = requirePermission(req, 'platform:workflows.read');
      const id = idParam(req);
      const { event } = parse(z.object({ event: z.string().min(1).max(120) }), req.query);
      return p.database.withTenant(a.tenantId, async (tx) => {
        await getWorkflow(tx, id);
        const rows = await tx.selectFrom('event_log').select(['id', 'type', 'aggregateid', 'created_at']).where('type', '=', event).orderBy('seq', 'desc').limit(20).execute();
        return { events: rows };
      });
    });

    /** Test run: executes the given graph (or the current draft) without side effects. */
    app.post('/api/workflows/:id/test', async (req) => {
      const a = requirePermission(req, 'platform:workflows.manage');
      const id = idParam(req);
      const body = parse(TestBody, req.body);
      const { graph, event } = await p.database.withTenant(a.tenantId, async (tx) => {
        await getWorkflow(tx, id);
        let raw = body.graph;
        if (raw === undefined) {
          const v = await tx.selectFrom('workflow_version').select('graph').where('workflow_id', '=', id).where('status', 'in', ['draft', 'published']).orderBy('number', 'desc').executeTakeFirst();
          raw = v?.graph;
        }
        const checked = await checkGraph(p, tx, raw);
        if (!checked.graph) throw Object.assign(new CommandError(422, 'invalid_graph', checked.problems.join('; ')), { details: { problems: checked.problems } });
        const trigger = checked.graph.nodes.find((n) => n.type === 'trigger');
        let event: EventEnvelope;
        if (body.event_id) {
          const row = await tx.selectFrom('event_log').select('payload').where('id', '=', body.event_id).executeTakeFirst();
          if (!row) throw new CommandError(404, 'not_found', 'event not found');
          event = row.payload as EventEnvelope;
        } else {
          const type = String(trigger?.config.event ?? 'sample.event');
          event = {
            id: '00000000-0000-4000-8000-000000000000',
            type,
            version: 1,
            tenant_id: a.tenantId,
            app: type.split('.')[0] ?? 'sample',
            occurred_at: new Date().toISOString(),
            traceparent: null,
            correlation_id: 'test-run',
            causation_id: null,
            origin: 'user',
            workflow_hop: 0,
            workflow_chain: [],
            data: body.sample?.data ?? {},
            schema_ref: `aod://sample/${type}/v1`,
          };
        }
        return { graph: checked.graph, event };
      });
      return dryRun(p, graph, event, { ...(body.approval ? { approval: body.approval } : {}), ...(body.wait ? { wait: body.wait } : {}) });
    });

    // ---------------------------------------------------------------- runs

    app.get('/api/workflow-runs', async (req) => {
      const a = requirePermission(req, 'platform:workflows.read');
      const q = parse(z.object({ workflow_id: z.uuid().optional(), status: z.enum(['running', 'succeeded', 'failed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
      return p.database.withTenant(a.tenantId, async (tx) => {
        let s = tx.selectFrom('workflow_run as r').innerJoin('workflow as w', 'w.id', 'r.workflow_id').select(['r.id', 'r.workflow_id', 'w.name', 'r.version_number', 'r.status', 'r.error', 'r.correlation_id', 'r.hop', 'r.started_at', 'r.finished_at', 'r.trigger_event_id']).orderBy('r.started_at', 'desc').limit(q.limit);
        if (q.workflow_id) s = s.where('r.workflow_id', '=', q.workflow_id);
        if (q.status) s = s.where('r.status', '=', q.status);
        return { runs: await s.execute() };
      });
    });

    /** Execution view: the run, its version's graph and every node execution. */
    app.get('/api/workflow-runs/:id', async (req) => {
      const a = requirePermission(req, 'platform:workflows.read');
      const id = idParam(req);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const run = await tx.selectFrom('workflow_run').selectAll().where('id', '=', id).executeTakeFirst();
        if (!run) throw new CommandError(404, 'not_found', 'run not found');
        const w = await tx.selectFrom('workflow').select(['id', 'name']).where('id', '=', run.workflow_id).executeTakeFirstOrThrow();
        const v = await tx.selectFrom('workflow_version').select('graph').where('workflow_id', '=', run.workflow_id).where('number', '=', run.version_number).executeTakeFirstOrThrow();
        const nodes = await tx.selectFrom('workflow_node_run').select(['id', 'node_id', 'status', 'attempt', 'input', 'output', 'port', 'error', 'state', 'created_at', 'started_at', 'finished_at', 'not_before']).where('run_id', '=', id).orderBy('created_at').execute();
        const approvals = await tx.selectFrom('approval_request').select(['id', 'source_ref', 'title', 'status']).where('source', '=', 'workflow').where('source_ref', 'in', [...nodes.map((n) => n.id), '00000000-0000-0000-0000-000000000000']).execute();
        return { run, workflow: w, graph: v.graph, nodes, approvals };
      });
    });

    app.post('/api/workflow-runs/:id/retry', async (req) => {
      const a = requirePermission(req, 'platform:workflows.manage');
      const id = idParam(req);
      return p.database.withTenant(a.tenantId, (tx) => retryRun(p, tx, a.tenantId, a.principal, id, correlationId(req)));
    });

    app.post('/api/workflow-runs/:id/cancel', async (req) => {
      const a = requirePermission(req, 'platform:workflows.manage');
      const id = idParam(req);
      await p.database.withTenant(a.tenantId, (tx) => cancelRun(p, tx, a.tenantId, a.principal, id, correlationId(req)));
      return { ok: true };
    });

    // ---------------------------------------------------------------- approvals

    app.get('/api/approvals', async (req) => {
      const a = requireAuth(req);
      const { status } = parse(z.object({ status: z.enum(['pending', 'decided', 'all']).default('pending') }), req.query);
      return p.database.withTenant(a.tenantId, async (tx) => ({ requests: await listApprovals(tx, { id: a.user.id, role: a.user.role, principal: a.principal }, status) }));
    });

    app.post('/api/approvals/:id/decide', async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const body = parse(z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(1000).default('') }), req.body);
      return p.database.withTenant(a.tenantId, (tx) => decideApproval(p, tx, a.tenantId, { id: a.user.id, role: a.user.role, principal: a.principal }, id, body.decision, body.comment, correlationId(req)));
    });

    // ---------------------------------------------------------------- trace viewer

    app.get('/api/trace', async (req) => {
      const a = requirePermission(req, 'platform:trace.read');
      const { q } = parse(z.object({ q: z.string().trim().min(1).max(200) }), req.query);
      return p.database.withTenant(a.tenantId, (tx) => traceQuery(tx, q));
    });
  };
}
