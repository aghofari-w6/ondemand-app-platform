import { action, authorize, CommandError } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Platform } from '../../platform/context.ts';
import { accessReview, exportAuditLog, piiInventory, runDsr, runRetention, saveRetentionPolicy } from '../../platform/governance.ts';
import { correlationId, parse, requirePermission } from '../app.ts';

const UUID = z.uuid();
const DOWNLOAD_TTL_S = 15 * 60;

export function governanceRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    const download = (tenantId: string, fileId: string | null) => (fileId ? `/api/files/download?token=${encodeURIComponent(p.ports.files.signToken(tenantId, fileId, DOWNLOAD_TTL_S))}` : null);

    app.get('/api/governance/pii', async (req) => {
      const a = requirePermission(req, 'platform:governance.read');
      return p.database.withTenant(a.tenantId, async (tx) => ({ fields: await piiInventory(p, tx) }));
    });

    app.get('/api/governance/access-review', async (req) => {
      const a = requirePermission(req, 'platform:governance.read');
      return p.database.withTenant(a.tenantId, async (tx) => ({ fields: await accessReview(p, tx) }));
    });

    app.get('/api/governance/retention', async (req) => {
      const a = requirePermission(req, 'platform:governance.read');
      return p.database.withTenant(a.tenantId, async (tx) => ({ policies: await tx.selectFrom('retention_policy').selectAll().orderBy('target').execute() }));
    });

    app.post('/api/governance/retention', async (req, reply) => {
      const a = requirePermission(req, 'platform:governance.manage');
      const r = await p.database.withTenant(a.tenantId, (tx) => saveRetentionPolicy(p, tx, a.tenantId, a.principal, req.body, correlationId(req)));
      return reply.code(201).send(r);
    });

    /** Run one policy now (the nightly job runs them all). */
    app.post('/api/governance/retention/:id/run', async (req) => {
      const a = requirePermission(req, 'platform:governance.manage');
      const id = parse(UUID, (req.params as { id: string }).id);
      const results = await runRetention(p, a.tenantId, { policyId: id, actor: a.principal, correlationId: correlationId(req) });
      if (!results.length) throw new CommandError(404, 'not_found', 'policy not found or disabled');
      return { results };
    });

    app.get('/api/governance/dsr', async (req) => {
      const a = requirePermission(req, 'platform:governance.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const rows = await tx.selectFrom('dsr_request').select(['id', 'kind', 'status', 'found', 'file_id', 'requested_by', 'created_at', 'finished_at', 'error']).orderBy('created_at', 'desc').limit(100).execute();
        // An export holds a person's personal data: its link goes only to whoever made the
        // request, or to someone who may run requests. The subject is never returned.
        const manage = authorize(a.principal, action('platform:governance.manage'), { type: 'platform::Tenant', id: a.tenantId, tenantId: a.tenantId }).decision === 'allow';
        return {
          requests: rows.map((r) => ({
            ...r,
            found_count: (r.found as unknown[]).length,
            download_url: r.kind === 'export' && r.status !== 'failed' && (manage || r.requested_by === a.principal.id) ? download(a.tenantId, r.file_id as string | null) : null,
          })),
        };
      });
    });

    app.post('/api/governance/dsr', async (req, reply) => {
      const a = requirePermission(req, 'platform:governance.manage');
      const r = await runDsr(p, a.tenantId, a.principal, parse(z.object({ kind: z.enum(['export', 'erase']), subject: z.string() }), req.body), correlationId(req));
      return reply.code(201).send({ ...r, download_url: download(a.tenantId, r.file_id) });
    });

    app.post('/api/governance/audit-export', async (req, reply) => {
      const a = requirePermission(req, 'platform:governance.manage');
      const r = await exportAuditLog(p, a.tenantId, a.principal, req.body, correlationId(req));
      return reply.code(201).send({ ...r, download_url: download(a.tenantId, r.file_id) });
    });
  };
}
