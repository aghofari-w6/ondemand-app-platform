import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Platform } from '../../platform/context.ts';
import { requirePermission } from '../app.ts';

export function opsRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    app.get('/api/health', async () => {
      await sql`SELECT 1`.execute(p.database.db);
      return { ok: true, dispatcherLeader: p.ports.eventBus.isLeader() };
    });
    app.get('/api/ops/metrics', async (req) => {
      requirePermission(req, 'platform:audit.read');
      return { metrics: p.ports.metrics.snapshot() };
    });
  };
}
