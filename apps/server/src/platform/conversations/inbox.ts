import { action, authorize, backoffMs, CommandError, type Principal } from '@aod/shared';
import { sql } from 'kysely';
import { newId, type Tx } from '../../db/database.ts';
import type { ChannelSendResult, Consumer } from '../../ports/index.ts';
import { assertWritableTenant } from '../commands.ts';
import type { Platform } from '../context.ts';
import { hubOptions } from '../hub.ts';
import { linksFor } from '../links.ts';
import { OMNICHANNEL_PACKAGE, requirePackage } from '../packages.ts';
import { recordChange } from '../record.ts';
import { markNeedsReconnect, openSecrets, type ChannelRow } from './channels.ts';

/**
 * Inbox: conversations from every channel. Contacts are resolved by keyed hashes of
 * their identities (email, phone, Telegram user, widget visitor or verified site user);
 * email and phone are stored encrypted. Message text never enters event data: events
 * carry ids only.
 */

export const CONVERSATION = 'platform::Conversation';
const aadContact = (tenantId: string, contactId: string, field: string) => `contact:${tenantId}:${contactId}:${field}`;
const SYSTEM = (kind: string) => ({ type: 'System' as const, id: `channel:${kind}` });

export type IdentityKind = 'email' | 'phone' | 'telegram' | 'widget_visitor' | 'widget_user';
export interface Identity {
  kind: IdentityKind;
  value: string;
  verified: boolean;
}

const normalise = (kind: IdentityKind, value: string) => (kind === 'email' ? value.trim().toLowerCase() : kind === 'phone' ? value.replace(/[^\d+]/g, '') : value.trim());
const identityHash = (p: Platform, tenantId: string, i: Pick<Identity, 'kind' | 'value'>) => p.ports.vault.mac(`${i.kind}:${normalise(i.kind, i.value)}`, `contact:${tenantId}`);

export interface InboundMessage {
  threadKey: string;
  externalId: string;
  text: string;
  subject?: string | undefined;
  contact: { name?: string | null | undefined; email?: string | null | undefined; phone?: string | null | undefined };
  identities: Identity[];
  meta?: Record<string, unknown>;
  correlationId: string;
}

/** Finds the contact behind any of the identities (verified ones first), or creates one; learns new identities. */
async function resolveContact(p: Platform, tx: Tx, tenantId: string, m: InboundMessage): Promise<string> {
  const hashed = m.identities.map((i) => ({ ...i, hash: identityHash(p, tenantId, i) }));
  let contactId: string | null = null;
  for (const i of [...hashed].sort((a, b) => Number(b.verified) - Number(a.verified))) {
    const found = await tx.selectFrom('conv_identity').select('contact_id').where('kind', '=', i.kind).where('value_hash', '=', i.hash).executeTakeFirst();
    if (found) {
      contactId = found.contact_id;
      break;
    }
  }
  const enc = (id: string, field: 'email' | 'phone', v: string | null | undefined) => (v ? p.ports.vault.encrypt(normalise(field, v), aadContact(tenantId, id, field)) : null);
  if (!contactId) {
    contactId = newId();
    await tx.insertInto('conv_contact').values({ id: contactId, tenant_id: tenantId, name: m.contact.name?.slice(0, 120) ?? null, email_enc: enc(contactId, 'email', m.contact.email), phone_enc: enc(contactId, 'phone', m.contact.phone) }).execute();
  } else {
    const c = await tx.selectFrom('conv_contact').select(['name', 'email_enc', 'phone_enc']).where('id', '=', contactId).executeTakeFirstOrThrow();
    const patch: Record<string, unknown> = {};
    if (!c.name && m.contact.name) patch.name = m.contact.name.slice(0, 120);
    if (!c.email_enc && m.contact.email) patch.email_enc = enc(contactId, 'email', m.contact.email);
    if (!c.phone_enc && m.contact.phone) patch.phone_enc = enc(contactId, 'phone', m.contact.phone);
    if (Object.keys(patch).length) await tx.updateTable('conv_contact').set({ ...patch, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', contactId).execute();
  }
  for (const i of hashed) {
    await tx.insertInto('conv_identity').values({ tenant_id: tenantId, contact_id: contactId, kind: i.kind, value_hash: i.hash, verified: i.verified }).onConflict((oc) => oc.doNothing()).execute();
  }
  return contactId;
}

export function contactView(p: Platform, tenantId: string, c: { id: string; name: string | null; email_enc: string | null; phone_enc: string | null }) {
  const dec = (field: 'email' | 'phone', v: string | null) => {
    if (!v) return null;
    try {
      return p.ports.vault.decrypt(v, aadContact(tenantId, c.id, field));
    } catch {
      return null;
    }
  };
  return { id: c.id, name: c.name, email: dec('email', c.email_enc), phone: dec('phone', c.phone_enc) };
}

/** Email captured in the widget: encrypted on the contact, plus an unverified identity for matching. */
export async function setContactEmail(p: Platform, tx: Tx, tenantId: string, contactId: string, email: string, channel: string) {
  const value = normalise('email', email);
  await tx.updateTable('conv_contact').set({ email_enc: p.ports.vault.encrypt(value, aadContact(tenantId, contactId, 'email')), updated_at: new Date(), version: sql`version + 1` }).where('id', '=', contactId).execute();
  await tx.insertInto('conv_identity').values({ tenant_id: tenantId, contact_id: contactId, kind: 'email', value_hash: identityHash(p, tenantId, { kind: 'email', value }), verified: false }).onConflict((oc) => oc.doNothing()).execute();
  // The address itself stays out of the audit entry and of events.
  await recordChange(p, tx, { tenantId, actor: SYSTEM(channel), action: 'platform:conversation.contact_updated', resourceType: 'platform::Contact', resourceId: contactId, correlationId: `contact:${contactId}`, data: { fields: ['email'] } });
}

const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 140);

/** True while a published, active bot flow answers on this channel. */
export async function botServes(tx: Tx, channel: string): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM bot_flow f JOIN bot_flow_version v ON v.flow_id = f.id AND v.number = f.published_number
    WHERE f.status = 'active' AND ${channel} = ANY(v.channels)`.execute(tx);
  return (r.rows[0]?.n ?? 0) > 0;
}

/**
 * Stores one inbound customer message: contact, conversation and message in a single
 * transaction with its events. A message the channel delivers twice is stored once.
 */
export async function ingestMessage(p: Platform, tenantId: string, account: Pick<ChannelRow, 'id' | 'kind' | 'config'>, m: InboundMessage): Promise<{ conversationId: string; messageId: string; created: boolean } | { duplicate: true; conversationId: string }> {
  const out = await p.database.withTenant(tenantId, async (tx) => {
    // A suspended or deleted workspace, or a plan without the package, takes no new messages.
    await assertWritableTenant(tx);
    await requirePackage(p, tx, OMNICHANNEL_PACKAGE);
    const contactId = await resolveContact(p, tx, tenantId, m);
    const existing = (await sql<any>`SELECT * FROM conversation WHERE account_id = ${account.id} AND thread_key = ${m.threadKey} FOR UPDATE`.execute(tx)).rows[0];
    const bot = await botServes(tx, account.kind);
    const now = new Date();
    const slaMinutes = Number(account.config.sla_minutes ?? 15);
    const conversationId: string = existing?.id ?? newId();
    if (!existing) {
      await tx
        .insertInto('conversation')
        .values({ id: conversationId, tenant_id: tenantId, account_id: account.id, channel: account.kind, contact_id: contactId, thread_key: m.threadKey, subject: m.subject ?? null, status: bot ? 'bot' : 'open', sla_due_at: bot ? null : new Date(now.getTime() + slaMinutes * 60_000) })
        .execute();
    }
    const messageId = newId();
    const ins = await tx
      .insertInto('conv_message')
      .values({ id: messageId, tenant_id: tenantId, conversation_id: conversationId, direction: 'in', author_type: 'customer', author_id: contactId, body: m.text, external_id: m.externalId, meta: JSON.stringify(m.meta ?? {}), correlation_id: m.correlationId })
      .onConflict((oc) => oc.columns(['conversation_id', 'external_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!ins) return { duplicate: true as const, conversationId };
    if (existing) {
      // A resolved conversation reopens; a waiting customer (re)starts the response clock.
      const status = existing.status === 'resolved' ? (bot ? 'bot' : 'open') : existing.status === 'pending' ? 'open' : existing.status;
      await tx
        .updateTable('conversation')
        .set({ status, last_message_at: now, preview: preview(m.text), unread: sql`unread + 1`, sla_due_at: status === 'bot' ? null : (existing.sla_due_at ?? new Date(now.getTime() + slaMinutes * 60_000)), updated_at: now, version: sql`version + 1` })
        .where('id', '=', conversationId)
        .execute();
    } else {
      await tx.updateTable('conversation').set({ preview: preview(m.text), unread: 1 }).where('id', '=', conversationId).execute();
    }
    await tx.updateTable('channel_account').set({ last_inbound_at: now }).where('id', '=', account.id).execute();
    await recordChange(p, tx, {
      tenantId,
      actor: SYSTEM(account.kind),
      action: 'platform:conversation.message_received',
      resourceType: CONVERSATION,
      resourceId: conversationId,
      correlationId: m.correlationId,
      events: [...(existing ? [] : [{ type: 'conversation.created', data: { conversation_id: conversationId, channel: account.kind, account_id: account.id } }]), { type: 'conversation.message_received', data: { conversation_id: conversationId, message_id: messageId, channel: account.kind, account_id: account.id } }],
      data: { channel: account.kind },
    });
    return { conversationId, messageId, created: !existing };
  });
  p.ports.realtime.publish(`conversation:${out.conversationId}`);
  p.ports.realtime.publish(`inbox:${tenantId}`);
  p.ports.metrics.increment('aod_channel_messages_total', { channel: account.kind, direction: 'in' });
  return out;
}

export interface Reply {
  authorType: 'agent' | 'bot' | 'system';
  authorId: string | null;
  body: string;
  correlationId: string;
  actor: Pick<Principal, 'type' | 'id'>;
  meta?: Record<string, unknown>;
}

/**
 * Adds an outbound message. Widget messages are delivered by the visitor's event stream;
 * Telegram and Gmail messages are queued for the channel sender (attempts, backoff, dead letter).
 */
export async function queueReply(p: Platform, tx: Tx, tenantId: string, conversationId: string, r: Reply): Promise<string> {
  const c = (await sql<any>`SELECT id, channel, status, first_response_at FROM conversation WHERE id = ${conversationId} FOR UPDATE`.execute(tx)).rows[0];
  if (!c) throw new CommandError(404, 'not_found', 'conversation not found');
  const id = newId();
  const queued = c.channel !== 'widget';
  await tx
    .insertInto('conv_message')
    .values({ id, tenant_id: tenantId, conversation_id: conversationId, direction: 'out', author_type: r.authorType, author_id: r.authorId, body: r.body, meta: JSON.stringify(r.meta ?? {}), delivery: queued ? 'pending' : 'sent', next_attempt_at: queued ? new Date() : null, correlation_id: r.correlationId })
    .execute();
  const now = new Date();
  const human = r.authorType === 'agent';
  await tx
    .updateTable('conversation')
    .set({ last_message_at: now, preview: preview(r.body), updated_at: now, version: sql`version + 1`, ...(human ? { first_response_at: c.first_response_at ?? now, sla_due_at: null, unread: 0, status: c.status === 'bot' || c.status === 'open' ? 'pending' : c.status } : {}) })
    .where('id', '=', conversationId)
    .execute();
  await recordChange(p, tx, { tenantId, actor: r.actor, action: 'platform:conversation.message_sent', resourceType: CONVERSATION, resourceId: conversationId, correlationId: r.correlationId, events: [{ type: 'conversation.message_sent', data: { conversation_id: conversationId, message_id: id, channel: c.channel, author_type: r.authorType } }] });
  return id;
}

/** Tells open streams about a change once the caller's transaction has committed. */
export function notifyConversation(p: Platform, tenantId: string, conversationId: string) {
  p.ports.realtime.publish(`conversation:${conversationId}`);
  p.ports.realtime.publish(`inbox:${tenantId}`);
}

// ------------------------------------------------------------------ outbound sender

/**
 * Sends queued Telegram and Gmail messages. Same mechanics as the Hub deliverer (and its
 * settings): leased claims across tenants, exponential backoff with jitter, a dead letter
 * after HUB_MAX_ATTEMPTS, and a manual retry from the Inbox. Nothing is sent while a
 * database transaction is open.
 */
export class ChannelSender {
  private readonly p: Platform;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking: Promise<unknown> | null = null;
  private readonly loopFailed = (e: unknown) => this.p.log.error({ err: String(e) }, 'channel sender loop failed');

  constructor(p: Platform) {
    this.p = p;
  }

  start() {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      this.ticking = this.tick().catch((e) => this.p.log.error({ err: String(e) }, 'channel sender tick failed'));
      await this.ticking;
      this.ticking = null;
      if (this.running)
        this.timer = setTimeout(() => {
          loop().catch(this.loopFailed);
        }, this.p.env.CHANNEL_INTERVAL_MS);
    };
    loop().catch(this.loopFailed);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.ticking) await this.ticking;
  }

  async tick(limit = 20): Promise<number> {
    const claimed = (await sql<{ tenant_id: string; id: string }>`SELECT * FROM conv_claim_outbound(${limit}, 60)`.execute(this.p.database.db)).rows;
    await Promise.all(claimed.map((c) => this.process(c.tenant_id, c.id).catch((e) => this.p.log.error({ err: String(e), message: c.id }, 'channel send failed unexpectedly'))));
    return claimed.length;
  }

  async drain() {
    for (let i = 0; i < 100; i++) if ((await this.tick(50)) === 0) return;
  }

  private async process(tenantId: string, messageId: string) {
    const p = this.p;
    const o = hubOptions(p);
    const loaded = await p.database.withTenant(tenantId, async (tx) => {
      const m = await tx.selectFrom('conv_message').selectAll().where('id', '=', messageId).executeTakeFirst();
      if (!m || m.delivery !== 'sending') return null;
      const c = await tx.selectFrom('conversation').selectAll().where('id', '=', m.conversation_id).executeTakeFirstOrThrow();
      const account = (await tx.selectFrom('channel_account').selectAll().where('id', '=', c.account_id).executeTakeFirstOrThrow()) as unknown as ChannelRow;
      const lastIn = await tx.selectFrom('conv_message').select(['meta']).where('conversation_id', '=', c.id).where('direction', '=', 'in').orderBy('seq', 'desc').limit(1).executeTakeFirst();
      const contact = await tx.selectFrom('conv_contact').select(['id', 'name', 'email_enc', 'phone_enc']).where('id', '=', c.contact_id).executeTakeFirstOrThrow();
      return { m, c, account, lastIn: (lastIn?.meta ?? {}) as Record<string, any>, contact: contactView(p, tenantId, contact) };
    });
    if (!loaded) return;
    const { m, c, account, lastIn, contact } = loaded;

    let result: ChannelSendResult;
    const secrets = openSecrets(p, account);
    if (account.status === 'disabled' || account.status === 'pending') result = { ok: false, error: `the channel is ${account.status}`, retryable: false };
    else if (account.status === 'needs_reconnect') result = { ok: false, error: 'the channel must be reconnected before messages can be sent', retryable: false };
    // Unreadable secrets cannot heal by retrying: dead-letter at once with a clear reason.
    else if (!secrets) result = { ok: false, error: 'the stored channel credentials cannot be decrypted (was the vault key changed?); reconnect the channel', retryable: false };
    else {
      try {
        if (account.kind === 'telegram') result = await p.ports.channel.telegram.sendMessage(secrets.token!, c.thread_key, m.body, typeof lastIn.telegram_message_id === 'number' ? lastIn.telegram_message_id : undefined);
        else if (account.kind === 'gmail') {
          if (!contact.email) result = { ok: false, error: 'the contact has no email address', retryable: false };
          else {
            const token = await p.ports.channel.gmail.accessToken(secrets.refresh_token!);
            const subject = c.subject ? (/^re:/i.test(c.subject) ? c.subject : `Re: ${c.subject}`) : 'Your conversation with us';
            result = await p.ports.channel.gmail.send(token, { from: account.config.email, to: contact.email, subject, text: m.body, threadId: c.thread_key, ...(lastIn.message_id ? { inReplyTo: lastIn.message_id, references: [lastIn.references, lastIn.message_id].filter(Boolean).join(' ') } : {}) });
          }
        } else result = { ok: true };
      } catch (e) {
        const reconnect = (e as Error).name === 'ReconnectRequired';
        result = { ok: false, error: (e as Error).message.slice(0, 300), retryable: !reconnect, reconnect };
      }
    }
    p.ports.metrics.increment('aod_channel_messages_total', { channel: account.kind, direction: 'out', ok: String(result.ok) });
    if (result.reconnect) await markNeedsReconnect(p, tenantId, account.id, result.error ?? 'reconnect the channel');

    await p.database.withTenant(tenantId, async (tx) => {
      const attempts = m.attempts + 1;
      if (result.ok) {
        await tx.updateTable('conv_message').set({ delivery: 'sent', attempts, delivery_error: null, lease_until: null, ...(result.externalId ? { meta: JSON.stringify({ ...(m.meta as object), sent_id: result.externalId }) } : {}) }).where('id', '=', m.id).execute();
        return;
      }
      const dead = result.retryable === false || attempts >= o.maxAttempts;
      await tx.updateTable('conv_message').set({ delivery: dead ? 'dead' : 'pending', attempts, delivery_error: result.error ?? 'failed', next_attempt_at: new Date(Date.now() + backoffMs(attempts - 1, { baseMs: o.backoffBaseMs })), lease_until: null }).where('id', '=', m.id).execute();
      if (dead) {
        await recordChange(p, tx, { tenantId, actor: SYSTEM(account.kind), action: 'platform:conversation.message_dead', resourceType: CONVERSATION, resourceId: c.id, correlationId: m.correlation_id ?? `message:${m.id}`, events: [{ type: 'conversation.message_dead', data: { conversation_id: c.id, message_id: m.id, channel: account.kind, attempts } }], data: { error: result.error } });
      }
    });
    notifyConversation(p, tenantId, c.id);
  }
}

/** Puts a dead-lettered message back in the queue (Inbox "Retry"). */
export async function retryMessage(p: Platform, tx: Tx, tenantId: string, actor: Principal, messageId: string, correlationId: string) {
  const m = await tx.updateTable('conv_message').set({ delivery: 'pending', attempts: 0, next_attempt_at: new Date(), delivery_error: null }).where('id', '=', messageId).where('delivery', '=', 'dead').returning(['id', 'conversation_id']).executeTakeFirst();
  if (!m) throw new CommandError(409, 'not_dead', 'only messages that failed for good can be retried');
  await recordChange(p, tx, { tenantId, actor, action: 'platform:conversation.message_retried', resourceType: CONVERSATION, resourceId: m.conversation_id, correlationId, data: { message_id: m.id } });
  return m.conversation_id as string;
}

// ------------------------------------------------------------------ inbox operations

const sla = (c: { sla_due_at?: Date | null }) => (c.sla_due_at ? { due_at: c.sla_due_at, breached: new Date(c.sla_due_at) < new Date() } : null);

export async function listConversations(p: Platform, tx: Tx, tenantId: string, q: { status?: string | undefined; assignee?: string | undefined; channel?: string | undefined; q?: string | undefined }) {
  let qb = tx
    .selectFrom('conversation as c')
    .innerJoin('conv_contact as k', 'k.id', 'c.contact_id')
    .innerJoin('channel_account as a', 'a.id', 'c.account_id')
    .leftJoin('app_user as u', 'u.id', 'c.assignee_id')
    .select(['c.id', 'c.channel', 'c.status', 'c.subject', 'c.preview', 'c.unread', 'c.assignee_id', 'c.sla_due_at', 'c.last_message_at', 'c.version', 'k.name as contact_name', 'a.name as account_name', 'u.name as assignee_name'])
    .orderBy('c.last_message_at', 'desc')
    .limit(100);
  if (q.status && q.status !== 'all') qb = q.status === 'active' ? qb.where('c.status', '<>', 'resolved') : qb.where('c.status', '=', q.status);
  if (q.assignee === 'unassigned') qb = qb.where('c.assignee_id', 'is', null);
  else if (q.assignee) qb = qb.where('c.assignee_id', '=', q.assignee);
  if (q.channel) qb = qb.where('c.channel', '=', q.channel);
  if (q.q?.trim()) {
    const like = `%${q.q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    qb = qb.where((eb) => eb.or([eb('c.preview', 'ilike', like), eb('c.subject', 'ilike', like), eb('k.name', 'ilike', like)]));
  }
  const rows = await qb.execute();
  const counts = await tx.selectFrom('conversation').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute();
  return { conversations: rows.map((r) => ({ ...r, contact_name: r.contact_name ?? 'Visitor', sla: sla(r) })), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
}

export async function getConversation(p: Platform, tx: Tx, tenantId: string, principal: Principal, id: string) {
  const c = await tx.selectFrom('conversation').selectAll().where('id', '=', id).executeTakeFirst();
  if (!c) throw new CommandError(404, 'not_found', 'conversation not found');
  const contact = await tx.selectFrom('conv_contact').select(['id', 'name', 'email_enc', 'phone_enc']).where('id', '=', c.contact_id).executeTakeFirstOrThrow();
  const identities = await tx.selectFrom('conv_identity').select(['kind', 'verified']).where('contact_id', '=', c.contact_id).execute();
  const account = await tx.selectFrom('channel_account').select(['id', 'name', 'kind', 'status']).where('id', '=', c.account_id).executeTakeFirstOrThrow();
  const messages = await tx.selectFrom('conv_message as m').leftJoin('app_user as u', (j) => j.on(sql<boolean>`u.id::text = m.author_id AND m.author_type = 'agent'`)).select(['m.id', 'm.seq', 'm.direction', 'm.author_type', 'm.body', 'm.meta', 'm.delivery', 'm.delivery_error', 'm.attempts', 'm.created_at', 'u.name as author_name']).where('m.conversation_id', '=', id).orderBy('m.seq', 'desc').limit(200).execute();
  const assignee = c.assignee_id ? await tx.selectFrom('app_user').select(['id', 'name']).where('id', '=', c.assignee_id).executeTakeFirst() : null;
  // Linked records (orders, shipments, …) through the link index; unreadable ones are only counted.
  const links = await linksFor(p, tx, principal, CONVERSATION, id);
  const related: typeof links.links = [];
  for (const l of links.links.slice(0, 5)) for (const x of (await linksFor(p, tx, principal, l.type, l.id)).links) if (x.type !== CONVERSATION && !links.links.some((y) => y.id === x.id)) related.push(x);
  const other = await tx.selectFrom('conversation').select(['id', 'channel', 'status', 'last_message_at']).where('contact_id', '=', c.contact_id).where('id', '<>', id).orderBy('last_message_at', 'desc').limit(5).execute();
  return {
    conversation: { id: c.id, channel: c.channel, status: c.status, subject: c.subject, assignee, sla: sla(c), first_response_at: c.first_response_at, unread: c.unread, version: c.version, created_at: c.created_at, bot_active: c.status === 'bot' },
    account,
    contact: { ...contactView(p, tenantId, contact), identities: identities.map((i) => ({ kind: i.kind, verified: i.verified })) },
    messages: messages.reverse().map((m) => ({ id: m.id, seq: m.seq, direction: m.direction, author_type: m.author_type, author_name: m.author_name, body: m.body, attachments: ((m.meta as any)?.attachments ?? []) as { file_id: string; name: string; size: number }[], delivery: m.delivery, delivery_error: m.delivery_error, attempts: m.attempts, created_at: m.created_at })),
    links: links.links,
    related: related.slice(0, 20),
    hidden_links: links.hidden,
    other_conversations: other,
  };
}

const changed = (p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, what: string, data: Record<string, unknown>, correlationId: string) =>
  recordChange(p, tx, { tenantId, actor, action: `platform:conversation.${what}`, resourceType: CONVERSATION, resourceId: id, correlationId, events: [{ type: `conversation.${what}`, data: { conversation_id: id, ...data } }] });

async function lockConversation(tx: Tx, id: string, expectedVersion?: number) {
  const c = (await sql<any>`SELECT * FROM conversation WHERE id = ${id} FOR UPDATE`.execute(tx)).rows[0];
  if (!c) throw new CommandError(404, 'not_found', 'conversation not found');
  if (expectedVersion !== undefined && c.version !== expectedVersion) throw new CommandError(409, 'version_conflict', `the conversation changed (expected version ${expectedVersion}, current ${c.version})`);
  return c;
}

export async function assignConversation(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, assigneeId: string | null, expectedVersion: number | undefined, correlationId: string) {
  await lockConversation(tx, id, expectedVersion);
  if (assigneeId) {
    const u = await tx.selectFrom('app_user').select('id').where('id', '=', assigneeId).where('status', '=', 'active').executeTakeFirst();
    if (!u) throw new CommandError(422, 'unknown_user', 'that user cannot be assigned');
    // Assigning someone else is a manager's call.
    if (assigneeId !== actor.id && authorize(actor, action('platform:inbox.manage'), { type: 'platform::Tenant', id: tenantId, tenantId }).decision === 'deny') throw new CommandError(403, 'forbidden', 'missing permission platform:inbox.manage');
  }
  await tx.updateTable('conversation').set({ assignee_id: assigneeId, updated_at: new Date(), version: sql`version + 1` }).where('id', '=', id).execute();
  await changed(p, tx, tenantId, actor, id, 'assigned', { assignee_id: assigneeId }, correlationId);
}

export async function setConversationStatus(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, status: 'open' | 'pending' | 'resolved', expectedVersion: number | undefined, correlationId: string) {
  const c = await lockConversation(tx, id, expectedVersion);
  if (c.status === status) return;
  const slaMinutes = Number((await tx.selectFrom('channel_account').select('config').where('id', '=', c.account_id).executeTakeFirst())?.config?.sla_minutes ?? 15);
  await tx
    .updateTable('conversation')
    .set({ status, bot: status === 'open' && c.status === 'bot' ? null : c.bot, sla_due_at: status === 'open' ? (c.sla_due_at ?? new Date(Date.now() + slaMinutes * 60_000)) : null, unread: status === 'resolved' ? 0 : c.unread, updated_at: new Date(), version: sql`version + 1` })
    .where('id', '=', id)
    .execute();
  await changed(p, tx, tenantId, actor, id, 'status_changed', { from: c.status, to: status }, correlationId);
}

/** Hands a bot conversation to people: it shows in the Inbox as open and the response clock starts. */
export async function handOff(p: Platform, tx: Tx, tenantId: string, conversationId: string, reason: string, correlationId: string) {
  const c = await lockConversation(tx, conversationId);
  if (c.status !== 'bot') return false;
  const slaMinutes = Number((await tx.selectFrom('channel_account').select('config').where('id', '=', c.account_id).executeTakeFirst())?.config?.sla_minutes ?? 15);
  await tx.updateTable('conversation').set({ status: 'open', bot: null, sla_due_at: new Date(Date.now() + slaMinutes * 60_000), updated_at: new Date(), version: sql`version + 1` }).where('id', '=', conversationId).execute();
  await recordChange(p, tx, { tenantId, actor: { type: 'System', id: 'bot' }, action: 'platform:conversation.handed_off', resourceType: CONVERSATION, resourceId: conversationId, correlationId, events: [{ type: 'conversation.handed_off', data: { conversation_id: conversationId, reason } }] });
  return true;
}

export async function addNote(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, body: string, correlationId: string) {
  await lockConversation(tx, id);
  const noteId = newId();
  await tx.insertInto('conv_message').values({ id: noteId, tenant_id: tenantId, conversation_id: id, direction: 'note', author_type: 'agent', author_id: actor.id, body, correlation_id: correlationId }).execute();
  await tx.updateTable('conversation').set({ updated_at: new Date() }).where('id', '=', id).execute();
  await recordChange(p, tx, { tenantId, actor, action: 'platform:conversation.note_added', resourceType: CONVERSATION, resourceId: id, correlationId, data: { message_id: noteId } });
  return noteId;
}

export async function markRead(tx: Tx, id: string) {
  await tx.updateTable('conversation').set({ unread: 0 }).where('id', '=', id).where('unread', '>', 0).execute();
}

/** Links a conversation to a record (e.g. the order it is about) in the link index. */
export async function linkRecord(p: Platform, tx: Tx, tenantId: string, actor: Pick<Principal, 'type' | 'id'>, conversationId: string, target: { type: string; id: string }, correlationId: string, audit = true) {
  const ins = await tx
    .insertInto('record_link')
    .values({ tenant_id: tenantId, from_type: CONVERSATION, from_id: conversationId, rel: 'about', to_type: target.type, to_id: target.id, source_event: null })
    .onConflict((oc) => oc.doNothing())
    .returning('to_id')
    .executeTakeFirst();
  if (ins && audit) await recordChange(p, tx, { tenantId, actor, action: 'platform:conversation.linked', resourceType: CONVERSATION, resourceId: conversationId, correlationId, data: { to_type: target.type, to_id: target.id } });
  return Boolean(ins);
}

// ------------------------------------------------------------------ canned replies

export const listCanned = (tx: Tx) => tx.selectFrom('conv_canned_reply').select(['id', 'title', 'body']).orderBy('title').limit(200).execute();

export async function saveCanned(p: Platform, tx: Tx, tenantId: string, actor: Principal, input: { title: string; body: string }, correlationId: string) {
  const id = newId();
  await tx
    .insertInto('conv_canned_reply')
    .values({ id, tenant_id: tenantId, title: input.title, body: input.body, created_by: actor.id })
    .execute()
    .catch((e) => {
      if (e?.code === '23505') throw new CommandError(409, 'name_taken', `a canned reply named ${input.title} exists`);
      throw e;
    });
  await recordChange(p, tx, { tenantId, actor, action: 'platform:inbox.canned_reply_saved', resourceType: 'platform::CannedReply', resourceId: id, correlationId });
  return { id };
}

export async function deleteCanned(p: Platform, tx: Tx, tenantId: string, actor: Principal, id: string, correlationId: string) {
  const r = await tx.deleteFrom('conv_canned_reply').where('id', '=', id).where('tenant_id', '=', tenantId).returning('id').executeTakeFirst();
  if (!r) throw new CommandError(404, 'not_found', 'canned reply not found');
  await recordChange(p, tx, { tenantId, actor, action: 'platform:inbox.canned_reply_deleted', resourceType: 'platform::CannedReply', resourceId: id, correlationId });
}

// ------------------------------------------------------------------ consumers

/** Wakes open event streams when a conversation changes (the message itself is already committed). */
export function realtimeConsumer(p: Platform): Consumer {
  return {
    name: 'platform.conversation_realtime',
    types: ['conversation.message_received', 'conversation.message_sent', 'conversation.handed_off', 'conversation.assigned', 'conversation.status_changed', 'conversation.created'],
    async handle(event) {
      p.ports.realtime.publish(`conversation:${String(event.data.conversation_id)}`);
      p.ports.realtime.publish(`inbox:${event.tenant_id}`);
    },
  };
}

/**
 * Keeps customers posted: when a record a conversation is linked to changes status (an
 * order is cancelled, a shipment moves), an update is posted to that conversation. The
 * event types come from the manifests (events of linked entities that carry a status).
 */
export function linkedUpdatesConsumer(p: Platform): Consumer {
  const watched = new Map<string, { resource: string; label: string; idPath: string }>();
  for (const m of p.catalog.manifests()) {
    for (const e of m.entities) {
      for (const type of e.events.filter((t) => /\.(cancelled|status_changed|delivered|completed|refunded)$/.test(t))) {
        const pub = m.events.publishes.find((x) => x.type === type);
        const idField = pub?.data.find((d) => d === `${e.name}_id`);
        if (idField) watched.set(`${m.id}:${type}`, { resource: e.resource, label: e.label, idPath: idField });
      }
    }
  }
  return {
    name: 'platform.conversation_updates',
    types: [...new Set([...watched.keys()].map((k) => k.split(':')[1]!))],
    async handle(event, tx) {
      const w = watched.get(`${event.app}:${event.type}`);
      const recordId = w ? event.data[w.idPath] : null;
      if (!w || typeof recordId !== 'string') return;
      const links = await tx.selectFrom('record_link').select('from_id').where('from_type', '=', CONVERSATION).where('to_type', '=', w.resource).where('to_id', '=', recordId).limit(20).execute();
      if (!links.length) return;
      // `cancelled` also emits a status change: announce the specific event only.
      if (event.type.endsWith('.status_changed') && event.data.to === 'cancelled') return;
      const number = event.data.number ?? '';
      const what = event.type.endsWith('.status_changed') ? `is now ${String(event.data.to ?? 'updated')}` : `has been ${event.type.split('.')[1]!.replace(/_/g, ' ')}`;
      for (const l of links) {
        const c = await tx.selectFrom('conversation').select(['id', 'status']).where('id', '=', l.from_id).executeTakeFirst();
        if (!c || c.status === 'resolved') continue;
        // Idempotent under redelivery and backfills: one update per (conversation, event).
        const dup = await tx.selectFrom('conv_message').select('id').where('conversation_id', '=', c.id).where('external_id', '=', `event:${event.id}`).executeTakeFirst();
        if (dup) continue;
        const id = await queueReply(p, tx, event.tenant_id, c.id, { authorType: 'system', authorId: null, body: `Update: ${w.label.toLowerCase()} ${number} ${what}.`.replace(/\s+/g, ' '), correlationId: event.correlation_id, actor: { type: 'System', id: 'conversation-updates' } });
        await tx.updateTable('conv_message').set({ external_id: `event:${event.id}` }).where('id', '=', id).execute();
      }
    },
  };
}
