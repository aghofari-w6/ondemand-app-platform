import { randomUUID } from 'node:crypto';
import { startMock, type MockReply } from './server.ts';

/**
 * Mock Google OAuth + Gmail API (plan decision 6: no live calls). One server plays
 * accounts.google.com (consent → redirect with a code), oauth2.googleapis.com (token
 * exchange and refresh) and gmail.googleapis.com (profile, history, messages, send).
 * `revoke()` makes every refresh fail with `invalid_grant`, like a revoked grant or a
 * Testing-mode refresh token older than 7 days.
 */
export interface MockMail {
  id: string;
  threadId: string;
  historyId: number;
  labelIds: string[];
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  references: string;
  attachments: { attachmentId: string; filename: string; mimeType: string; data: Buffer }[];
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export async function startGoogleMock(opts: { email?: string; clientId?: string; clientSecret?: string } = {}, port = 0) {
  const email = opts.email ?? 'support@acme-coffee.example';
  const clientId = opts.clientId ?? 'test-client-id';
  const clientSecret = opts.clientSecret ?? 'test-client-secret';
  let historyId = 1000;
  let revoked = false;
  /** history ids at or below this are "too old" (404 from the History API) */
  let historyFloor = 0;
  const codes = new Set<string>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  const mails: MockMail[] = [];
  const sent: { raw: string; threadId: string | null; headers: Record<string, string>; text: string; id: string }[] = [];
  const consents: { redirect_uri: string; scope: string; access_type: string }[] = [];
  /** message ids the API fails to return (HTTP 500), like a message Gmail cannot serve */
  const broken = new Set<string>();
  let reads = 0;
  const unauthorized: MockReply = { status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } };

  const authed = (h: Record<string, unknown>) => {
    const t = String(h.authorization ?? '').replace(/^Bearer /, '');
    return accessTokens.has(t) && !revoked;
  };

  const mock = await startMock((req) => {
    // --- OAuth consent screen: approves at once and redirects back with a code.
    if (req.path === '/o/oauth2/v2/auth') {
      if (req.query.get('client_id') !== clientId) return { status: 400, json: { error: 'invalid_client' } };
      const code = `code-${randomUUID()}`;
      codes.add(code);
      consents.push({ redirect_uri: req.query.get('redirect_uri') ?? '', scope: req.query.get('scope') ?? '', access_type: req.query.get('access_type') ?? '' });
      const back = new URL(req.query.get('redirect_uri') ?? 'http://localhost');
      back.searchParams.set('code', code);
      back.searchParams.set('state', req.query.get('state') ?? '');
      return { redirect: back.toString() };
    }
    // --- token endpoint
    if (req.path === '/token' && req.method === 'POST') {
      const b = req.body ?? {};
      if (b.client_id !== clientId || b.client_secret !== clientSecret) return { status: 401, json: { error: 'invalid_client' } };
      if (b.grant_type === 'authorization_code') {
        if (!codes.delete(b.code)) return { status: 400, json: { error: 'invalid_grant', error_description: 'Bad code' } };
        const refresh = `refresh-${randomUUID()}`;
        const access = `access-${randomUUID()}`;
        refreshTokens.add(refresh);
        accessTokens.add(access);
        revoked = false;
        return { json: { access_token: access, refresh_token: refresh, expires_in: 3599, token_type: 'Bearer', scope: 'gmail' } };
      }
      if (b.grant_type === 'refresh_token') {
        if (revoked || !refreshTokens.has(b.refresh_token)) return { status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
        const access = `access-${randomUUID()}`;
        accessTokens.add(access);
        return { json: { access_token: access, expires_in: 3599, token_type: 'Bearer' } };
      }
      return { status: 400, json: { error: 'unsupported_grant_type' } };
    }
    // --- Gmail API
    const g = /^\/gmail\/v1\/users\/me(\/.*)$/.exec(req.path)?.[1];
    if (!g) return { status: 404, json: { error: { code: 404, message: 'Not Found' } } };
    if (!authed(req.headers as Record<string, unknown>)) return unauthorized;
    if (g === '/profile') return { json: { emailAddress: email, messagesTotal: mails.length, historyId: String(historyId) } };
    if (g === '/history') {
      const start = Number(req.query.get('startHistoryId'));
      if (!Number.isFinite(start) || start < historyFloor) return { status: 404, json: { error: { code: 404, message: 'Requested entity was not found.' } } };
      const added = mails.filter((m) => m.historyId > start);
      return { json: { history: added.map((m) => ({ id: String(m.historyId), messagesAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds } }] })), historyId: String(historyId) } };
    }
    if (g === '/messages' && req.method === 'GET') return { json: { messages: mails.filter((m) => m.labelIds.includes('INBOX')).slice(-Number(req.query.get('maxResults') ?? 20)).map((m) => ({ id: m.id, threadId: m.threadId })) } };
    if (g === '/messages/send' && req.method === 'POST') {
      const raw = Buffer.from(String(req.body?.raw ?? ''), 'base64url').toString('utf8');
      const [head, ...rest] = raw.split('\r\n\r\n');
      const headers = Object.fromEntries((head ?? '').split('\r\n').map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      const id = `sent-${sent.length + 1}`;
      sent.push({ raw, threadId: req.body?.threadId ?? null, headers, text: Buffer.from(rest.join('').replace(/\r\n/g, ''), 'base64').toString('utf8'), id });
      return { json: { id, threadId: req.body?.threadId ?? `thread-${id}`, labelIds: ['SENT'] } };
    }
    const att = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(g);
    if (att) {
      const a = mails.find((m) => m.id === att[1])?.attachments.find((x) => x.attachmentId === att[2]);
      return a ? { json: { size: a.data.length, data: b64url(a.data) } } : { status: 404, json: { error: { code: 404 } } };
    }
    const one = /^\/messages\/([^/]+)$/.exec(g);
    if (one) {
      reads++;
      if (broken.has(one[1]!)) return { status: 500, json: { error: { code: 500, message: 'Backend Error' } } };
      const m = mails.find((x) => x.id === one[1]);
      if (!m) return { status: 404, json: { error: { code: 404, message: 'Not Found' } } };
      return {
        json: {
          id: m.id,
          threadId: m.threadId,
          historyId: String(m.historyId),
          labelIds: m.labelIds,
          payload: {
            mimeType: m.attachments.length ? 'multipart/mixed' : 'text/plain',
            headers: [
              { name: 'From', value: m.from },
              { name: 'To', value: m.to },
              { name: 'Subject', value: m.subject },
              { name: 'Message-ID', value: m.messageId },
              ...(m.references ? [{ name: 'References', value: m.references }] : []),
            ],
            ...(m.attachments.length
              ? { parts: [{ mimeType: 'text/plain', body: { data: b64url(m.text) } }, ...m.attachments.map((a) => ({ mimeType: a.mimeType, filename: a.filename, body: { attachmentId: a.attachmentId, size: a.data.length } }))] }
              : { body: { data: b64url(m.text) } }),
          },
        },
      };
    }
    return { status: 404, json: { error: { code: 404, message: 'Not Found' } } };
  }, port);

  return {
    ...mock,
    email,
    clientId,
    clientSecret,
    sent,
    consents,
    broken,
    /** how many times a message was fetched (`messages.get`) */
    reads: () => reads,
    /** Delivers a message to the mailbox, as if a customer had emailed it. */
    receive(m: { from: string; subject: string; text: string; threadId?: string; references?: string; labelIds?: string[]; attachments?: { filename: string; mimeType: string; data: Buffer }[] }) {
      const id = `msg-${mails.length + 1}-${randomUUID().slice(0, 8)}`;
      const mail: MockMail = { id, threadId: m.threadId ?? `thread-${id}`, historyId: ++historyId, labelIds: m.labelIds ?? ['INBOX', 'UNREAD'], from: m.from, to: email, subject: m.subject, text: m.text, messageId: `<${id}@mail.example>`, references: m.references ?? '', attachments: (m.attachments ?? []).map((a, i) => ({ attachmentId: `att-${id}-${i}`, ...a })) };
      mails.push(mail);
      return mail;
    },
    /** The user removed access (or the Testing-mode token passed 7 days). */
    revoke() {
      revoked = true;
    },
    /** Makes history ids up to now too old for the History API. */
    expireHistory() {
      historyFloor = historyId + 1;
    },
  };
}

/** Mock Voyage AI embeddings endpoint: fixed-size vectors, the documented response shape, optional 429s first. */
export async function startVoyageMock(dimension: number, port = 0) {
  const calls: { input: string[]; model: string; input_type: string; output_dimension: number; authorization: string }[] = [];
  const failures: number[] = [];
  const mock = await startMock((req) => {
    if (req.path !== '/v1/embeddings' || req.method !== 'POST') return { status: 404, json: { detail: 'Not Found' } };
    const fail = failures.shift();
    if (fail) return { status: fail, json: { detail: fail === 429 ? 'Rate limit exceeded' : 'Server error' }, ...(fail === 429 ? { headers: { 'retry-after': '0' } } : {}) };
    const input = (Array.isArray(req.body?.input) ? req.body.input : [req.body?.input]) as string[];
    calls.push({ input, model: req.body?.model, input_type: req.body?.input_type, output_dimension: req.body?.output_dimension, authorization: String(req.headers.authorization ?? '') });
    return { json: { object: 'list', data: input.map((text, index) => ({ object: 'embedding', index, embedding: Array.from({ length: dimension }, (_, i) => ((text.length + i) % 7) / 7) })), model: req.body?.model, usage: { total_tokens: input.reduce((n, t) => n + Math.ceil(t.length / 4), 0) } } };
  }, port);
  return { ...mock, calls, failures };
}
