import { AnalyticsQuery, CommandError, type ReportQuery } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Platform } from '../../platform/context.ts';
import { deleteDashboard, getDashboard, listDashboards, saveDashboard } from '../../platform/analytics/dashboards.ts';
import { analyticsEnabled, ensureMetrics } from '../../platform/analytics/metrics.ts';
import { assertCanView, filteredDims, queryMetric, visibleDimensionValues, visibleMetrics } from '../../platform/analytics/query.ts';
import { runReport, saveReport } from '../../platform/analytics/reports.ts';
import { recordChange } from '../../platform/record.ts';
import { correlationId, parse, requirePermission } from '../app.ts';

const UUID = z.uuid();
const DOWNLOAD_TTL_S = 15 * 60;

export function analyticsRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    const download = (tenantId: string, fileId: string | null) => (fileId ? `/api/files/download?token=${encodeURIComponent(p.ports.files.signToken(tenantId, fileId, DOWNLOAD_TTL_S))}` : null);

    /** Metrics the viewer may see; also starts backfills for new or changed metrics. */
    app.get('/api/analytics/metrics', async (req) => {
      const a = requirePermission(req, 'platform:analytics.read');
      const enabled = await p.database.withTenant(a.tenantId, (tx) => analyticsEnabled(p, tx));
      if (!enabled) return { enabled: false, metrics: [] };
      await ensureMetrics(p, a.tenantId);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const specs = await visibleMetrics(p, tx, a.principal);
        const states = await tx.selectFrom('metric_state').select(['metric', 'status', 'rebuilt_at']).execute();
        return {
          enabled: true,
          metrics: specs.map((s) => ({ id: s.id, label: s.label, app: s.app, unit: s.unit, aggregate: s.aggregate, dims: Object.keys(s.dims), status: states.find((x) => x.metric === s.id)?.status ?? 'pending' })),
        };
      });
    });

    app.post('/api/analytics/query', async (req) => {
      const a = requirePermission(req, 'platform:analytics.read');
      const q = parse(AnalyticsQuery, req.body);
      return p.database.withTenant(a.tenantId, (tx) => queryMetric(p, tx, a.principal, q));
    });

    /** Store and channel values for the filter pickers: only dimensions the viewer may see. */
    app.get('/api/analytics/dimensions', async (req) => {
      const a = requirePermission(req, 'platform:analytics.read');
      return p.database.withTenant(a.tenantId, (tx) => visibleDimensionValues(p, tx, a.principal));
    });

    // ------------------------------------------------------------ dashboards

    app.get('/api/dashboards', async (req) => {
      const a = requirePermission(req, 'platform:analytics.read');
      return p.database.withTenant(a.tenantId, async (tx) => ({ dashboards: await listDashboards(p, tx, a.principal, a.user.role) }));
    });

    app.get('/api/dashboards/:id', async (req) => {
      const a = requirePermission(req, 'platform:analytics.read');
      const id = parse(z.string().min(1).max(80), (req.params as { id: string }).id);
      return p.database.withTenant(a.tenantId, async (tx) => ({ dashboard: await getDashboard(p, tx, a.principal, a.user.role, id) }));
    });

    app.post('/api/dashboards', async (req, reply) => {
      const a = requirePermission(req, 'platform:analytics.manage');
      const r = await p.database.withTenant(a.tenantId, (tx) => saveDashboard(p, tx, a.tenantId, a.principal, req.body, correlationId(req)));
      return reply.code(201).send(r);
    });

    app.put('/api/dashboards/:id', async (req) => {
      const a = requirePermission(req, 'platform:analytics.manage');
      const id = parse(UUID, (req.params as { id: string }).id);
      const { version, ...rest } = (req.body ?? {}) as { version?: number };
      return p.database.withTenant(a.tenantId, (tx) => saveDashboard(p, tx, a.tenantId, a.principal, rest, correlationId(req), { id, version: parse(z.int().positive(), version) }));
    });

    app.delete('/api/dashboards/:id', async (req) => {
      const a = requirePermission(req, 'platform:analytics.manage');
      const id = parse(UUID, (req.params as { id: string }).id);
      await p.database.withTenant(a.tenantId, (tx) => deleteDashboard(p, tx, a.tenantId, a.principal, id, correlationId(req)));
      return { ok: true };
    });

    // ------------------------------------------------------------ reports

    app.get('/api/reports', async (req) => {
      const a = requirePermission(req, 'platform:analytics.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const reports = await tx.selectFrom('report').selectAll().orderBy('name').limit(200).execute();
        // Files of a report are only for viewers who could run it themselves (every metric,
        // its dimension and filters pass the same checks as a live query).
        const specs = await visibleMetrics(p, tx, a.principal);
        const canRun = (q: ReportQuery) =>
          q.metrics.every((m) => {
            const s = specs.find((x) => x.id === m);
            if (!s) return false;
            try {
              assertCanView(s, a.principal, q.group_by ?? null, filteredDims(q.filters ?? {}));
              return true;
            } catch {
              return false;
            }
          });
        const runs = reports.length ? await tx.selectFrom('report_run').selectAll().where('report_id', 'in', reports.map((r) => r.id)).orderBy('started_at', 'desc').limit(500).execute() : [];
        return {
          reports: reports.map((r) => ({
            can_run: canRun(r.query as ReportQuery),
            id: r.id,
            name: r.name,
            query: r.query,
            schedule: r.schedule,
            next_run_at: r.next_run_at,
            owner_id: r.owner_id,
            version: r.version,
            runs: runs
              .filter((x) => x.report_id === r.id)
              .slice(0, 10)
              .map((x) => ({ id: x.id, trigger: x.trigger, format: x.format, status: x.status, rows: x.rows, error: x.error, started_at: x.started_at, finished_at: x.finished_at, download_url: x.status === 'succeeded' && canRun(r.query as ReportQuery) ? download(a.tenantId, x.file_id as string | null) : null })),
          })),
        };
      });
    });

    app.post('/api/reports', async (req, reply) => {
      const a = requirePermission(req, 'platform:analytics.manage');
      const r = await p.database.withTenant(a.tenantId, (tx) => saveReport(p, tx, a.tenantId, a.principal, req.body, correlationId(req)));
      return reply.code(201).send(r);
    });

    app.put('/api/reports/:id', async (req) => {
      const a = requirePermission(req, 'platform:analytics.manage');
      const id = parse(UUID, (req.params as { id: string }).id);
      const { version, ...rest } = (req.body ?? {}) as { version?: number };
      return p.database.withTenant(a.tenantId, (tx) => saveReport(p, tx, a.tenantId, a.principal, rest, correlationId(req), { id, version: parse(z.int().positive(), version) }));
    });

    app.delete('/api/reports/:id', async (req) => {
      const a = requirePermission(req, 'platform:analytics.manage');
      const id = parse(UUID, (req.params as { id: string }).id);
      await p.database.withTenant(a.tenantId, async (tx) => {
        const r = await tx.selectFrom('report').select(['owner_id']).where('id', '=', id).executeTakeFirst();
        if (!r) throw new CommandError(404, 'not_found', 'report not found');
        const admin = a.principal.roles.some((x) => x.preset === 'Owner' || x.preset === 'Admin');
        if (r.owner_id !== a.principal.id && !admin) throw new CommandError(403, 'forbidden', 'only the owner or an Admin can delete this report');
        await tx.deleteFrom('report').where('id', '=', id).execute();
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:report.deleted', resourceType: 'platform::Report', resourceId: id, correlationId: correlationId(req), events: [{ type: 'report.deleted', data: { report_id: id } }] });
      });
      return { ok: true };
    });

    /** Run now (manual export) in CSV or PDF; returns a signed download link. */
    app.post('/api/reports/:id/run', async (req) => {
      const a = requirePermission(req, 'platform:analytics.read');
      const id = parse(UUID, (req.params as { id: string }).id);
      const { format } = parse(z.object({ format: z.enum(['csv', 'pdf']).default('csv') }), req.body ?? {});
      const r = await runReport(p, a.tenantId, a.principal, id, { format, trigger: 'manual', correlationId: correlationId(req) });
      return { ...r, download_url: download(a.tenantId, r.file_id) };
    });
  };
}

/** Signed, expiring file downloads (no session: the token is the grant). Streamed. */
export function fileRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    app.get('/api/files/download', async (req, reply) => {
      const { token } = parse(z.object({ token: z.string().min(10).max(600) }), req.query);
      const grant = p.ports.files.verifyToken(token);
      if (!grant) throw new CommandError(403, 'invalid_link', 'this download link is invalid or has expired');
      const f = await p.ports.files.open(grant.tenantId, grant.fileId);
      if (!f) throw new CommandError(404, 'not_found', 'the file no longer exists');
      const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      return reply
        .header('content-type', f.contentType)
        .header('content-length', String(f.size))
        .header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`)
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(f.stream);
    });
  };
}
