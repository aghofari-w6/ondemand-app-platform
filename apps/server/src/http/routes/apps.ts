import { action, authorize, CommandError, DeprovisionInput, ProvisionInput } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { systemPrincipal } from '../../auth/principal.ts';
import { newId, type Tx } from '../../db/database.ts';
import { activeApps, executeCommand } from '../../platform/commands.ts';
import type { Platform } from '../../platform/context.ts';
import { fieldDefinitions } from '../../platform/fields.ts';
import { enqueueStep, retryRun, rollbackRun, runSnapshot, SAGAS, startRun, type RunKind } from '../../platform/provisioning.ts';
import { recordChange } from '../../platform/record.ts';
import { getEntity, listEntity } from '../../platform/workspace.ts';
import { correlationId, parse, requireAuth, requirePermission } from '../app.ts';

const UUID = z.uuid();

async function requireActiveApp(tx: Tx, app: string) {
  const row = await tx.selectFrom('installed_app').select(['status', 'config', 'version']).where('app', '=', app).where('status', '=', 'active').executeTakeFirst();
  if (!row) throw new CommandError(409, 'app_not_active', `${app} is not active in this workspace`);
  return row;
}

export function appRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    // ------------------------------------------------------------ catalog

    app.get('/api/catalog', async (req) => {
      const a = requirePermission(req, 'platform:catalog.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const t = await tx.selectFrom('tenant').select(['plan', 'status']).executeTakeFirstOrThrow();
        const plan = p.ports.billing.plan(t.plan);
        const installed = await tx.selectFrom('installed_app').selectAll().where('status', '<>', 'removed').execute();
        const pins = await tx.selectFrom('app_pin').selectAll().execute();
        const runs = await tx.selectFrom('provisioning_run').select(['id', 'app', 'status', 'kind']).where('status', 'in', ['running', 'failed', 'compensating']).execute();
        const active = installed.filter((i) => i.status === 'active').map((i) => i.app);
        const used = installed.filter((i) => ['provisioning', 'active', 'failed', 'deprovisioning'].includes(i.status)).length;
        const apps = p.catalog.manifests().map((m) => {
          const inst = installed.find((i) => i.app === m.id);
          const reasons: string[] = [];
          if (!plan?.packages.includes(m.package)) reasons.push(`Not in the ${plan?.label ?? t.plan} plan (needs ${m.package})`);
          if (used >= (plan?.appSlots ?? 0) && !inst) reasons.push(`All ${plan?.appSlots} app slots are in use`);
          const missing = m.dependencies.requires.filter((d) => !active.includes(d));
          if (missing.length) reasons.push(`Requires ${missing.map((d) => p.catalog.get(d)!.manifest.name).join(', ')}`);
          if (t.status !== 'trial' && t.status !== 'active') reasons.push(`Workspace is ${t.status}`);
          const ch = p.config.channels[m.id]!;
          return {
            id: m.id,
            name: m.name,
            description: m.description,
            package: m.package,
            releases: m.releases.map((r) => ({ version: r.version, channel: r.channel, notes: r.notes })),
            channels: ch,
            dependencies: m.dependencies,
            installed: inst ? { status: inst.status, version: inst.version, channel: inst.channel, retainedUntil: inst.retained_until } : null,
            pin: pins.find((x) => x.app === m.id)?.version ?? null,
            openRun: runs.find((r) => r.app === m.id) ?? null,
            canProvision: reasons.length === 0 && (!inst || ['retained', 'failed'].includes(inst.status)),
            reasons,
            capabilities: p.config.capabilities.filter((c) => c.when_installed.includes(m.id)).map((c) => ({ id: c.id, label: c.label, with: c.when_installed.filter((x) => x !== m.id), active: p.catalog.activeCapabilities(active).includes(c.id) })),
            upgradeAvailable: inst?.status === 'active' && p.catalog.isUpgrade(inst.version, p.catalog.channelVersion(m.id, inst.channel as 'stable' | 'canary')) ? p.catalog.channelVersion(m.id, inst.channel as 'stable' | 'canary') : null,
          };
        });
        return { plan: { id: t.plan, label: plan?.label, slots: plan?.appSlots ?? 0, used, packages: plan?.packages ?? [] }, apps };
      });
    });

    const start = async (req: any, kind: RunKind, extra: { channel?: 'stable' | 'canary'; mode?: 'retain' | 'purge' }) => {
      const a = requirePermission(req, 'platform:apps.provision');
      const { app: appId } = req.params as { app: string };
      const runId = await p.database.withTenant(a.tenantId, (tx) => startRun(p, tx, { tenantId: a.tenantId, app: appId, kind, actor: a.principal, correlationId: correlationId(req), ...extra }));
      await enqueueStep(p, a.tenantId, runId, SAGAS[kind][0]!.name);
      return { runId };
    };

    app.post('/api/apps/:app/provision', async (req, reply) => {
      const input = parse(ProvisionInput.omit({ app: true }), req.body ?? {});
      return reply.code(202).send(await start(req, 'provision', input.channel ? { channel: input.channel } : {}));
    });
    app.post('/api/apps/:app/deprovision', async (req, reply) => {
      const input = parse(DeprovisionInput, req.body);
      return reply.code(202).send(await start(req, 'deprovision', { mode: input.mode }));
    });
    app.post('/api/apps/:app/upgrade', async (req, reply) => {
      const input = parse(z.object({ channel: z.enum(['stable', 'canary']).optional() }), req.body ?? {});
      return reply.code(202).send(await start(req, 'upgrade', input.channel ? { channel: input.channel } : {}));
    });

    app.put('/api/apps/:app/pin', async (req) => {
      const a = requirePermission(req, 'platform:apps.provision');
      const { app: appId } = req.params as { app: string };
      const { version } = parse(z.object({ version: z.string() }), req.body);
      if (!p.catalog.release(appId, version)) throw new CommandError(422, 'unknown_version', `unknown version ${version}`);
      await p.database.withTenant(a.tenantId, async (tx) => {
        await tx.insertInto('app_pin').values({ tenant_id: a.tenantId, app: appId, version }).onConflict((oc) => oc.columns(['tenant_id', 'app']).doUpdateSet({ version, pinned_at: new Date() })).execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:app.pinned', resourceType: 'platform::App', resourceId: appId, correlationId: correlationId(req), events: [{ type: 'app.pinned', data: { app: appId, version } }] });
      });
      return { ok: true };
    });
    app.delete('/api/apps/:app/pin', async (req) => {
      const a = requirePermission(req, 'platform:apps.provision');
      const { app: appId } = req.params as { app: string };
      await p.database.withTenant(a.tenantId, async (tx) => {
        await tx.deleteFrom('app_pin').where('app', '=', appId).execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:app.unpinned', resourceType: 'platform::App', resourceId: appId, correlationId: correlationId(req), events: [{ type: 'app.unpinned', data: { app: appId } }] });
      });
      return { ok: true };
    });

    // ------------------------------------------------------------ provisioning runs

    app.get('/api/provisioning/runs', async (req) => {
      const a = requirePermission(req, 'platform:catalog.read');
      return p.database.withTenant(a.tenantId, async (tx) => ({
        runs: await tx.selectFrom('provisioning_run').select(['id', 'app', 'kind', 'status', 'target_version', 'error', 'created_at', 'finished_at']).orderBy('created_at', 'desc').limit(30).execute(),
      }));
    });

    app.get('/api/provisioning/runs/:id', async (req) => {
      const a = requirePermission(req, 'platform:catalog.read');
      const id = parse(UUID, (req.params as { id: string }).id);
      const snap = await p.database.withTenant(a.tenantId, (tx) => runSnapshot(tx, id));
      if (!snap) throw new CommandError(404, 'not_found', 'run not found');
      return snap;
    });

    /** Live checklist: Server-Sent Events with the run snapshot whenever it changes. */
    app.get('/api/provisioning/runs/:id/stream', async (req, reply) => {
      const a = requirePermission(req, 'platform:catalog.read');
      const id = parse(UUID, (req.params as { id: string }).id);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      let last = '';
      let closed = false;
      req.raw.on('close', () => {
        closed = true;
      });
      const deadline = Date.now() + 10 * 60_000;
      while (!closed && Date.now() < deadline) {
        let snap: Awaited<ReturnType<typeof runSnapshot>>;
        try {
          snap = await p.database.withTenant(a.tenantId, (tx) => runSnapshot(tx, id));
        } catch (e) {
          p.log.error({ err: String(e), run: id }, 'provisioning stream: reading the run failed');
          res.write(`event: error\ndata: ${JSON.stringify({ message: 'could not read the run; reload to retry' })}\n\n`);
          break;
        }
        if (!snap) {
          res.write(`event: error\ndata: ${JSON.stringify({ message: 'run not found' })}\n\n`);
          break;
        }
        const json = JSON.stringify(snap);
        if (json !== last) {
          res.write(`event: run\ndata: ${json}\n\n`);
          last = json;
        } else res.write(': keep-alive\n\n');
        if (['succeeded', 'compensated'].includes(snap.status)) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      res.end();
    });

    app.post('/api/provisioning/runs/:id/retry', async (req) => {
      const a = requirePermission(req, 'platform:apps.provision');
      await retryRun(p, a.tenantId, parse(UUID, (req.params as { id: string }).id), a.principal, correlationId(req));
      return { ok: true };
    });
    app.post('/api/provisioning/runs/:id/rollback', async (req) => {
      const a = requirePermission(req, 'platform:apps.provision');
      await rollbackRun(p, a.tenantId, parse(UUID, (req.params as { id: string }).id), a.principal, correlationId(req));
      return { ok: true };
    });

    /** Demo only: make one provisioning step fail once, to show retry and rollback. */
    app.post('/api/provisioning/fail-once', async (req) => {
      const a = requirePermission(req, 'platform:apps.provision');
      if (!p.env.DEMO_MODE) throw new CommandError(404, 'not_found', 'not found');
      const { step } = parse(z.object({ step: z.string() }), req.body);
      await p.database.withTenant(a.tenantId, (tx) =>
        tx.insertInto('tenant_flag').values({ tenant_id: a.tenantId, key: 'provisioning.fail_once', value: JSON.stringify({ step }) }).onConflict((oc) => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify({ step }) })).execute(),
      );
      return { ok: true };
    });

    // ------------------------------------------------------------ app metadata, commands, workspaces

    app.get('/api/apps/:app/meta', async (req) => {
      const a = requireAuth(req);
      const { app: appId } = req.params as { app: string };
      const ca = p.catalog.get(appId);
      if (!ca) throw new CommandError(404, 'unknown_app', 'unknown app');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const inst = await tx.selectFrom('installed_app').select(['status', 'version', 'channel']).where('app', '=', appId).where('status', '<>', 'removed').executeTakeFirst();
        const m = ca.manifest;
        const fields: Record<string, unknown> = {};
        for (const e of m.entities.filter((x) => x.custom_fields)) fields[e.name] = await fieldDefinitions(tx, appId, e.name);
        const can = (perm: string) => authorize(a.principal, action(perm), { type: 'platform::Tenant', id: a.tenantId, tenantId: a.tenantId }).decision === 'allow';
        return {
          id: m.id,
          name: m.name,
          installed: inst ?? null,
          entities: m.entities.filter((e) => e.workspace),
          views: m.views,
          commands: m.commands.map((c) => ({ name: c.name, description: c.description, allowed: can(c.permission) })),
          customFields: fields,
          config: { ...m.config },
        };
      });
    });

    app.post('/api/apps/:app/commands/:command', async (req, reply) => {
      const a = requireAuth(req);
      const { app: appId, command } = req.params as { app: string; command: string };
      const key = req.headers['idempotency-key'];
      const res = await executeCommand(p, {
        tenantId: a.tenantId,
        principal: a.principal,
        app: appId,
        command,
        input: req.body ?? {},
        idempotencyKey: typeof key === 'string' ? key : undefined,
        origin: req.headers['x-aod-origin'] === 'pos-offline' ? 'pos-offline' : 'user',
        correlationId: correlationId(req),
      });
      if (res.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(res.status).send(res.body);
    });

    app.get('/api/apps/:app/entities/:entity', async (req) => {
      const a = requireAuth(req);
      const { app: appId, entity } = req.params as { app: string; entity: string };
      const q = req.query as Record<string, string>;
      const filters: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(q)) if (k.startsWith('f.') && v) filters[k.slice(2)] = v.split(',').slice(0, 20);
      const query = parse(z.object({ q: z.string().max(200).optional(), sort: z.string().max(60).optional(), cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), view: z.string().max(60).optional() }), {
        q: q.q,
        sort: q.sort,
        cursor: q.cursor,
        limit: q.limit,
        view: q.view,
      });
      return p.database.withTenant(a.tenantId, async (tx) => {
        await requireActiveApp(tx, appId);
        return listEntity(p, tx, a.principal, appId, entity, { ...query, filters } as any);
      });
    });

    app.get('/api/apps/:app/entities/:entity/:id', async (req) => {
      const a = requireAuth(req);
      const { app: appId, entity, id } = req.params as { app: string; entity: string; id: string };
      return p.database.withTenant(a.tenantId, async (tx) => {
        await requireActiveApp(tx, appId);
        return getEntity(p, tx, a.principal, appId, entity, id);
      });
    });

    app.get('/api/apps/:app/queries/:name', async (req) => {
      const a = requireAuth(req);
      const { app: appId, name } = req.params as { app: string; name: string };
      const q = p.catalog.get(appId)?.template.queries?.[name];
      if (!q) throw new CommandError(404, 'unknown_query', 'unknown query');
      const d = authorize(a.principal, action(q.permission), { type: 'platform::Tenant', id: a.tenantId, tenantId: a.tenantId });
      if (d.decision === 'deny') throw new CommandError(403, 'forbidden', `missing permission ${q.permission}`);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const inst = await requireActiveApp(tx, appId);
        return q.run({ tx, tenantId: a.tenantId, now: () => new Date(), newId, config: { ...p.catalog.get(appId)!.manifest.config, ...(inst.config as object) } }, req.query as Record<string, string>);
      });
    });

    // ------------------------------------------------------------ custom fields

    app.get('/api/fields', async (req) => {
      const a = requireAuth(req);
      const q = parse(z.object({ app: z.string(), entity: z.string() }), req.query);
      return p.database.withTenant(a.tenantId, async (tx) => ({ fields: await fieldDefinitions(tx, q.app, q.entity) }));
    });

    // ------------------------------------------------------------ public inbound (e.g. carrier callbacks)

    app.post('/v1/inbound/:tenantId/:app/:name/:param', async (req, reply) => {
      const { tenantId, app: appId, name, param } = req.params as Record<string, string>;
      if (!UUID.safeParse(tenantId).success) throw new CommandError(404, 'not_found', 'not found');
      const inbound = p.catalog.get(appId!)?.template.inbound?.[name!];
      if (!inbound) throw new CommandError(404, 'not_found', 'not found');
      const request = { tenantId: tenantId!, params: { [name === 'carrier' ? 'carrier' : 'param']: param! }, body: req.body, headers: req.headers as Record<string, string | undefined> };
      const res = await p.database.withTenant(tenantId!, async (tx) => {
        const active = await activeApps(tx);
        if (!active.includes(appId!)) throw new CommandError(404, 'not_found', 'not found');
        if (!(await inbound.verify({ tx, tenantId: tenantId!, now: () => new Date(), newId }, request))) throw new CommandError(401, 'unauthenticated', 'invalid token');
        let cmd;
        try {
          cmd = inbound.toCommand(request);
        } catch (e) {
          throw new CommandError(422, 'invalid_input', (e as Error).message);
        }
        return executeCommand(
          p,
          { tenantId: tenantId!, principal: systemPrincipal(tenantId!, `inbound:${appId}:${name}`), app: appId!, command: cmd.command, input: cmd.input, idempotencyKey: cmd.idempotencyKey, origin: 'carrier', correlationId: correlationId(req) },
          tx,
        );
      });
      return reply.code(res.status === 201 ? 202 : 200).send({ ok: true, replayed: res.replayed, result: res.body });
    });
  };
}
