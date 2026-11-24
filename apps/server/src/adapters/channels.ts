import { createHash } from 'node:crypto';
import { ReconnectRequired, type ChannelSendResult, type GmailMessage, type GmailTransport, type OutboundHttp, type TelegramTransport } from '../ports/index.ts';
import { BoundedCache } from './bounded-cache.ts';

const short = (v: unknown) => String(v ?? '').slice(0, 300);

// ------------------------------------------------------------------ Telegram

/**
 * Telegram Bot API client. The bot token is part of the URL path, so errors and logs
 * only ever carry Telegram's own description, never the URL.
 */
export function createTelegram(http: OutboundHttp, baseUrl: string): TelegramTransport {
  const call = async (token: string, method: string, body?: unknown) => {
    if (!/^[A-Za-z0-9:_-]{10,100}$/.test(token)) throw new Error('that does not look like a Telegram bot token');
    return http.json({ url: `${baseUrl.replace(/\/$/, '')}/bot${token}/${method}`, method: 'POST', body: body ?? {}, maxBytes: 256 * 1024 });
  };
  const fail = (r: { status: number; body: any }) => new Error(`Telegram: ${short(r.body?.description ?? `HTTP ${r.status}`)}`);
  return {
    async getMe(token) {
      const r = await call(token, 'getMe');
      if (!r.ok || !r.body?.ok) throw fail(r);
      return { id: Number(r.body.result.id), username: String(r.body.result.username ?? '') };
    },
    async setWebhook(token, url, secretToken) {
      const r = await call(token, 'setWebhook', { url, secret_token: secretToken, allowed_updates: ['message'] });
      if (!r.ok || !r.body?.ok) throw fail(r);
    },
    async deleteWebhook(token) {
      const r = await call(token, 'deleteWebhook');
      if (!r.ok || !r.body?.ok) throw fail(r);
    },
    async sendMessage(token, chatId, text, replyToMessageId): Promise<ChannelSendResult> {
      const r = await call(token, 'sendMessage', { chat_id: chatId, text, ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}) });
      if (r.ok && r.body?.ok) return { ok: true, externalId: String(r.body.result?.message_id ?? '') };
      // 429 and 5xx are worth another attempt; a bad token or a blocked bot is not.
      const retryable = r.status === 429 || r.status >= 500;
      return { ok: false, error: `Telegram: ${short(r.body?.description ?? `HTTP ${r.status}`)}`, retryable, reconnect: r.status === 401 };
    },
  };
}

// ------------------------------------------------------------------ Gmail

const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';
export const MAX_EMAIL_TEXT = 100_000;

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');
/** Header values never carry line breaks (header injection). */
const headerSafe = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export function buildMime(msg: { from: string; to: string; subject: string; text: string; inReplyTo?: string; references?: string }): string {
  const lines = [
    `From: ${headerSafe(msg.from)}`,
    `To: ${headerSafe(msg.to)}`,
    `Subject: ${encodeWord(headerSafe(msg.subject))}`,
    ...(msg.inReplyTo ? [`In-Reply-To: ${headerSafe(msg.inReplyTo)}`] : []),
    ...(msg.references ? [`References: ${headerSafe(msg.references)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(msg.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ];
  return lines.join('\r\n');
}

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
}

const stripHtml = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

export function parseGmailMessage(m: { id: string; threadId: string; historyId?: string; labelIds?: string[]; payload?: Part }): GmailMessage {
  const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  let plain = '';
  let html = '';
  const attachments: GmailMessage['attachments'] = [];
  const stack: Part[] = m.payload ? [m.payload] : [];
  let visited = 0;
  while (stack.length && visited++ < 200) {
    const part = stack.shift()!;
    if (part.filename && part.body?.attachmentId) attachments.push({ attachmentId: part.body.attachmentId, filename: part.filename.slice(0, 200), mimeType: part.mimeType ?? 'application/octet-stream', size: part.body.size ?? 0 });
    else if (part.mimeType === 'text/plain' && part.body?.data && !plain) plain = fromB64url(part.body.data).toString('utf8');
    else if (part.mimeType === 'text/html' && part.body?.data && !html) html = fromB64url(part.body.data).toString('utf8');
    if (part.parts) stack.push(...part.parts);
  }
  return {
    id: m.id,
    threadId: m.threadId,
    historyId: String(m.historyId ?? ''),
    labelIds: m.labelIds ?? [],
    from: header('from'),
    to: header('to'),
    subject: header('subject'),
    messageId: header('message-id'),
    references: header('references'),
    text: (plain || stripHtml(html)).slice(0, MAX_EMAIL_TEXT).trim(),
    attachments: attachments.slice(0, 10),
  };
}

export interface GmailOptions {
  clientId: string | undefined;
  clientSecret: string | undefined;
  oauthUrl: string;
  tokenUrl: string;
  apiUrl: string;
}

/** Gmail API + Google OAuth client. Access tokens are cached in memory (bounded, 50 minutes). */
export function createGmail(http: OutboundHttp, o: GmailOptions): GmailTransport {
  const tokens = new BoundedCache<string>({ max: 2000, ttlMs: 50 * 60_000 });
  const api = `${o.apiUrl.replace(/\/$/, '')}/gmail/v1/users/me`;
  const auth = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });
  const need = () => {
    if (!o.clientId || !o.clientSecret) throw new Error('Gmail is not configured: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET');
    return { client_id: o.clientId, client_secret: o.clientSecret };
  };
  const get = async (accessToken: string, path: string, maxBytes?: number) => {
    const r = await http.json({ url: `${api}${path}`, headers: auth(accessToken), ...(maxBytes ? { maxBytes } : {}) });
    if (r.status === 401) throw new ReconnectRequired();
    return r;
  };
  return {
    configured: () => Boolean(o.clientId && o.clientSecret),
    authorizationUrl(p) {
      const q = new URLSearchParams({ client_id: need().client_id, redirect_uri: p.redirectUri, response_type: 'code', scope: GMAIL_SCOPES, access_type: 'offline', prompt: 'consent', state: p.state });
      return `${o.oauthUrl.replace(/\/$/, '')}/o/oauth2/v2/auth?${q.toString()}`;
    },
    async exchangeCode(p) {
      const r = await http.json({ url: `${o.tokenUrl.replace(/\/$/, '')}/token`, form: { ...need(), code: p.code, redirect_uri: p.redirectUri, grant_type: 'authorization_code' } });
      if (!r.ok || !r.body?.refresh_token || !r.body?.access_token) throw new Error(`Google did not grant offline access: ${short(r.body?.error_description ?? r.body?.error ?? `HTTP ${r.status}`)}`);
      return { refreshToken: String(r.body.refresh_token), accessToken: String(r.body.access_token) };
    },
    async accessToken(refreshToken) {
      const key = createHash('sha256').update(refreshToken).digest('hex');
      const hit = tokens.get(key);
      if (hit) return hit;
      const r = await http.json({ url: `${o.tokenUrl.replace(/\/$/, '')}/token`, form: { ...need(), refresh_token: refreshToken, grant_type: 'refresh_token' } });
      // invalid_grant: access revoked, or a Testing-mode refresh token older than 7 days.
      if (r.status === 400 || r.status === 401) throw new ReconnectRequired();
      if (!r.ok || !r.body?.access_token) throw new Error(`Google token refresh failed: HTTP ${r.status}`);
      tokens.set(key, String(r.body.access_token));
      return String(r.body.access_token);
    },
    async profile(accessToken) {
      const r = await get(accessToken, '/profile');
      if (!r.ok) throw new Error(`Gmail profile: HTTP ${r.status}`);
      return { emailAddress: String(r.body.emailAddress).toLowerCase(), historyId: String(r.body.historyId) };
    },
    async history(accessToken, startHistoryId) {
      const ids = new Set<string>();
      let historyId = startHistoryId;
      let pageToken: string | undefined;
      // Bounded paging: a mailbox that received thousands of messages is caught up over several polls.
      for (let page = 0; page < 10; page++) {
        const q = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: '100', ...(pageToken ? { pageToken } : {}) });
        const r = await get(accessToken, `/history?${q.toString()}`);
        if (r.status === 404) return { messageIds: [], historyId: startHistoryId, expired: true };
        if (!r.ok) throw new Error(`Gmail history: HTTP ${r.status}`);
        for (const h of (r.body?.history ?? []) as { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]) {
          for (const a of h.messagesAdded ?? []) if (!a.message.labelIds || a.message.labelIds.includes('INBOX')) ids.add(a.message.id);
        }
        if (r.body?.historyId) historyId = String(r.body.historyId);
        pageToken = r.body?.nextPageToken;
        if (!pageToken) break;
      }
      return { messageIds: [...ids], historyId, expired: false };
    },
    async listRecent(accessToken, max) {
      const q = new URLSearchParams({ labelIds: 'INBOX', maxResults: String(Math.min(max, 50)), q: 'newer_than:1d' });
      const r = await get(accessToken, `/messages?${q.toString()}`);
      if (!r.ok) throw new Error(`Gmail list: HTTP ${r.status}`);
      return ((r.body?.messages ?? []) as { id: string }[]).map((m) => m.id);
    },
    async getMessage(accessToken, id) {
      const r = await get(accessToken, `/messages/${encodeURIComponent(id)}?format=full`, 8 * 1024 * 1024);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Gmail message: HTTP ${r.status}`);
      return parseGmailMessage(r.body);
    },
    async attachment(accessToken, messageId, attachmentId, maxBytes) {
      // Gmail returns attachments as base64url inside JSON, so the response is capped
      // (4/3 of the byte limit) rather than streamed.
      const r = await get(accessToken, `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, Math.ceil(maxBytes * 1.4) + 1024);
      if (!r.ok || typeof r.body?.data !== 'string') throw new Error(`Gmail attachment: HTTP ${r.status}`);
      const bytes = fromB64url(r.body.data);
      return (async function* () {
        yield bytes;
      })();
    },
    async send(accessToken, msg): Promise<ChannelSendResult> {
      const r = await http.json({ url: `${api}/messages/send`, headers: auth(accessToken), body: { raw: b64url(buildMime(msg)), ...(msg.threadId ? { threadId: msg.threadId } : {}) } });
      if (r.ok && r.body?.id) return { ok: true, externalId: String(r.body.id), threadId: String(r.body.threadId ?? msg.threadId ?? '') };
      if (r.status === 401) return { ok: false, error: 'Gmail access expired or was revoked', retryable: false, reconnect: true };
      return { ok: false, error: `Gmail: ${short(r.body?.error?.message ?? `HTTP ${r.status}`)}`, retryable: r.status === 429 || r.status >= 500 };
    },
  };
}
