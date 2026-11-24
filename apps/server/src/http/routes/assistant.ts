import { CommandError } from '@aod/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createConversation, decideToolCall, expireApprovals, getConversation, listConversations, resumeConversation, sendMessage, type AgentEvent } from '../../platform/assistant/agent.ts';
import { toolsFor } from '../../platform/assistant/tools.ts';
import { usageSummary } from '../../platform/assistant/usage.ts';
import type { Platform } from '../../platform/context.ts';
import { createSource, deleteSource, enqueueIndex, listSources, MAX_DOCUMENT_BYTES, updateSource } from '../../platform/knowledge.ts';
import { BOT_PACKAGE, packageEnabled, requirePackage } from '../../platform/packages.ts';
import { recordChange } from '../../platform/record.ts';
import { correlationId, parse, requirePermission } from '../app.ts';

const UUID = z.uuid();
const idParam = (req: { params: unknown }) => parse(UUID, (req.params as { id: string }).id);

const MessageBody = z.object({ text: z.string().trim().min(1).max(8000) });
const ConversationBody = z.object({ title: z.string().max(120).optional(), context: z.record(z.string(), z.unknown()).optional() });
const DecisionBody = z.object({ decision: z.enum(['confirm', 'decline']) });
const HelpBody = z.object({ title: z.string().trim().min(1).max(160), body: z.string().trim().min(1).max(200_000), public: z.boolean().default(false) });
const DocumentBody = z.object({ title: z.string().trim().min(1).max(160), filename: z.string().trim().min(1).max(200).regex(/\.(txt|md|markdown|csv)$/i, 'upload a .txt, .md or .csv file'), content: z.string().min(1), public: z.boolean().default(false) });
const SourcePatch = z.object({ title: z.string().trim().min(1).max(160).optional(), body: z.string().trim().min(1).max(200_000).optional(), public: z.boolean().optional() });

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' };

/**
 * Streams one assistant turn as Server-Sent Events. The turn's abort signal fires when
 * the client goes away, which also ends the model stream; nothing outlives the response.
 */
async function streamTurn(p: Platform, reply: FastifyReply, run: (emit: (e: AgentEvent) => void, signal: AbortSignal) => Promise<unknown>) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, SSE_HEADERS);
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on('close', onClose);
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded && !ac.signal.aborted) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    await run((e) => send(e.type, e), ac.signal);
    send('done', {});
  } catch (e) {
    if (!(e instanceof CommandError)) p.log.error({ err: String((e as Error)?.stack ?? e) }, 'assistant turn failed');
    send('error', { type: 'error', message: e instanceof CommandError ? e.message : 'The assistant could not finish this turn. Try again.', code: e instanceof CommandError ? e.code : 'internal' });
  } finally {
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

export function assistantRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    app.get('/api/assistant/overview', async (req) => {
      const a = requirePermission(req, 'platform:assistant.use');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const enabled = await packageEnabled(p, tx, BOT_PACKAGE);
        if (!enabled) return { enabled, usage: null, tools: [], model: null };
        const tools = await toolsFor(p, tx, a.principal);
        return { enabled, usage: await usageSummary(p, tx), tools: tools.map((t) => ({ name: t.name, label: t.label, risk: t.risk, app: t.app ?? 'platform' })), model: p.env.LLM_ADAPTER === 'fake' ? 'scripted test model' : p.env.CLAUDE_MODEL };
      });
    });

    app.get('/api/assistant/conversations', async (req) => {
      const a = requirePermission(req, 'platform:assistant.use');
      return p.database.withTenant(a.tenantId, async (tx) => ({ conversations: await listConversations(tx, a.user.id) }));
    });

    app.post('/api/assistant/conversations', async (req, reply) => {
      const a = requirePermission(req, 'platform:assistant.use');
      const body = parse(ConversationBody, req.body ?? {});
      const r = await p.database.withTenant(a.tenantId, (tx) => createConversation(p, tx, a.tenantId, a.principal, body, correlationId(req)));
      return reply.code(201).send(r);
    });

    app.get('/api/assistant/conversations/:id', async (req) => {
      const a = requirePermission(req, 'platform:assistant.use');
      const id = idParam(req);
      // An approval nobody decided in time must not leave the conversation stuck.
      await expireApprovals(p, a.tenantId, id);
      return p.database.withTenant(a.tenantId, (tx) => getConversation(p, tx, a.principal, id));
    });

    app.post('/api/assistant/conversations/:id/messages', async (req, reply) => {
      const a = requirePermission(req, 'platform:assistant.use');
      const id = idParam(req);
      const body = parse(MessageBody, req.body);
      await p.database.withTenant(a.tenantId, (tx) => requirePackage(p, tx, BOT_PACKAGE));
      const corr = correlationId(req);
      await streamTurn(p, reply, (emit, signal) => sendMessage(p, { tenantId: a.tenantId, principal: a.principal, conversationId: id, text: body.text, correlationId: corr, emit, signal }));
    });

    /** Confirm or decline a low-risk action; the assistant then continues in the same stream. */
    app.post('/api/assistant/tool-calls/:id/decision', async (req, reply) => {
      const a = requirePermission(req, 'platform:assistant.use');
      const id = idParam(req);
      const body = parse(DecisionBody, req.body);
      const decided = await decideToolCall(p, { tenantId: a.tenantId, principal: a.principal, toolCallId: id, decision: body.decision });
      await streamTurn(p, reply, (emit, signal) => resumeConversation(p, { tenantId: a.tenantId, conversationId: decided.conversationId, principal: a.principal, emit, signal }));
    });

    // ------------------------------------------------------------ knowledge

    app.get('/api/knowledge/sources', async (req) => {
      const a = requirePermission(req, 'platform:assistant.use');
      return p.database.withTenant(a.tenantId, async (tx) => ({ enabled: await packageEnabled(p, tx, BOT_PACKAGE), sources: await listSources(tx) }));
    });

    app.post('/api/knowledge/sources', async (req, reply) => {
      const a = requirePermission(req, 'platform:knowledge.manage');
      const body = parse(HelpBody, req.body);
      const r = await p.database.withTenant(a.tenantId, async (tx) => {
        await requirePackage(p, tx, BOT_PACKAGE);
        return createSource(p, tx, a.tenantId, a.principal, { kind: 'help', ...body }, correlationId(req));
      });
      await enqueueIndex(p, a.tenantId, r.id);
      return reply.code(201).send(r);
    });

    /** A text document: stored through the Files port, then chunked and embedded by a job. */
    app.post('/api/knowledge/documents', async (req, reply) => {
      const a = requirePermission(req, 'platform:knowledge.manage');
      const body = parse(DocumentBody, req.body);
      await p.database.withTenant(a.tenantId, (tx) => requirePackage(p, tx, BOT_PACKAGE));
      if (Buffer.byteLength(body.content) > MAX_DOCUMENT_BYTES) throw new CommandError(413, 'too_large', `documents can be at most ${MAX_DOCUMENT_BYTES} bytes`);
      const content = body.content;
      const file = await p.ports.files.put(
        a.tenantId,
        { name: body.filename, contentType: 'text/plain; charset=utf-8', purpose: 'knowledge', createdBy: a.user.id },
        (async function* () {
          for (let i = 0; i < content.length; i += 64 * 1024) yield content.slice(i, i + 64 * 1024);
        })(),
        { maxBytes: MAX_DOCUMENT_BYTES },
      );
      const r = await p.database.withTenant(a.tenantId, (tx) => createSource(p, tx, a.tenantId, a.principal, { kind: 'document', title: body.title, public: body.public, file_id: file.id }, correlationId(req))).catch(async (e) => {
        await p.ports.files.remove(a.tenantId, file.id).catch((err: unknown) => p.log.warn({ err: String(err) }, 'knowledge: removing an orphaned file failed'));
        throw e;
      });
      await enqueueIndex(p, a.tenantId, r.id);
      return reply.code(201).send(r);
    });

    app.patch('/api/knowledge/sources/:id', async (req) => {
      const a = requirePermission(req, 'platform:knowledge.manage');
      const id = idParam(req);
      const body = parse(SourcePatch, req.body);
      const r = await p.database.withTenant(a.tenantId, (tx) => updateSource(p, tx, a.tenantId, a.principal, id, body, correlationId(req)));
      if (r.reindex) await enqueueIndex(p, a.tenantId, id);
      return { ok: true };
    });

    app.post('/api/knowledge/sources/:id/reindex', async (req) => {
      const a = requirePermission(req, 'platform:knowledge.manage');
      const id = idParam(req);
      await p.database.withTenant(a.tenantId, async (tx) => {
        const r = await tx.updateTable('doc_source').set({ status: 'pending', attempts: 0, updated_at: new Date() }).where('id', '=', id).returning('id').executeTakeFirst();
        if (!r) throw new CommandError(404, 'not_found', 'source not found');
        await recordChange(p, tx, { tenantId: a.tenantId, actor: a.principal, action: 'platform:knowledge.source_reindexed', resourceType: 'platform::KnowledgeSource', resourceId: id, correlationId: correlationId(req), events: [{ type: 'knowledge.source_updated', data: { source_id: id, reindex: true } }] });
      });
      await enqueueIndex(p, a.tenantId, id);
      return { ok: true };
    });

    app.delete('/api/knowledge/sources/:id', async (req) => {
      const a = requirePermission(req, 'platform:knowledge.manage');
      const id = idParam(req);
      const r = await p.database.withTenant(a.tenantId, (tx) => deleteSource(p, tx, a.tenantId, a.principal, id, correlationId(req)));
      if (r.fileId) await p.ports.files.remove(a.tenantId, r.fileId).catch((e: unknown) => p.log.warn({ err: String(e) }, 'knowledge: removing the document file failed'));
      return { ok: true };
    });
  };
}
