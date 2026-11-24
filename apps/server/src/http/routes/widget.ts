import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CommandError } from '@aod/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Platform } from '../../platform/context.ts';
import { parseWidgetKey, verifyIdentity, type ChannelRow } from '../../platform/conversations/channels.ts';
import { ingestMessage, setContactEmail, type Identity } from '../../platform/conversations/inbox.ts';
import { parse } from '../app.ts';
import { WIDGET_JS, widgetDemoHtml, widgetFrameHtml } from '../widget-assets.ts';

/**
 * Public web chat widget: the embed script, the chat frame, and its API (session,
 * messages, email capture, Server-Sent Events). Visitors are anonymous; a site can prove
 * a signed-in user with an HMAC of the user id (identity verification).
 *
 * Abuse controls: only the widget's allowed origins may frame the chat or call the API
 * (frame-ancestors + CORS + an Origin check), session tokens are signed, and requests are
 * rate-limited per visitor, per address and per tenant, with small size caps.
 */

const SESSION_TTL_MS = 30 * 24 * 3600_000;
const STREAM_MAX_MS = 15 * 60_000;
const MAX_TEXT = 2000;
const LIMITS = { sessionPerIp: 30, sessionPerWidget: 600, messagePerVisitor: 20, messagePerTenant: 600, streamsPerVisitor: 12, openStreamsPerWidget: 500, openStreamsPerVisitor: 3 };

interface Session {
  t: string;
  a: string;
  v: string;
  /** verified site user id */
  u?: string;
  exp: number;
}

const SessionBody = z.object({ key: z.string().max(80), visitor_token: z.string().max(1000).optional(), identity: z.object({ user_id: z.string().min(1).max(200), hash: z.string().regex(/^[0-9a-fA-F]{64}$/) }).optional() });
const MessageBody = z.object({ text: z.string().trim().min(1).max(MAX_TEXT), client_id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional() });
const EmailBody = z.object({ email: z.email().max(200) });

export function widgetRoutes(p: Platform) {
  // Open event streams per widget and per visitor: a hard ceiling whatever the request rate.
  const openStreams = new Map<string, number>();
  const hold = (key: string, max: number) => {
    const n = openStreams.get(key) ?? 0;
    if (n >= max) return false;
    openStreams.set(key, n + 1);
    return true;
  };
  const release = (key: string) => {
    const n = (openStreams.get(key) ?? 1) - 1;
    if (n <= 0) openStreams.delete(key);
    else openStreams.set(key, n);
  };
  const sign = (body: string) => p.ports.vault.mac(body, 'widget-session');
  const issue = (s: Session) => {
    const body = Buffer.from(JSON.stringify(s)).toString('base64url');
    return `ws1.${body}.${sign(body)}`;
  };
  const read = (token: string | undefined): Session | null => {
    const [v, body, mac] = (token ?? '').split('.');
    if (v !== 'ws1' || !body || !mac) return null;
    const expected = Buffer.from(sign(body));
    const got = Buffer.from(mac);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    try {
      const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
      return s.exp > Date.now() ? s : null;
    } catch {
      return null;
    }
  };

  const own = new URL(p.env.PUBLIC_URL).origin;
  const loadAccount = async (tenantId: string, accountId: string) => {
    const a = (await p.database.withTenant(tenantId, (tx) => tx.selectFrom('channel_account').selectAll().where('id', '=', accountId).where('kind', '=', 'widget').executeTakeFirst())) as ChannelRow | undefined;
    if (!a || a.status !== 'active') throw new CommandError(404, 'widget_not_found', 'this chat is not available');
    return a;
  };
  const allowed = (a: ChannelRow) => new Set<string>([own, ...((a.config.allowed_origins as string[] | undefined) ?? [])]);

  /** CORS for the widget API: only the widget's own origins get an allow header; other origins are refused. */
  const cors = (req: FastifyRequest, reply: FastifyReply, a: ChannelRow) => {
    const origin = req.headers.origin;
    if (!origin) return;
    if (!allowed(a).has(origin)) throw new CommandError(403, 'origin_not_allowed', 'this site is not allowed to use the chat');
    reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
  };
  const limited = (key: string, limit: number) => {
    if (!p.ports.rateLimit.take(key, limit, 60_000)) throw new CommandError(429, 'rate_limited', 'too many requests; wait a moment');
  };

  const sessionOf = async (req: FastifyRequest, reply: FastifyReply, tokenOverride?: string) => {
    const h = req.headers.authorization;
    const s = read(tokenOverride ?? (h?.startsWith('Bearer ') ? h.slice(7) : undefined));
    if (!s) throw new CommandError(401, 'invalid_session', 'the chat session has expired; reload the page');
    const account = await loadAccount(s.t, s.a);
    cors(req, reply, account);
    return { s, account };
  };
  const threadKey = (s: Session) => (s.u ? `user:${s.u}` : `visitor:${s.v}`);
  const conversationOf = (s: Session) => p.database.withTenant(s.t, (tx) => tx.selectFrom('conversation').select(['id', 'contact_id']).where('account_id', '=', s.a).where('thread_key', '=', threadKey(s)).executeTakeFirst());
  const identities = (s: Session): Identity[] => [{ kind: 'widget_visitor', value: `${s.a}:${s.v}`, verified: false }, ...(s.u ? [{ kind: 'widget_user' as const, value: `${s.a}:${s.u}`, verified: true }] : [])];

  const view = (m: { id: string; seq: number; direction: string; author_type: string; body: string; meta: unknown; created_at: Date }) => ({ id: m.id, seq: Number(m.seq), from: m.direction === 'in' ? 'you' : m.author_type === 'bot' ? 'bot' : m.author_type === 'system' ? 'system' : 'agent', body: m.body, citations: ((m.meta as { citations?: { n: number; title: string }[] } | null)?.citations ?? []).map((c) => ({ n: c.n, title: c.title })), created_at: m.created_at });

  return async function (app: FastifyInstance) {
    app.get('/widget.js', async (_req, reply) => reply.header('content-type', 'application/javascript; charset=utf-8').header('cache-control', 'public, max-age=300').header('cross-origin-resource-policy', 'cross-origin').send(WIDGET_JS));

    /** The chat document. `frame-ancestors` lets only the widget's allowed origins embed it. */
    app.get('/widget/frame', async (req, reply) => {
      const q = parse(z.object({ key: z.string().max(80) }), { key: (req.query as { key?: string }).key ?? '' });
      const k = parseWidgetKey(q.key);
      if (!k) throw new CommandError(404, 'widget_not_found', 'this chat is not available');
      const account = await loadAccount(k.tenantId, k.accountId);
      const tenant = await p.database.withTenant(k.tenantId, (tx) => tx.selectFrom('tenant').select('name').executeTakeFirst());
      const nonce = randomBytes(16).toString('base64');
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${[...allowed(account)].join(' ')}`)
        .send(widgetFrameHtml(nonce, tenant?.name ?? 'Chat'));
    });

    /** Stand-in for a tenant website, for demos and the e2e journey; never served in production. */
    app.get('/widget/demo', async (req, reply) => {
      if (p.env.NODE_ENV === 'production' && !p.env.DEMO_MODE) throw new CommandError(404, 'not_found', 'not found');
      const k = parseWidgetKey(String((req.query as { key?: string }).key ?? ''));
      if (!k) throw new CommandError(404, 'widget_not_found', 'this chat is not available');
      await loadAccount(k.tenantId, k.accountId);
      const tenant = await p.database.withTenant(k.tenantId, (tx) => tx.selectFrom('tenant').select('name').executeTakeFirst());
      return reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(widgetDemoHtml(`wk_${k.tenantId.replace(/-/g, '')}_${k.accountId.replace(/-/g, '')}`, tenant?.name ?? 'Demo'));
    });

    // CORS preflight: answered without credentials; the real request is checked against the widget's origins.
    app.options('/widget/api/*', async (req, reply) =>
      reply
        .header('access-control-allow-origin', req.headers.origin ?? own)
        .header('vary', 'Origin')
        .header('access-control-allow-methods', 'GET, POST')
        .header('access-control-allow-headers', 'authorization, content-type')
        .header('access-control-max-age', '600')
        .code(204)
        .send(),
    );

    app.post('/widget/api/session', async (req, reply) => {
      limited(`widget:session:${req.ip}`, LIMITS.sessionPerIp);
      const body = parse(SessionBody, req.body);
      const k = parseWidgetKey(body.key);
      if (!k) throw new CommandError(404, 'widget_not_found', 'this chat is not available');
      const account = await loadAccount(k.tenantId, k.accountId);
      cors(req, reply, account);
      // The address can be forged behind a proxy, so the widget as a whole is limited too.
      limited(`widget:session:${k.accountId}`, LIMITS.sessionPerWidget);
      // A returning visitor keeps their conversation; a token for another widget is ignored.
      const prior = read(body.visitor_token);
      const visitor = prior && prior.t === k.tenantId && prior.a === k.accountId ? prior.v : randomUUID();
      let user: string | undefined;
      if (body.identity) {
        if (!verifyIdentity(p, account, body.identity.user_id, body.identity.hash)) throw new CommandError(403, 'identity_not_verified', 'the user identity could not be verified');
        user = body.identity.user_id;
      }
      const s: Session = { t: k.tenantId, a: k.accountId, v: visitor, ...(user ? { u: user } : {}), exp: Date.now() + SESSION_TTL_MS };
      const conv = await conversationOf(s);
      const hasEmail = conv ? Boolean((await p.database.withTenant(s.t, (tx) => tx.selectFrom('conv_contact').select('email_enc').where('id', '=', conv.contact_id).executeTakeFirst()))?.email_enc) : false;
      return { token: issue(s), verified: Boolean(user), has_email: hasEmail, config: { accent: /^#[0-9a-fA-F]{6}$/.test(String(account.config.accent)) ? account.config.accent : '#2856D9', greeting: String(account.config.greeting ?? 'Hi! How can we help?').slice(0, 200) } };
    });

    app.get('/widget/api/messages', async (req, reply) => {
      const { s } = await sessionOf(req, reply);
      const after = Number((req.query as { after?: string }).after ?? 0) || 0;
      const conv = await conversationOf(s);
      if (!conv) return { messages: [] };
      const rows = await p.database.withTenant(s.t, (tx) => tx.selectFrom('conv_message').select(['id', 'seq', 'direction', 'author_type', 'body', 'meta', 'created_at']).where('conversation_id', '=', conv.id).where('direction', 'in', ['in', 'out']).where('seq', '>', after).orderBy('seq').limit(200).execute());
      return { messages: rows.map((m) => view(m as any)) };
    });

    app.post('/widget/api/messages', { bodyLimit: 16 * 1024 }, async (req, reply) => {
      const { s, account } = await sessionOf(req, reply);
      limited(`widget:msg:${s.a}:${s.v}`, LIMITS.messagePerVisitor);
      limited(`widget:tenant:${s.t}`, LIMITS.messagePerTenant);
      const body = parse(MessageBody, req.body);
      // The frame sends an id per message: a resend after a lost response is the same message.
      const externalId = `w:${body.client_id ?? randomUUID()}`;
      const r = await ingestMessage(p, s.t, account, { threadKey: threadKey(s), externalId, text: body.text, contact: { name: null }, identities: identities(s), correlationId: `widget:${randomUUID()}` });
      p.ports.realtime.publish(`widget:${s.a}:${threadKey(s)}`);
      const m = await p.database.withTenant(s.t, (tx) => tx.selectFrom('conv_message').select(['id', 'seq', 'direction', 'author_type', 'body', 'meta', 'created_at']).where('conversation_id', '=', r.conversationId).where('external_id', '=', externalId).executeTakeFirstOrThrow());
      return reply.code('duplicate' in r ? 200 : 201).send({ message: view(m as any) });
    });

    /** Optional email capture: stored encrypted on the contact, and as an (unverified) identity. */
    app.post('/widget/api/email', { bodyLimit: 4 * 1024 }, async (req, reply) => {
      const { s, account } = await sessionOf(req, reply);
      limited(`widget:email:${s.a}:${s.v}`, 5);
      const body = parse(EmailBody, req.body);
      const conv = await conversationOf(s);
      if (!conv) throw new CommandError(409, 'no_conversation', 'send a message first');
      await p.database.withTenant(s.t, (tx) => setContactEmail(p, tx, s.t, conv.contact_id, body.email, account.kind));
      return { ok: true };
    });

    /**
     * Server-Sent Events for one visitor: "changed" whenever their conversation has
     * something new. Waits on in-process notifications with a 25 s keep-alive, ends with
     * the connection or after 15 minutes (EventSource reconnects by itself).
     */
    app.get('/widget/api/events', async (req, reply) => {
      const { s } = await sessionOf(req, reply, String((req.query as { token?: string }).token ?? ''));
      limited(`widget:sse:${s.a}:${s.v}`, LIMITS.streamsPerVisitor);
      const slots = [`w:${s.a}`, `v:${s.a}:${s.v}`] as const;
      if (!hold(slots[0], LIMITS.openStreamsPerWidget)) throw new CommandError(503, 'busy', 'the chat is busy; new messages still arrive when you send one');
      if (!hold(slots[1], LIMITS.openStreamsPerVisitor)) {
        release(slots[0]);
        throw new CommandError(429, 'rate_limited', 'too many open chat windows');
      }
      const origin = req.headers.origin;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}) });
      const ac = new AbortController();
      const onClose = () => ac.abort();
      res.on('close', onClose);
      const deadline = Date.now() + STREAM_MAX_MS;
      let conversationId: string | null = null;
      const cursor = new Map<string, number>();
      // The visitor's own topic is published when they send their first message.
      const mine = `widget:${s.a}:${threadKey(s)}`;
      try {
        res.write('event: ready\ndata: {}\n\n');
        // The conversation is looked up once, and again only when this visitor's own topic
        // is published (their first message): an idle visitor costs no queries.
        let look = true;
        while (!ac.signal.aborted && Date.now() < deadline) {
          if (!conversationId && look) {
            conversationId = (await conversationOf(s))?.id ?? null;
            // Anything that happened before we started listening is picked up by this refresh.
            if (conversationId) res.write('event: changed\ndata: {}\n\n');
          }
          const published = await p.ports.realtime.wait(conversationId ? [`conversation:${conversationId}`] : [mine], 25_000, ac.signal, cursor);
          if (ac.signal.aborted) break;
          look = published;
          res.write(published && conversationId ? 'event: changed\ndata: {}\n\n' : ': keep-alive\n\n');
        }
      } catch (e) {
        p.log.warn({ err: String(e) }, 'widget stream failed');
      } finally {
        release(slots[0]);
        release(slots[1]);
        res.off('close', onClose);
        if (!res.writableEnded) res.end();
      }
    });
  };
}
