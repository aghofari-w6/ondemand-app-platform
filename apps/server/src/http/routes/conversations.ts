import { BOT_CHANNELS, BotGraph, CommandError, ROLE_PRESETS, validateBotGraph } from '@aod/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { toolsFor } from '../../platform/assistant/tools.ts';
import { botContext, createFlow, discardFlowDraft, getFlow, publishFlow, rollbackFlow, saveFlowDraft, setFlowStatus } from '../../platform/bot/flows.ts';
import { botDeps, runBotTurn, type BotSession } from '../../platform/bot/runner.ts';
import type { Platform } from '../../platform/context.ts';
import { channelView, connectTelegram, createWidget, deleteChannel, finishGmailConnect, handleTelegramUpdate, pollGmail, rotateWidgetSecret, startGmailConnect, updateChannel, type ChannelRow } from '../../platform/conversations/channels.ts';
import { addNote, assignConversation, deleteCanned, getConversation, linkRecord, listCanned, listConversations, markRead, notifyConversation, queueReply, retryMessage, saveCanned, setConversationStatus } from '../../platform/conversations/inbox.ts';
import { BOT_PACKAGE, OMNICHANNEL_PACKAGE, packageEnabled, requirePackage } from '../../platform/packages.ts';
import { correlationId, parse, requirePermission } from '../app.ts';

const UUID = z.uuid();
const idParam = (req: { params: unknown }) => parse(UUID, (req.params as { id: string }).id);
const origin = z.url().refine((u) => /^https?:\/\//.test(u), 'origins start with http:// or https://');
const sla = z.int().min(1).max(7 * 24 * 60).optional();

const TelegramBody = z.object({ name: z.string().trim().min(1).max(80), token: z.string().trim().min(10).max(100), sla_minutes: sla });
const WidgetBody = z.object({ name: z.string().trim().min(1).max(80), allowed_origins: z.array(origin).min(1).max(20), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), greeting: z.string().trim().min(1).max(200).optional(), sla_minutes: sla });
const GmailStartBody = z.object({ name: z.string().trim().min(1).max(80).optional(), account_id: z.uuid().optional(), sla_minutes: sla });
const ChannelPatch = z.object({ name: z.string().trim().min(1).max(80).optional(), status: z.enum(['active', 'disabled']).optional(), widget: WidgetBody.omit({ name: true }).optional(), sla_minutes: sla });

const ListQuery = z.object({ status: z.enum(['active', 'bot', 'open', 'pending', 'resolved', 'all']).default('active'), assignee: z.string().max(40).optional(), channel: z.enum(BOT_CHANNELS).optional(), q: z.string().max(100).optional() });
const TextBody = z.object({ body: z.string().trim().min(1).max(4000) });
const AssignBody = z.object({ assignee_id: z.uuid().nullable(), version: z.int().positive().optional() });
const StatusBody = z.object({ status: z.enum(['open', 'pending', 'resolved']), version: z.int().positive().optional() });
const LinkBody = z.object({ type: z.string().regex(/^[a-z][a-z0-9_]*::[A-Z][A-Za-z0-9]*$/), id: z.uuid() });
const CannedBody = z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(4000) });

const FlowBody = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).optional(), template: z.enum(['order_status']).optional(), channels: z.array(z.enum(BOT_CHANNELS)).min(1).optional() });
const DraftBody = z.object({ graph: z.unknown(), version: z.int().positive().optional() });
const PublishBody = z.object({ version: z.int().positive(), service_role: z.string().min(1).max(80) });
const TestBody = z.object({ graph: z.unknown(), text: z.string().trim().min(1).max(2000), channel: z.enum(BOT_CHANNELS).default('widget'), session: z.unknown().optional() });

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' };
const STREAM_MAX_MS = 15 * 60_000;

export function conversationRoutes(p: Platform) {
  return async function (app: FastifyInstance) {
    // ------------------------------------------------------------ channels

    app.get('/api/channels', async (req) => {
      const a = requirePermission(req, 'platform:channels.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const rows = (await tx.selectFrom('channel_account').selectAll().orderBy('created_at').execute()) as unknown as ChannelRow[];
        return { enabled: await packageEnabled(p, tx, OMNICHANNEL_PACKAGE), gmail_configured: p.ports.channel.gmail.configured(), channels: rows.map((r) => channelView(p, r)) };
      });
    });

    app.post('/api/channels/telegram', async (req, reply) => {
      const a = requirePermission(req, 'platform:channels.manage');
      const body = parse(TelegramBody, req.body);
      return reply.code(201).send(await connectTelegram(p, a.tenantId, a.principal, body, correlationId(req)));
    });

    app.post('/api/channels/widget', async (req, reply) => {
      const a = requirePermission(req, 'platform:channels.manage');
      const body = parse(WidgetBody, req.body);
      return reply.code(201).send(await p.database.withTenant(a.tenantId, (tx) => createWidget(p, tx, a.tenantId, a.principal, body, correlationId(req))));
    });

    app.post('/api/channels/gmail/start', async (req) => {
      const a = requirePermission(req, 'platform:channels.manage');
      const body = parse(GmailStartBody, req.body ?? {});
      return p.database.withTenant(a.tenantId, (tx) => startGmailConnect(p, tx, a.tenantId, a.principal, { name: body.name, accountId: body.account_id, sla_minutes: body.sla_minutes }, correlationId(req)));
    });

    /** Google redirects the admin's browser here; the signed state ties it to the tenant, the mailbox and the user. */
    app.get('/api/channels/gmail/callback', async (req, reply) => {
      const a = requirePermission(req, 'platform:channels.manage');
      const q = parse(z.object({ state: z.string().min(10).max(600), code: z.string().min(1).max(2000).optional(), error: z.string().max(200).optional() }), req.query);
      const back = (params: Record<string, string>) => reply.redirect(`/channels?${new URLSearchParams(params).toString()}`);
      if (!q.code) return back({ gmail_error: q.error === 'access_denied' ? 'Google access was not granted.' : 'Google did not complete the connection.' });
      try {
        const r = await finishGmailConnect(p, a.tenantId, a.principal, q.state, q.code, correlationId(req));
        return await back({ connected: r.id });
      } catch (e) {
        if (!(e instanceof CommandError)) throw e;
        return back({ gmail_error: e.message });
      }
    });

    app.patch('/api/channels/:id', async (req) => {
      const a = requirePermission(req, 'platform:channels.manage');
      const id = idParam(req);
      const body = parse(ChannelPatch, req.body);
      await p.database.withTenant(a.tenantId, (tx) => updateChannel(p, tx, a.tenantId, a.principal, id, body, correlationId(req)));
      return { ok: true };
    });

    app.post('/api/channels/:id/rotate-secret', async (req) => {
      const a = requirePermission(req, 'platform:channels.manage');
      const id = idParam(req);
      return p.database.withTenant(a.tenantId, (tx) => rotateWidgetSecret(p, tx, a.tenantId, a.principal, id, correlationId(req)));
    });

    /** "Check mail now" for a Gmail mailbox (the scheduled poll does the same). */
    app.post('/api/channels/:id/poll', async (req) => {
      const a = requirePermission(req, 'platform:channels.manage');
      return pollGmail(p, a.tenantId, idParam(req));
    });

    app.delete('/api/channels/:id', async (req) => {
      const a = requirePermission(req, 'platform:channels.manage');
      await deleteChannel(p, a.tenantId, a.principal, idParam(req), correlationId(req));
      return { ok: true };
    });

    /** Telegram Bot API webhook. Public; authenticated by the secret token Telegram echoes back. */
    app.post('/hooks/telegram/:tenantId/:accountId', async (req) => {
      const { tenantId, accountId } = req.params as { tenantId: string; accountId: string };
      const secret = req.headers['x-telegram-bot-api-secret-token'];
      const updateId = (req.body as { update_id?: unknown } | null)?.update_id;
      const r = await handleTelegramUpdate(p, tenantId, accountId, typeof secret === 'string' ? secret : undefined, req.body, `telegram:${accountId}:${typeof updateId === 'number' ? updateId : correlationId(req)}`);
      return { ok: true, ...('ignored' in r ? { ignored: r.ignored } : {}) };
    });

    // ------------------------------------------------------------ inbox

    app.get('/api/inbox/conversations', async (req) => {
      const a = requirePermission(req, 'platform:inbox.read');
      const q = parse(ListQuery, req.query);
      return p.database.withTenant(a.tenantId, async (tx) => ({ enabled: await packageEnabled(p, tx, OMNICHANNEL_PACKAGE), ...(await listConversations(p, tx, a.tenantId, { ...q, assignee: q.assignee === 'me' ? a.user.id : q.assignee })) }));
    });

    app.get('/api/inbox/conversations/:id', async (req) => {
      const a = requirePermission(req, 'platform:inbox.read');
      const id = idParam(req);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const r = await getConversation(p, tx, a.tenantId, a.principal, id);
        await markRead(tx, id);
        return r;
      });
    });

    app.post('/api/inbox/conversations/:id/reply', async (req, reply) => {
      const a = requirePermission(req, 'platform:inbox.reply');
      const id = idParam(req);
      const body = parse(TextBody, req.body);
      const messageId = await p.database.withTenant(a.tenantId, (tx) => queueReply(p, tx, a.tenantId, id, { authorType: 'agent', authorId: a.user.id, body: body.body, correlationId: correlationId(req), actor: a.principal }));
      notifyConversation(p, a.tenantId, id);
      return reply.code(201).send({ id: messageId });
    });

    app.post('/api/inbox/conversations/:id/note', async (req, reply) => {
      const a = requirePermission(req, 'platform:inbox.reply');
      const id = idParam(req);
      const body = parse(TextBody, req.body);
      const noteId = await p.database.withTenant(a.tenantId, (tx) => addNote(p, tx, a.tenantId, a.principal, id, body.body, correlationId(req)));
      notifyConversation(p, a.tenantId, id);
      return reply.code(201).send({ id: noteId });
    });

    app.post('/api/inbox/conversations/:id/assign', async (req) => {
      const a = requirePermission(req, 'platform:inbox.reply');
      const id = idParam(req);
      const body = parse(AssignBody, req.body);
      await p.database.withTenant(a.tenantId, (tx) => assignConversation(p, tx, a.tenantId, a.principal, id, body.assignee_id, body.version, correlationId(req)));
      notifyConversation(p, a.tenantId, id);
      return { ok: true };
    });

    app.post('/api/inbox/conversations/:id/status', async (req) => {
      const a = requirePermission(req, 'platform:inbox.reply');
      const id = idParam(req);
      const body = parse(StatusBody, req.body);
      await p.database.withTenant(a.tenantId, (tx) => setConversationStatus(p, tx, a.tenantId, a.principal, id, body.status, body.version, correlationId(req)));
      notifyConversation(p, a.tenantId, id);
      return { ok: true };
    });

    app.post('/api/inbox/conversations/:id/link', async (req) => {
      const a = requirePermission(req, 'platform:inbox.reply');
      const id = idParam(req);
      const body = parse(LinkBody, req.body);
      await p.database.withTenant(a.tenantId, async (tx) => {
        if (!(await tx.selectFrom('conversation').select('id').where('id', '=', id).executeTakeFirst())) throw new CommandError(404, 'not_found', 'conversation not found');
        await linkRecord(p, tx, a.tenantId, a.principal, id, body, correlationId(req));
      });
      return { ok: true };
    });

    app.post('/api/inbox/messages/:id/retry', async (req) => {
      const a = requirePermission(req, 'platform:inbox.reply');
      const conversationId = await p.database.withTenant(a.tenantId, (tx) => retryMessage(p, tx, a.tenantId, a.principal, idParam(req), correlationId(req)));
      notifyConversation(p, a.tenantId, conversationId);
      return { ok: true };
    });

    /** A signed, short-lived download link for an attachment of a conversation message. */
    app.get('/api/inbox/attachments/:id', async (req) => {
      const a = requirePermission(req, 'platform:inbox.read');
      const fileId = idParam(req);
      const owned = await p.database.withTenant(a.tenantId, (tx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM conv_message WHERE meta -> 'attachments' @> ${JSON.stringify([{ file_id: fileId }])}::jsonb`.execute(tx));
      if (!owned.rows[0]?.n) throw new CommandError(404, 'not_found', 'attachment not found');
      return { url: `/api/files/download?token=${encodeURIComponent(p.ports.files.signToken(a.tenantId, fileId, 300))}` };
    });

    app.get('/api/inbox/agents', async (req) => {
      const a = requirePermission(req, 'platform:inbox.read');
      return p.database.withTenant(a.tenantId, async (tx) => ({ agents: await tx.selectFrom('app_user').select(['id', 'name']).where('status', '=', 'active').orderBy('name').limit(200).execute() }));
    });

    app.get('/api/inbox/canned', async (req) => {
      const a = requirePermission(req, 'platform:inbox.read');
      return p.database.withTenant(a.tenantId, async (tx) => ({ replies: await listCanned(tx) }));
    });
    app.post('/api/inbox/canned', async (req, reply) => {
      const a = requirePermission(req, 'platform:inbox.manage');
      const body = parse(CannedBody, req.body);
      return reply.code(201).send(await p.database.withTenant(a.tenantId, (tx) => saveCanned(p, tx, a.tenantId, a.principal, body, correlationId(req))));
    });
    app.delete('/api/inbox/canned/:id', async (req) => {
      const a = requirePermission(req, 'platform:inbox.manage');
      await p.database.withTenant(a.tenantId, (tx) => deleteCanned(p, tx, a.tenantId, a.principal, idParam(req), correlationId(req)));
      return { ok: true };
    });

    /**
     * Live Inbox: an event whenever a conversation of the workspace changes. The stream
     * waits on in-process notifications (no polling), ends with the connection or after
     * 15 minutes, and the browser reconnects by itself.
     */
    app.get('/api/inbox/events', async (req, reply) => {
      const a = requirePermission(req, 'platform:inbox.read');
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, SSE_HEADERS);
      const ac = new AbortController();
      const onClose = () => ac.abort();
      res.on('close', onClose);
      const deadline = Date.now() + STREAM_MAX_MS;
      try {
        res.write('event: ready\ndata: {}\n\n');
        const cursor = new Map<string, number>();
        while (!ac.signal.aborted && Date.now() < deadline) {
          const published = await p.ports.realtime.wait([`inbox:${a.tenantId}`], 25_000, ac.signal, cursor);
          if (ac.signal.aborted) break;
          res.write(published ? 'event: changed\ndata: {}\n\n' : ': keep-alive\n\n');
        }
      } finally {
        res.off('close', onClose);
        if (!res.writableEnded) res.end();
      }
    });

    // ------------------------------------------------------------ Bot Studio

    app.get('/api/bots', async (req) => {
      const a = requirePermission(req, 'platform:bots.read');
      return p.database.withTenant(a.tenantId, async (tx) => ({
        enabled: await packageEnabled(p, tx, BOT_PACKAGE),
        flows: await tx.selectFrom('bot_flow as f').leftJoin('bot_flow_version as v', (j) => j.onRef('v.flow_id', '=', 'f.id').onRef('v.number', '=', 'f.published_number')).select(['f.id', 'f.name', 'f.description', 'f.status', 'f.published_number', 'f.updated_at', 'v.channels']).orderBy('f.name').execute(),
      }));
    });

    app.get('/api/bots/meta', async (req) => {
      const a = requirePermission(req, 'platform:bots.read');
      return p.database.withTenant(a.tenantId, async (tx) => {
        const tools = (await toolsFor(p, tx, a.principal)).filter((t) => t.kind === 'view');
        const custom = await tx.selectFrom('custom_role').select(['id', 'name']).orderBy('name').execute();
        return { channels: BOT_CHANNELS, tools: tools.map((t) => ({ name: t.name, label: t.label, app: t.app })), roles: [...ROLE_PRESETS.map((r) => ({ id: r as string, name: r as string })), ...custom.map((r) => ({ id: r.id as string, name: r.name as string }))] };
      });
    });

    app.post('/api/bots', async (req, reply) => {
      const a = requirePermission(req, 'platform:bots.manage');
      const body = parse(FlowBody, req.body);
      return reply.code(201).send(await p.database.withTenant(a.tenantId, (tx) => createFlow(p, tx, a.tenantId, a.principal, body, correlationId(req))));
    });

    app.get('/api/bots/:id', async (req) => {
      const a = requirePermission(req, 'platform:bots.read');
      const id = idParam(req);
      return p.database.withTenant(a.tenantId, async (tx) => {
        const flow = await getFlow(tx, id);
        const versions = await tx.selectFrom('bot_flow_version').select(['number', 'status', 'graph', 'channels', 'note', 'based_on', 'service_role', 'version', 'published_at', 'created_at']).where('flow_id', '=', id).orderBy('number', 'desc').execute();
        const draft = versions.find((v) => v.status === 'draft') ?? null;
        const published = versions.find((v) => v.status === 'published') ?? null;
        const current = draft ?? published;
        const parsed = current ? BotGraph.safeParse(current.graph) : null;
        return {
          flow,
          draft: draft ? { number: draft.number, version: draft.version, graph: draft.graph } : null,
          published: published ? { number: published.number, graph: published.graph, service_role: published.service_role, channels: published.channels } : null,
          problems: parsed?.success ? validateBotGraph(parsed.data, await botContext(p, tx)) : [],
          versions: versions.map((v) => ({ number: v.number, status: v.status, note: v.note, based_on: v.based_on, service_role: v.service_role, channels: v.channels, published_at: v.published_at, created_at: v.created_at })),
        };
      });
    });

    app.put('/api/bots/:id/draft', async (req) => {
      const a = requirePermission(req, 'platform:bots.manage');
      const body = parse(DraftBody, req.body);
      return p.database.withTenant(a.tenantId, (tx) => saveFlowDraft(p, tx, a.tenantId, a.principal, idParam(req), body.graph, body.version, correlationId(req)));
    });

    app.post('/api/bots/:id/publish', async (req) => {
      const a = requirePermission(req, 'platform:bots.manage');
      const body = parse(PublishBody, req.body);
      return p.database.withTenant(a.tenantId, (tx) => publishFlow(p, tx, a.tenantId, a.principal, idParam(req), body.version, body.service_role, correlationId(req)));
    });

    app.post('/api/bots/:id/rollback', async (req) => {
      const a = requirePermission(req, 'platform:bots.manage');
      const body = parse(z.object({ number: z.int().positive() }), req.body);
      return p.database.withTenant(a.tenantId, (tx) => rollbackFlow(p, tx, a.tenantId, a.principal, idParam(req), body.number, correlationId(req)));
    });

    app.post('/api/bots/:id/discard', async (req) => {
      const a = requirePermission(req, 'platform:bots.manage');
      await p.database.withTenant(a.tenantId, (tx) => discardFlowDraft(p, tx, a.tenantId, a.principal, idParam(req), correlationId(req)));
      return { ok: true };
    });

    app.post('/api/bots/:id/status', async (req) => {
      const a = requirePermission(req, 'platform:bots.manage');
      const body = parse(z.object({ status: z.enum(['active', 'disabled']) }), req.body);
      await p.database.withTenant(a.tenantId, (tx) => setFlowStatus(p, tx, a.tenantId, a.principal, idParam(req), body.status, correlationId(req)));
      return { ok: true };
    });

    /**
     * Test console: runs one customer message through a graph and returns what the bot
     * would do. Nothing is stored or sent; lookups and the assistant run as the tester
     * (their own permissions), so the console never shows more than the tester may see.
     */
    app.post('/api/bots/:id/test', async (req) => {
      const a = requirePermission(req, 'platform:bots.manage');
      const id = idParam(req);
      const body = parse(TestBody, req.body);
      const graph = BotGraph.safeParse(body.graph);
      if (!graph.success) throw new CommandError(422, 'invalid_graph', graph.error.issues.map((i) => `${i.path.join('.') || 'graph'}: ${i.message}`).join('; '));
      const problems = await p.database.withTenant(a.tenantId, async (tx) => {
        await requirePackage(p, tx, BOT_PACKAGE);
        await getFlow(tx, id);
        return validateBotGraph(graph.data, await botContext(p, tx));
      });
      if (problems.length) throw Object.assign(new CommandError(422, 'invalid_flow', `fix ${problems.length} problem(s) before testing: ${problems.slice(0, 3).join('; ')}`), { details: { problems } });
      const session = (body.session ?? null) as BotSession | null;
      const fx = await runBotTurn(graph.data, { id, number: 0 }, session ? { ...session, flow_id: id, number: 0 } : null, { text: body.text, channel: body.channel, contact: { name: 'Test visitor', verified: false } }, botDeps(p, a.tenantId, a.principal));
      return { messages: fx.messages, handoff: fx.handoff, trace: fx.trace, session: fx.session, ended: !fx.session };
    });
  };
}
