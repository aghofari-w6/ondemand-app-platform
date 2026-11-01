import { CommandError, Definition, FieldDef } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Platform } from '../../platform/context.ts';
import { computeImpact, definitionContext, discardDraft, getDraft, openDraft, publishDraft, publishedDefinition, rollbackTo, saveDraft, sendJobs, validateForPublish } from '../../platform/datastudio.ts';
import { getRecord, listRecords, executeRecordWrite } from '../../platform/records.ts';
import { linksFor } from '../../platform/links.ts';
import { correlationId, parse, requireAuth, requirePermission } from '../app.ts';
import { validateDefinition } from '@aod/shared';

const UUID = z.uuid();

export function dataStudioRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    // ------------------------------------------------------------ Data studio (metadata)

    app.get('/api/datastudio', async (req) => {
      const a = requirePermission(req, 'platform:datastudio.manage');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const pub = await publishedDefinition(tx);
        const draft = await getDraft(tx);
        const t = await tx.selectFrom('tenant').select('plan').executeTakeFirstOrThrow();
        const ctx = await definitionContext(p, tx, t.plan);
        const history = await tx.selectFrom('metadata_version').select(['number', 'status', 'note', 'based_on', 'created_by', 'created_at', 'published_at', 'impact']).where('status', '<>', 'draft').orderBy('number', 'desc').limit(50).execute();
        const backfills = await tx.selectFrom('backfill_run').selectAll().orderBy('created_at', 'desc').limit(20).execute();
        const indexes = await tx.selectFrom('index_request').selectAll().orderBy('created_at', 'desc').limit(20).execute();
        const roles = await tx.selectFrom('custom_role').select(['id', 'name']).execute();
        const draftDef = draft ? Definition.parse(draft.definition) : null;
        return {
          published: pub,
          draft: draft ? { number: draft.number, version: draft.version, note: draft.note, definition: draftDef, problems: validateDefinition(draftDef!, ctx) } : null,
          history,
          backfills,
          indexes,
          context: { appEntities: Object.keys(ctx.appEntities), allAppEntities: ctx.allAppEntities, roles: [...ctx.roles.filter((r) => !/^[0-9a-f-]{36}$/.test(r)).map((r) => ({ id: r, name: r })), ...roles], limits: ctx.limits },
        };
      });
    });

    app.post('/api/datastudio/draft', async (req, reply) => {
      const a = requirePermission(req, 'platform:datastudio.manage');
      const d = await p.database.withTenant(a.tenantId, (tx) => openDraft(p, tx, a.tenantId, a.principal, correlationId(req)));
      return reply.code(201).send({ number: d.number, version: d.version });
    });

    app.put('/api/datastudio/draft', async (req) => {
      const a = requirePermission(req, 'platform:datastudio.manage');
      const input = parse(z.object({ definition: z.unknown(), version: z.int().positive(), note: z.string().max(500).optional() }), req.body);
      const d = await p.database.withTenant(a.tenantId, (tx) => saveDraft(p, tx, a.tenantId, a.principal, input.definition, input.version, input.note, correlationId(req)));
      return { number: d.number, version: d.version };
    });

    app.delete('/api/datastudio/draft', async (req) => {
      const a = requirePermission(req, 'platform:datastudio.manage');
      await p.database.withTenant(a.tenantId, (tx) => discardDraft(p, tx, a.tenantId, a.principal, correlationId(req)));
      return { ok: true };
    });

    /** Impact summary of the draft against the published version (nothing is changed). */
    app.get('/api/datastudio/draft/impact', async (req) => {
      const a = requirePermission(req, 'platform:datastudio.manage');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const draft = await getDraft(tx);
        if (!draft) throw new CommandError(404, 'no_draft', 'there is no draft');
        const def = Definition.parse(draft.definition);
        const t = await tx.selectFrom('tenant').select('plan').executeTakeFirstOrThrow();
        const problems = validateDefinition(def, await definitionContext(p, tx, t.plan));
        const impact = await computeImpact(p, tx, (await publishedDefinition(tx)).definition, def);
        return { problems, impact };
      });
    });

    app.post('/api/datastudio/draft/publish', async (req) => {
      const a = requirePermission(req, 'platform:datastudio.manage');
      const { version } = parse(z.object({ version: z.int().positive() }), req.body);
      const r = await p.database.withTenant(a.tenantId, (tx) => publishDraft(p, tx, a.tenantId, a.principal, version, correlationId(req)));
      await sendJobs(p, r.jobs);
      return { number: r.number, impact: r.impact };
    });

    app.post('/api/datastudio/rollback', async (req) => {
      const a = requirePermission(req, 'platform:datastudio.manage');
      const { number } = parse(z.object({ number: z.int().positive() }), req.body);
      const r = await p.database.withTenant(a.tenantId, (tx) => rollbackTo(p, tx, a.tenantId, a.principal, number, correlationId(req)));
      await sendJobs(p, r.jobs);
      return { number: r.number, impact: r.impact };
    });

    /** Quick add of one custom field on an app entity: a one-change version, published at once. */
    app.post('/api/fields', async (req, reply) => {
      const a = requirePermission(req, 'platform:datastudio.manage');
      const input = parse(z.object({ app: z.string(), entity: z.string(), field: FieldDef }), req.body);
      const r = await p.database.withTenant(a.tenantId, async (tx) => {
        if (await getDraft(tx)) throw new CommandError(409, 'draft_open', 'a Data studio draft is open; add the field there');
        const draft = await openDraft(p, tx, a.tenantId, a.principal, correlationId(req));
        const def = Definition.parse(draft.definition);
        let set = def.app_fields.find((s) => s.app === input.app && s.entity === input.entity);
        if (!set) def.app_fields.push((set = { app: input.app, entity: input.entity, fields: [] }));
        set.fields.push(input.field);
        await validateForPublish(p, tx, def);
        const saved = await saveDraft(p, tx, a.tenantId, a.principal, def, draft.version, `add field ${input.field.key}`, correlationId(req));
        return publishDraft(p, tx, a.tenantId, a.principal, saved.version, correlationId(req));
      });
      await sendJobs(p, r.jobs);
      return reply.code(201).send({ number: r.number });
    });

    // ------------------------------------------------------------ data model for screens

    app.get('/api/data-model', async (req) => {
      const a = requireAuth(req);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const { definition, number } = await publishedDefinition(tx);
        return { number, entities: definition.entities, layouts: definition.layouts, app_fields: definition.app_fields };
      });
    });

    // ------------------------------------------------------------ custom records

    const listQuery = (q: Record<string, string>) => {
      const filters: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(q)) if (k.startsWith('f.') && v) filters[k.slice(2)] = v.split(',').slice(0, 20);
      const base = parse(z.object({ q: z.string().max(200).optional(), sort: z.string().max(60).optional(), cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), { q: q.q, sort: q.sort, cursor: q.cursor, limit: q.limit });
      return { ...base, filters } as any;
    };

    app.get('/api/data/:entity', async (req) => {
      const a = requireAuth(req);
      const { entity } = req.params as { entity: string };
      return p.database.withTenant(a.tenantId, (tx) => listRecords(p, tx, a.principal, entity, listQuery(req.query as Record<string, string>)));
    });

    app.get('/api/data/:entity/:id', async (req) => {
      const a = requireAuth(req);
      const { entity, id } = req.params as { entity: string; id: string };
      return p.database.withTenant(a.tenantId, (tx) => getRecord(p, tx, a.principal, entity, id));
    });

    const write = async (req: any, reply: any, op: 'create' | 'update' | 'delete') => {
      const a = requireAuth(req);
      const { entity, id } = req.params as { entity: string; id?: string };
      const body = op === 'delete' ? { version: Number((req.query as { version?: string }).version) } : parse(z.object({ values: z.record(z.string(), z.unknown()), version: z.int().positive().optional() }), req.body);
      const key = req.headers['idempotency-key'];
      const r = await executeRecordWrite(p, {
        tenantId: a.tenantId,
        principal: a.principal,
        entity,
        op,
        ...(id ? { id: parse(UUID, id) } : {}),
        ...('version' in body && body.version ? { version: body.version } : {}),
        ...('values' in body ? { values: body.values } : {}),
        idempotencyKey: typeof key === 'string' ? key : undefined,
        correlationId: correlationId(req),
      });
      if (r.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(r.status).send(r.body);
    };
    app.post('/api/data/:entity', (req, reply) => write(req, reply, 'create'));
    app.patch('/api/data/:entity/:id', (req, reply) => write(req, reply, 'update'));
    app.delete('/api/data/:entity/:id', (req, reply) => write(req, reply, 'delete'));

    // ------------------------------------------------------------ link index

    app.get('/api/links', async (req) => {
      const a = requireAuth(req);
      const q = parse(z.object({ type: z.string().regex(/^[a-z][a-z0-9_]*::[A-Z][A-Za-z0-9]*$/), id: z.string().min(1).max(100) }), req.query);
      return p.database.withTenant(a.tenantId, (tx) => linksFor(p, tx, a.principal, q.type, q.id));
    });
  };
}
