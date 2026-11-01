import { action, authorize, CommandError, nextRunAt, ReportInput, resolveRange, type Principal, type ReportQuery } from '@aod/shared';
import { sql } from 'kysely';
import { principalFor } from '../../auth/principal.ts';
import { newId, type Tx } from '../../db/database.ts';
import type { Platform } from '../context.ts';
import { recordChange } from '../record.ts';
import { queryMetric } from './query.ts';

/**
 * Reports: saved metric queries exported as CSV or PDF into the Files port, run on demand
 * or on a schedule. A report always runs as a person: the one who runs it, or for a
 * schedule its owner with their role today, so permissions and field rules apply.
 */

const RESOURCE = 'platform::Report';
/** Report files are kept for 30 days. */
const REPORT_TTL_MS = 30 * 86_400_000;
/** Size cap for one report file. */
export const REPORT_MAX_BYTES = 20 * 1024 * 1024;

export interface ReportTable {
  title: string;
  range: { from: string; to: string };
  columns: string[];
  rows: (string | number)[][];
}

/** Runs the report's metrics as `principal` and pivots them into one table. */
export async function buildReport(p: Platform, tx: Tx, principal: Principal, name: string, q: ReportQuery, now = new Date()): Promise<ReportTable> {
  const { from, to } = resolveRange(q.range, now);
  const granularity = q.granularity === 'none' ? null : q.granularity;
  const results: Awaited<ReturnType<typeof queryMetric>>[] = [];
  for (const metric of q.metrics) {
    results.push(
      await queryMetric(p, tx, principal, {
        metric,
        from: from.toISOString(),
        to: to.toISOString(),
        ...(granularity && !q.group_by ? { granularity } : {}),
        ...(q.group_by ? { group_by: q.group_by } : {}),
        filters: q.filters,
        compare: false,
      }),
    );
  }
  const keyOf = (r: { bucket: string | null; key: string | null }) => `${r.bucket ?? ''}|${r.key ?? ''}`;
  const rowKeys = [...new Set(results.flatMap((r) => (r.series.length ? r.series.map(keyOf) : [])))];
  if (!q.group_by && !granularity) rowKeys.splice(0, rowKeys.length, '|');
  rowKeys.sort();
  const columns = [...(granularity && !q.group_by ? ['Period'] : []), ...(q.group_by ? [q.group_by === 'store' ? 'Store' : 'Channel'] : []), ...results.map((r) => r.metric.label)];
  const rows = rowKeys.map((k) => {
    const [bucket, key] = k.split('|');
    const lead: (string | number)[] = [];
    if (granularity && !q.group_by) lead.push(bucket ? bucket.slice(0, granularity === 'hour' ? 16 : 10).replace('T', ' ') : '');
    if (q.group_by) lead.push(key || '(none)');
    return [...lead, ...results.map((r) => (!q.group_by && !granularity ? r.total : (r.series.find((x) => keyOf(x) === k)?.value ?? 0)))];
  });
  return { title: name, range: { from: from.toISOString(), to: to.toISOString() }, columns, rows };
}

/** CSV cells; a leading = + - @ is neutralised so spreadsheets never run it as a formula. */
const csvCell = (v: string | number) => {
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function* csvLines(t: { columns: string[]; rows: AsyncIterable<(string | number)[]> | Iterable<(string | number)[]> }) {
  yield `${t.columns.map(csvCell).join(',')}\r\n`;
  for await (const r of t.rows) yield `${r.map(csvCell).join(',')}\r\n`;
}

/**
 * PDF rendering, streamed (memory-safe-code §1 and §6): pdfkit is loaded only when a PDF
 * is asked for, and its output is handed on as it is produced, a page of rows at a time,
 * instead of building the whole document first.
 */
export async function* pdfStream(t: ReportTable): AsyncGenerator<Uint8Array> {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: t.title, Producer: 'Apps-on-Demand' } });
  const ready: Buffer[] = [];
  let ended = false;
  let failed: unknown = null;
  doc.on('data', (c: Buffer) => ready.push(c));
  doc.on('end', () => {
    ended = true;
  });
  doc.on('error', (e: unknown) => {
    failed = e;
  });
  const drain = function* () {
    while (ready.length) yield ready.shift()!;
  };
  doc.fontSize(16).text(t.title);
  doc.moveDown(0.3).fontSize(9).fillColor('#5F6672').text(`${t.range.from.slice(0, 10)} to ${t.range.to.slice(0, 10)} (UTC, end exclusive)`);
  doc.moveDown().fillColor('#1B1F27');
  const width = (doc.page.width - 80) / Math.max(1, t.columns.length);
  const row = (cells: (string | number)[], bold: boolean) => {
    if (doc.y > doc.page.height - 60) doc.addPage();
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    cells.forEach((c, i) => doc.text(typeof c === 'number' ? c.toLocaleString('en-US', { maximumFractionDigits: 2 }) : c, 40 + i * width, y, { width: width - 6, align: typeof c === 'number' ? 'right' : 'left', lineBreak: false }));
    doc.moveDown(0.6);
    doc.x = 40;
  };
  row(t.columns, true);
  for (const [i, r] of t.rows.entries()) {
    row(r, false);
    if (i % 50 === 49) {
      // let pdfkit flush, then pass on what it produced
      await new Promise((res) => setImmediate(res));
      yield* drain();
    }
  }
  if (!t.rows.length) doc.font('Helvetica').text('No data for this period.');
  doc.end();
  while (!ended && !failed) {
    await new Promise((res) => setImmediate(res));
    yield* drain();
  }
  if (failed) throw failed;
  yield* drain();
}

/** Writes a report file and records the run. */
export async function runReport(p: Platform, tenantId: string, principal: Principal, reportId: string, opts: { format: 'csv' | 'pdf'; trigger: 'manual' | 'schedule'; correlationId: string }) {
  const runId = newId();
  const report = await p.database.withTenant(tenantId, async (tx) => {
    const r = await tx.selectFrom('report').selectAll().where('id', '=', reportId).executeTakeFirst();
    if (!r) throw new CommandError(404, 'not_found', 'report not found');
    await tx.insertInto('report_run').values({ id: runId, tenant_id: tenantId, report_id: r.id, trigger: opts.trigger, format: opts.format, status: 'running' }).execute();
    return r;
  });
  try {
    const table = await p.database.withTenant(tenantId, (tx) => buildReport(p, tx, principal, report.name, report.query as ReportQuery));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const file = await p.ports.files.put(
      tenantId,
      {
        name: `${report.name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'report'} ${stamp}.${opts.format}`,
        contentType: opts.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
        purpose: `report:${report.id}`,
        createdBy: principal.id,
        expiresAt: new Date(Date.now() + REPORT_TTL_MS),
      },
      opts.format === 'csv' ? csvLines(table) : pdfStream(table),
      { maxBytes: REPORT_MAX_BYTES },
    );
    await p.database.withTenant(tenantId, async (tx) => {
      await tx.updateTable('report_run').set({ status: 'succeeded', file_id: file.id, rows: table.rows.length, delivery: 'file', finished_at: new Date() }).where('id', '=', runId).execute();
      await recordChange(p, tx, { tenantId, actor: principal, action: 'platform:report.ran', resourceType: RESOURCE, resourceId: report.id, correlationId: opts.correlationId, events: [{ type: 'report.completed', data: { report_id: report.id, run_id: runId, format: opts.format, rows: table.rows.length, trigger: opts.trigger } }] });
    });
    return { run_id: runId, file_id: file.id, rows: table.rows.length };
  } catch (e) {
    const message = e instanceof CommandError ? e.message : (e as Error).message;
    await p.database.withTenant(tenantId, async (tx) => {
      await tx.updateTable('report_run').set({ status: 'failed', error: message.slice(0, 500), finished_at: new Date() }).where('id', '=', runId).execute();
      await recordChange(p, tx, { tenantId, actor: principal, action: 'platform:report.failed', resourceType: RESOURCE, resourceId: report.id, correlationId: opts.correlationId, events: [{ type: 'report.failed', data: { report_id: report.id, run_id: runId, error: message.slice(0, 200) } }] });
    });
    throw e;
  }
}

export async function saveReport(p: Platform, tx: Tx, tenantId: string, principal: Principal, raw: unknown, correlationId: string, existing?: { id: string; version: number }) {
  const parsed = ReportInput.safeParse(raw);
  if (!parsed.success) throw new CommandError(422, 'invalid_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const input = parsed.data;
  // Validate by running it once as the saver: unknown or hidden metrics fail here.
  await buildReport(p, tx, principal, input.name, input.query);
  const next = input.schedule ? nextRunAt(input.schedule, new Date()) : null;
  const id = existing?.id ?? newId();
  if (existing) {
    const cur = await tx.selectFrom('report').select('owner_id').where('id', '=', id).executeTakeFirst();
    if (!cur) throw new CommandError(404, 'not_found', 'report not found');
    const admin = principal.roles.some((r) => r.preset === 'Owner' || r.preset === 'Admin');
    if (cur.owner_id !== principal.id && !admin) throw new CommandError(403, 'forbidden', 'only the owner or an Admin can change this report');
    const r = await tx
      .updateTable('report')
      .set({ name: input.name, query: JSON.stringify(input.query), schedule: input.schedule ? JSON.stringify(input.schedule) : null, next_run_at: next, schedule_claimed_until: null, updated_at: new Date(), version: sql`version + 1` })
      .where('id', '=', id)
      .where('version', '=', existing.version)
      .returning('id')
      .executeTakeFirst();
    if (!r) throw new CommandError(409, 'version_conflict', 'the report changed');
  } else {
    await tx
      .insertInto('report')
      .values({ id, tenant_id: tenantId, name: input.name, query: JSON.stringify(input.query), schedule: input.schedule ? JSON.stringify(input.schedule) : null, next_run_at: next, owner_id: principal.id })
      .execute()
      .catch((e) => {
        if (e?.code === '23505') throw new CommandError(409, 'name_taken', `a report named ${input.name} exists`);
        throw e;
      });
  }
  await recordChange(p, tx, { tenantId, actor: principal, action: existing ? 'platform:report.updated' : 'platform:report.created', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: existing ? 'report.updated' : 'report.created', data: { report_id: id, metrics: input.query.metrics, scheduled: Boolean(input.schedule) } }] });
  return { id, next_run_at: next };
}

async function recordFailedRun(p: Platform, tenantId: string, reportId: string, format: 'csv' | 'pdf', error: string, correlationId: string) {
  await p.database.withTenant(tenantId, async (tx) => {
    const runId = newId();
    await tx.insertInto('report_run').values({ id: runId, tenant_id: tenantId, report_id: reportId, trigger: 'schedule', format, status: 'failed', error, finished_at: new Date() }).execute();
    await recordChange(p, tx, { tenantId, actor: { type: 'System', id: 'reports' }, action: 'platform:report.failed', resourceType: RESOURCE, resourceId: reportId, correlationId, events: [{ type: 'report.failed', data: { report_id: reportId, run_id: runId, error } }] });
  });
}

/** The every-minute job: runs due schedules (claimed across tenants with a lease). */
export async function runDueSchedules(p: Platform) {
  const due = (await sql<{ tenant_id: string; id: string }>`SELECT * FROM report_claim_due(20, 900)`.execute(p.database.db)).rows;
  for (const d of due) {
    const correlationId = `schedule:${d.id}:${Date.now()}`;
    const report = await p.database.withTenant(d.tenant_id, (tx) => tx.selectFrom('report').selectAll().where('id', '=', d.id).executeTakeFirst());
    if (!report?.schedule) continue;
    const schedule = report.schedule as { format: 'csv' | 'pdf' } & Parameters<typeof nextRunAt>[0];
    try {
      const owner = await p.database.withTenant(d.tenant_id, (tx) => tx.selectFrom('app_user').select(['id', 'role', 'status']).where('id', '=', report.owner_id).executeTakeFirst());
      const principal = owner?.status === 'active' ? await p.database.withTenant(d.tenant_id, (tx) => principalFor(tx, p.catalog, d.tenant_id, { id: owner.id, role: owner.role })) : null;
      // A schedule runs only while its owner may still read analytics; otherwise the run is
      // recorded as failed (audited) and nothing is produced.
      const allowed = principal && authorize(principal, action('platform:analytics.read'), { type: 'platform::Tenant', id: d.tenant_id, tenantId: d.tenant_id }).decision === 'allow';
      if (!principal || !allowed) {
        await recordFailedRun(p, d.tenant_id, report.id, schedule.format, !principal ? 'the report owner is no longer active; reassign the report' : 'the report owner can no longer read analytics', correlationId);
        continue;
      }
      await runReport(p, d.tenant_id, principal, report.id, { format: schedule.format, trigger: 'schedule', correlationId });
    } catch (e) {
      p.log.error({ err: String(e), report: d.id }, 'scheduled report failed');
    } finally {
      // The next occurrence is set whether this one worked or not (the run records failures).
      await p.database
        .withTenant(d.tenant_id, (tx) => tx.updateTable('report').set({ next_run_at: nextRunAt(schedule, new Date()), schedule_claimed_until: null }).where('id', '=', d.id).execute())
        .catch((e: unknown) => p.log.error({ err: String(e), report: d.id }, 'could not reschedule a report'));
    }
  }
  return due.length;
}
