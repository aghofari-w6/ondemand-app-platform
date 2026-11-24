import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CommandError, type Principal } from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../../db/database.ts';
import { ReconnectRequired } from '../../ports/index.ts';
import type { Platform } from '../context.ts';
import { OMNICHANNEL_PACKAGE, packageEnabled, planLimit, requirePackage } from '../packages.ts';
import { recordChange } from '../record.ts';
import { ingestMessage } from './inbox.ts';

/**
 * Channel accounts: Telegram bots, Gmail mailboxes and web chat widgets. Secrets (bot
 * token + webhook secret, Gmail refresh token, widget identity secret) are encrypted with
 * the Vault port and never returned by an API after creation.
 */

const RESOURCE = 'platform::ChannelAccount';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const aad = (tenantId: string, id: string) => `channel:${tenantId}:${id}`;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;

export interface ChannelRow {
  id: string;
  tenant_id: string;
  kind: 'telegram' | 'gmail' | 'widget';
  name: string;
  status: 'pending' | 'active' | 'disabled' | 'needs_reconnect';
  config: Record<string, any>;
  secret_enc: string | null;
  cursor: Record<string, any>;
  last_error: string | null;
  last_inbound_at: Date | null;
  version: number;
  created_at: Date;
}

/** Decrypted secrets, or null when they cannot be read (vault key changed): callers fail visibly. */
export function openSecrets(p: Platform, a: Pick<ChannelRow, 'id' | 'tenant_id' | 'secret_enc'>): Record<string, string> | null {
  if (!a.secret_enc) return null;
  try {
    return JSON.parse(p.ports.vault.decrypt(a.secret_enc, aad(a.tenant_id, a.id)));
  } catch {
    return null;
  }
}
const seal = (p: Platform, tenantId: string, id: string, secrets: Record<string, string>) => p.ports.vault.encrypt(JSON.stringify(secrets), aad(tenantId, id));

const compact = (uuid: string) => uuid.replace(/-/g, '');
const expand = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
/** Public widget key: names the tenant and the widget, carries no secret. */
export const widgetKey = (tenantId: string, accountId: string) => `wk_${compact(tenantId)}_${compact(accountId)}`;
export function parseWidgetKey(key: string): { tenantId: string; accountId: string } | null {
  const m = /^wk_([0-9a-f]{32})_([0-9a-f]{32})$/.exec(key);
  return m ? { tenantId: expand(m[1]!), accountId: expand(m[2]!) } : null;
}

/** Public view: never includes secrets. */
export function channelView(p: Platform, r: ChannelRow) {
  const base = { id: r.id, kind: r.kind, name: r.name, status: r.status, config: r.config, last_error: r.last_error, last_inbound_at: r.last_inbound_at, version: r.version, created_at: r.created_at, secret_unreadable: Boolean(r.secret_enc) && !openSecrets(p, r) };
  if (r.kind !== 'widget') return base;
  const key = widgetKey(r.tenant_id, r.id);
  return { ...base, widget_key: key, embed_code: `<script async src="${p.env.PUBLIC_URL}/widget.js" data-key="${key}"></script>`, demo_url: `${p.env.PUBLIC_URL}/widget/demo?key=${key}` };
}

async function assertRoom(p: Platform, tx: Tx) {
  await requirePackage(p, tx, OMNICHANNEL_PACKAGE);
  const limit = await planLimit(p, tx, 'channels');
  const n = await tx.selectFrom('channel_account').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
  if (n.n >= limit) throw new CommandError(409, 'plan_limit', `your plan allows ${limit} channels`);
}

const nameTaken = (e: any, name: string) => {
  if (e?.code === '23505') throw new CommandError(409, 'name_taken', `a channel named ${name} exists`);
  throw e;
};

const connected = (p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, kind: string, correlationId: string) =>
  recordChange(p, tx, { tenantId, actor, action: 'platform:channel.connected', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: 'channel.connected', data: { account_id: id, kind } }] });

// ------------------------------------------------------------------ Telegram

export async function connectTelegram(p: Platform, tenantId: string, actor: Principal, input: { name: string; token: string; sla_minutes?: number | undefined }, correlationId: string) {
  await p.database.withTenant(tenantId, (tx) => assertRoom(p, tx));
  // Checked against Telegram before anything is stored; no transaction is held meanwhile.
  let me: { id: number; username: string };
  try {
    me = await p.ports.channel.telegram.getMe(input.token);
  } catch (e) {
    throw new CommandError(422, 'invalid_token', `Telegram did not accept this bot token: ${(e as Error).message}`);
  }
  const id = newId();
  const webhookSecret = randomBytes(24).toString('hex');
  try {
    await p.ports.channel.telegram.setWebhook(input.token, `${p.env.PUBLIC_URL}/hooks/telegram/${tenantId}/${id}`, webhookSecret);
  } catch (e) {
    throw new CommandError(502, 'webhook_failed', `Telegram refused the webhook: ${(e as Error).message}`);
  }
  await p.database.withTenant(tenantId, async (tx) => {
    await assertRoom(p, tx);
    await tx
      .insertInto('channel_account')
      .values({ id, tenant_id: tenantId, kind: 'telegram', name: input.name, status: 'active', config: JSON.stringify({ bot_username: me.username, sla_minutes: input.sla_minutes ?? 15 }), secret_enc: seal(p, tenantId, id, { token: input.token, webhook_secret: webhookSecret }), created_by: actor.id })
      .execute()
      .catch((e) => nameTaken(e, input.name));
    await connected(p, tx, tenantId, actor, id, 'telegram', correlationId);
  });
  return { id };
}

/**
 * Gives an existing Telegram channel a new bot token (the old one was revoked, or the
 * stored one can no longer be read). The bot must be the same one, so its conversations
 * stay with their chats.
 */
export async function reconnectTelegram(p: Platform, tenantId: string, actor: Principal, id: string, token: string, correlationId: string) {
  const a = (await p.database.withTenant(tenantId, (tx) => tx.selectFrom('channel_account').selectAll().where('id', '=', id).where('kind', '=', 'telegram').executeTakeFirst())) as ChannelRow | undefined;
  if (!a) throw new CommandError(404, 'not_found', 'Telegram channel not found');
  let me: { id: number; username: string };
  try {
    me = await p.ports.channel.telegram.getMe(token);
  } catch (e) {
    throw new CommandError(422, 'invalid_token', `Telegram did not accept this bot token: ${(e as Error).message}`);
  }
  if (a.config.bot_username && me.username !== a.config.bot_username) throw new CommandError(409, 'different_bot', `this channel belongs to @${a.config.bot_username}; use that bot's token, or add @${me.username} as a new channel`);
  const webhookSecret = randomBytes(24).toString('hex');
  try {
    await p.ports.channel.telegram.setWebhook(token, `${p.env.PUBLIC_URL}/hooks/telegram/${tenantId}/${id}`, webhookSecret);
  } catch (e) {
    throw new CommandError(502, 'webhook_failed', `Telegram refused the webhook: ${(e as Error).message}`);
  }
  await p.database.withTenant(tenantId, async (tx) => {
    await tx.updateTable('channel_account').set({ status: 'active', secret_enc: seal(p, tenantId, id, { token, webhook_secret: webhookSecret }), config: JSON.stringify({ ...a.config, bot_username: me.username }), last_error: null, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
    await connected(p, tx, tenantId, actor, id, 'telegram', correlationId);
  });
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Inbound Telegram update. The secret token header proves it comes from Telegram for this bot. */
export async function handleTelegramUpdate(p: Platform, tenantId: string, accountId: string, secretToken: string | undefined, update: any, correlationId: string) {
  if (!UUID.test(tenantId) || !UUID.test(accountId)) throw new CommandError(404, 'not_found', 'not found');
  const account = (await p.database.withTenant(tenantId, (tx) => tx.selectFrom('channel_account').selectAll().where('id', '=', accountId).where('kind', '=', 'telegram').executeTakeFirst())) as ChannelRow | undefined;
  const secrets = account ? openSecrets(p, account) : null;
  // One answer for "no such bot" and "wrong secret": nothing to probe.
  if (!account || !secrets?.webhook_secret || !secretToken || !safeEqual(secretToken, secrets.webhook_secret)) throw new CommandError(403, 'forbidden', 'invalid secret token');
  if (account.status !== 'active') return { ignored: 'channel is not active' };
  const m = update?.message;
  if (!m || typeof m.text !== 'string' || !m.chat?.id || !m.from?.id) return { ignored: 'not a text message' };
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || null;
  return ingestMessage(p, tenantId, account, {
    threadKey: String(m.chat.id),
    externalId: `tg:${m.message_id}`,
    text: String(m.text).slice(0, 8000),
    contact: { name },
    identities: [{ kind: 'telegram', value: String(m.from.id), verified: true }],
    meta: { telegram_message_id: Number(m.message_id) },
    correlationId,
  });
}

// ------------------------------------------------------------------ widget

export interface WidgetInput {
  name: string;
  allowed_origins: string[];
  accent?: string | undefined;
  greeting?: string | undefined;
  sla_minutes?: number | undefined;
}

const widgetConfig = (i: WidgetInput) => ({ allowed_origins: [...new Set(i.allowed_origins.map((o) => new URL(o).origin))], accent: i.accent ?? '#2856D9', greeting: i.greeting ?? 'Hi! How can we help?', sla_minutes: i.sla_minutes ?? 15 });

export async function createWidget(p: Platform, tx: Tx, tenantId: string, actor: Principal, input: WidgetInput, correlationId: string) {
  await assertRoom(p, tx);
  const id = newId();
  const identitySecret = randomBytes(32).toString('hex');
  await tx
    .insertInto('channel_account')
    .values({ id, tenant_id: tenantId, kind: 'widget', name: input.name, status: 'active', config: JSON.stringify(widgetConfig(input)), secret_enc: seal(p, tenantId, id, { identity_secret: identitySecret }), created_by: actor.id })
    .execute()
    .catch((e) => nameTaken(e, input.name));
  await connected(p, tx, tenantId, actor, id, 'widget', correlationId);
  // Shown once: the site's backend signs user ids with it (identity verification).
  return { id, identity_secret: identitySecret };
}

/** HMAC-SHA256(user id) with the widget's identity secret, hex: proves a signed-in site user. */
export const identityHash = (secret: string, userId: string) => createHmac('sha256', secret).update(userId).digest('hex');
export function verifyIdentity(p: Platform, account: ChannelRow, userId: string, hash: string): boolean {
  const secret = openSecrets(p, account)?.identity_secret;
  return Boolean(secret) && safeEqual(identityHash(secret!, userId), hash.toLowerCase());
}

// ------------------------------------------------------------------ Gmail

const STATE_TTL_MS = 15 * 60_000;
const signState = (p: Platform, body: string) => p.ports.vault.mac(body, 'gmail-oauth-state');
export const gmailRedirectUri = (p: Platform) => `${p.env.PUBLIC_URL}/api/channels/gmail/callback`;

/** Starts (or restarts, for a reconnect) the Google OAuth flow for one mailbox. */
export async function startGmailConnect(p: Platform, tx: Tx, tenantId: string, actor: Principal, input: { name?: string | undefined; accountId?: string | undefined; sla_minutes?: number | undefined }, correlationId: string) {
  if (!p.ports.channel.gmail.configured()) throw new CommandError(409, 'gmail_not_configured', 'Gmail is not configured for this deployment (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)');
  let id = input.accountId;
  if (id) {
    const a = await tx.selectFrom('channel_account').select('id').where('id', '=', id).where('kind', '=', 'gmail').executeTakeFirst();
    if (!a) throw new CommandError(404, 'not_found', 'mailbox not found');
  } else {
    await assertRoom(p, tx);
    id = newId();
    const name = input.name ?? 'Gmail';
    await tx
      .insertInto('channel_account')
      .values({ id, tenant_id: tenantId, kind: 'gmail', name, status: 'pending', config: JSON.stringify({ sla_minutes: input.sla_minutes ?? 60 }), created_by: actor.id })
      .execute()
      .catch((e) => nameTaken(e, name));
    await recordChange(p, tx, { tenantId, actor, action: 'platform:channel.connect_started', resourceType: RESOURCE, resourceId: id, correlationId });
  }
  const body = `${tenantId}.${id}.${actor.id}.${Date.now() + STATE_TTL_MS}`;
  return { id, url: p.ports.channel.gmail.authorizationUrl({ redirectUri: gmailRedirectUri(p), state: `${body}.${signState(p, body)}` }) };
}

/** OAuth callback: stores the encrypted refresh token and starts polling from the mailbox's current history id. */
export async function finishGmailConnect(p: Platform, tenantId: string, actor: Principal, state: string, code: string, correlationId: string) {
  const parts = state.split('.');
  const mac = parts.pop() ?? '';
  const [stTenant, accountId, userId, exp] = parts;
  if (parts.length !== 4 || !safeEqual(mac, signState(p, parts.join('.'))) || stTenant !== tenantId || userId !== actor.id || Number(exp) < Date.now()) throw new CommandError(403, 'invalid_state', 'this Gmail connection link is invalid or has expired; start again');
  const tokens = await p.ports.channel.gmail.exchangeCode({ code, redirectUri: gmailRedirectUri(p) }).catch((e: Error) => {
    throw new CommandError(502, 'oauth_failed', e.message);
  });
  const profile = await p.ports.channel.gmail.profile(tokens.accessToken);
  await p.database.withTenant(tenantId, async (tx) => {
    const a = (await sql<ChannelRow>`SELECT * FROM channel_account WHERE id = ${accountId!} AND kind = 'gmail' FOR UPDATE`.execute(tx)).rows[0];
    if (!a) throw new CommandError(404, 'not_found', 'mailbox not found');
    if (a.config.email && a.config.email !== profile.emailAddress) throw new CommandError(409, 'different_mailbox', `reconnect with ${a.config.email}, the mailbox this channel was created for`);
    await tx
      .updateTable('channel_account')
      .set({ status: 'active', config: JSON.stringify({ ...a.config, email: profile.emailAddress }), secret_enc: seal(p, tenantId, a.id, { refresh_token: tokens.refreshToken }), cursor: JSON.stringify({ history_id: a.cursor.history_id ?? profile.historyId }), next_poll_at: new Date(), last_error: null, updated_at: new Date(), version: sql`version + 1` })
      .where('id', '=', a.id)
      .execute();
    await connected(p, tx, tenantId, actor, a.id, 'gmail', correlationId);
  });
  return { id: accountId! };
}

const parseFrom = (from: string) => {
  const m = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(from);
  const email = (m ? m[2]! : from).trim().toLowerCase();
  return { name: m?.[1]?.trim() || null, email: /^[^@\s]+@[^@\s]+$/.test(email) ? email : null };
};

async function needsReconnect(p: Platform, tenantId: string, accountId: string, kind: 'gmail' | 'telegram', reason: string) {
  await p.database.withTenant(tenantId, async (tx) => {
    const r = await tx.updateTable('channel_account').set({ status: 'needs_reconnect', last_error: reason, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', accountId).where('status', '=', 'active').returning('id').executeTakeFirst();
    if (r) await recordChange(p, tx, { tenantId, actor: { type: 'System', id: `channel:${kind}` }, action: 'platform:channel.needs_reconnect', resourceType: RESOURCE, resourceId: accountId, correlationId: `${kind}:${accountId}`, events: [{ type: 'channel.needs_reconnect', data: { account_id: accountId, kind } }] });
  });
  p.ports.realtime.publish(`inbox:${tenantId}`);
}

/** Marks a channel as needing a new connection (used by the sender when a send is refused for good). */
export const markNeedsReconnect = needsReconnect;

/**
 * Polls one mailbox through the History API. Messages are ingested idempotently (the
 * Gmail message id is the external id), so a repeated or overlapping poll is harmless.
 * An expired or revoked grant turns the channel into `needs_reconnect`.
 */
export async function pollGmail(p: Platform, tenantId: string, accountId: string): Promise<{ ingested: number; status: string }> {
  const account = (await p.database.withTenant(tenantId, (tx) => tx.selectFrom('channel_account').selectAll().where('id', '=', accountId).where('kind', '=', 'gmail').executeTakeFirst())) as ChannelRow | undefined;
  if (!account || account.status !== 'active') return { ingested: 0, status: account?.status ?? 'missing' };
  // A suspended or deleted workspace, or a plan without the package, takes no messages:
  // nothing is fetched or stored for it, and its cursor waits where it is.
  const open = await p.database.withTenant(tenantId, async (tx) => {
    const t = await tx.selectFrom('tenant').select('status').executeTakeFirst();
    return Boolean(t) && !['suspended', 'deleted'].includes(t!.status) && (await packageEnabled(p, tx, OMNICHANNEL_PACKAGE));
  });
  if (!open) return { ingested: 0, status: 'paused' };
  const refresh = openSecrets(p, account)?.refresh_token;
  if (!refresh) {
    await needsReconnect(p, tenantId, accountId, 'gmail', 'the stored Gmail grant cannot be read (was the vault key changed?); reconnect the mailbox');
    return { ingested: 0, status: 'needs_reconnect' };
  }
  const gmail = p.ports.channel.gmail;
  try {
    const token = await gmail.accessToken(refresh);
    let h = account.cursor.history_id ? await gmail.history(token, String(account.cursor.history_id)) : { messageIds: [] as string[], historyId: '', expired: true };
    if (h.expired) {
      // Cursor too old (or first poll): take the recent inbox once and restart from the current history id.
      const profile = await gmail.profile(token);
      h = { messageIds: await gmail.listRecent(token, 20), historyId: profile.historyId, expired: false };
    }
    let ingested = 0;
    let skipped = 0;
    const removeFiles = async (ids: string[]) => {
      for (const id of ids) await p.ports.files.remove(tenantId, id).catch((e: unknown) => p.log.warn({ err: String(e), account: accountId }, 'gmail: removing a stored attachment failed'));
    };
    for (const id of h.messageIds.slice(0, 100)) {
      // Already stored (a repeated poll, the first poll, an expired cursor): fetch nothing again.
      const known = await p.database.withTenant(tenantId, (tx) => tx.selectFrom('conv_message as m').innerJoin('conversation as c', 'c.id', 'm.conversation_id').select('m.id').where('c.account_id', '=', accountId).where('m.external_id', '=', id).executeTakeFirst());
      if (known) continue;
      const stored: string[] = [];
      try {
        const m = await gmail.getMessage(token, id);
        if (!m || m.labelIds.includes('SENT') || m.labelIds.includes('DRAFT')) continue;
        const from = parseFrom(m.from);
        if (!from.email || from.email === account.config.email) continue;
        const attachments: { file_id: string; name: string; size: number }[] = [];
        for (const att of m.attachments.slice(0, MAX_ATTACHMENTS)) {
          if (att.size > MAX_ATTACHMENT_BYTES) continue;
          try {
            const body = await gmail.attachment(token, m.id, att.attachmentId, MAX_ATTACHMENT_BYTES);
            const f = await p.ports.files.put(tenantId, { name: att.filename, contentType: att.mimeType, purpose: `conversation:gmail:${accountId}`, createdBy: 'channel:gmail' }, body, { maxBytes: MAX_ATTACHMENT_BYTES });
            stored.push(f.id);
            attachments.push({ file_id: f.id, name: att.filename, size: f.size });
          } catch (e) {
            if (e instanceof ReconnectRequired) throw e;
            p.log.warn({ err: String(e), account: accountId }, 'gmail: an attachment could not be stored');
          }
        }
        const r = await ingestMessage(p, tenantId, account, {
          threadKey: m.threadId,
          externalId: m.id,
          text: m.text || '(no text)',
          subject: m.subject.slice(0, 300),
          contact: { name: from.name, email: from.email },
          identities: [{ kind: 'email', value: from.email, verified: false }],
          meta: { message_id: m.messageId, references: m.references, ...(attachments.length ? { attachments } : {}) },
          correlationId: `gmail:${m.id}`,
        });
        if ('duplicate' in r) await removeFiles(stored);
        else ingested++;
      } catch (e) {
        // Nothing stored for a message that was not ingested.
        await removeFiles(stored);
        if (e instanceof ReconnectRequired) throw e;
        // The workspace stopped taking messages mid-poll: stop here, keep the cursor.
        if (e instanceof CommandError && [403, 410, 423].includes(e.status)) return { ingested, status: 'paused' };
        // A message that can never be read (too large, malformed), or one that failed on
        // five polls in a row, is skipped so it cannot hold the mailbox back for ever.
        const stuck = (account.cursor.stuck ?? null) as { id: string; n: number } | null;
        const hopeless = (e as Error).name === 'ResponseTooLarge' || e instanceof CommandError || (stuck?.id === id && stuck.n >= 4);
        if (!hopeless) {
          await p.database.withTenant(tenantId, (tx) => tx.updateTable('channel_account').set({ cursor: JSON.stringify({ ...account.cursor, stuck: { id, n: stuck?.id === id ? stuck.n + 1 : 1 } }) }).where('id', '=', accountId).execute());
          throw e;
        }
        skipped++;
        p.log.warn({ err: String(e), account: accountId }, 'gmail: a message could not be read and was skipped');
      }
    }
    await p.database.withTenant(tenantId, (tx) => tx.updateTable('channel_account').set({ cursor: JSON.stringify({ history_id: h.historyId }), last_error: skipped ? `${skipped} message(s) could not be read (too large or malformed) and were skipped` : null, updated_at: new Date() }).where('id', '=', accountId).execute());
    return { ingested, status: 'active' };
  } catch (e) {
    if (e instanceof ReconnectRequired) {
      await needsReconnect(p, tenantId, accountId, 'gmail', 'Gmail access expired or was revoked; reconnect the mailbox');
      return { ingested: 0, status: 'needs_reconnect' };
    }
    await p.database.withTenant(tenantId, (tx) => tx.updateTable('channel_account').set({ last_error: (e as Error).message.slice(0, 300), updated_at: new Date() }).where('id', '=', accountId).execute());
    throw e;
  }
}

/** Job: polls every mailbox that is due. The definer function claims them and schedules their next poll. */
export async function pollDueMailboxes(p: Platform, limit = 20) {
  const due = await p.database.withoutTenant((tx) => sql<{ tenant_id: string; id: string }>`SELECT tenant_id, id FROM channel_claim_polls(${limit}, ${p.env.GMAIL_POLL_SECONDS})`.execute(tx));
  for (const d of due.rows) await pollGmail(p, d.tenant_id, d.id).catch((e: unknown) => p.log.warn({ err: String(e), account: d.id }, 'gmail poll failed'));
  return due.rows.length;
}

// ------------------------------------------------------------------ manage

export async function updateChannel(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, patch: { name?: string | undefined; status?: 'active' | 'disabled' | undefined; widget?: Omit<WidgetInput, 'name'> | undefined; sla_minutes?: number | undefined }, correlationId: string) {
  const a = (await sql<ChannelRow>`SELECT * FROM channel_account WHERE id = ${id} FOR UPDATE`.execute(tx)).rows[0];
  if (!a) throw new CommandError(404, 'not_found', 'channel not found');
  const set: Record<string, unknown> = { updated_at: new Date(), version: sql`version + 1` };
  if (patch.name) set.name = patch.name;
  if (patch.status) {
    if (patch.status === 'active' && (a.status === 'pending' || a.status === 'needs_reconnect')) throw new CommandError(409, 'reconnect_required', 'connect the mailbox first');
    set.status = patch.status;
  }
  let config = a.config;
  if (patch.widget && a.kind === 'widget') config = { ...config, ...widgetConfig({ ...patch.widget, name: a.name }) };
  if (patch.sla_minutes) config = { ...config, sla_minutes: patch.sla_minutes };
  set.config = JSON.stringify(config);
  await tx.updateTable('channel_account').set(set).where('id', '=', id).execute().catch((e) => nameTaken(e, patch.name ?? a.name));
  await recordChange(p, tx, { tenantId, actor, action: 'platform:channel.updated', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: 'channel.updated', data: { account_id: id, kind: a.kind, status: patch.status ?? a.status } }] });
}

export async function rotateWidgetSecret(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, correlationId: string) {
  const a = await tx.selectFrom('channel_account').select(['id', 'kind']).where('id', '=', id).executeTakeFirst();
  if (!a || a.kind !== 'widget') throw new CommandError(404, 'not_found', 'widget not found');
  const identitySecret = randomBytes(32).toString('hex');
  await tx.updateTable('channel_account').set({ secret_enc: seal(p, tenantId, id, { identity_secret: identitySecret }), updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:channel.secret_rotated', resourceType: RESOURCE, resourceId: id, correlationId });
  return { identity_secret: identitySecret };
}

export async function deleteChannel(p: Platform, tenantId: string, actor: Principal, id: string, correlationId: string) {
  const a = (await p.database.withTenant(tenantId, (tx) => tx.selectFrom('channel_account').selectAll().where('id', '=', id).executeTakeFirst())) as ChannelRow | undefined;
  if (!a) throw new CommandError(404, 'not_found', 'channel not found');
  const token = a.kind === 'telegram' ? openSecrets(p, a)?.token : null;
  // Best effort: the bot stops calling us; a failure here must not keep the channel alive.
  if (token) await p.ports.channel.telegram.deleteWebhook(token).catch((e: unknown) => p.log.warn({ err: String(e), account: id }, 'telegram: deleteWebhook failed'));
  await p.database.withTenant(tenantId, async (tx) => {
    await tx.deleteFrom('channel_account').where('id', '=', id).where('tenant_id', '=', tenantId).execute();
    await recordChange(p, tx, { tenantId, actor, action: 'platform:channel.removed', resourceType: RESOURCE, resourceId: id, correlationId, events: [{ type: 'channel.removed', data: { account_id: id, kind: a.kind } }] });
  });
}
