/**
 * Ports. Every piece of infrastructure the full platform would run as a separate
 * system (Kafka, OpenSearch, ClickHouse, Temporal, Keycloak, Svix, Redis, S3, ...)
 * is an interface here with exactly one prototype adapter backed by PostgreSQL or
 * an in-process module. Swapping an adapter must not touch call sites.
 */
import type { EventEnvelope } from '@aod/shared';
import type { Readable } from 'node:stream';
import type { RawBuilder, Transaction } from 'kysely';

/** Kafka later; the outbox + event_log tables now. Publishing happens through the outbox only. */
export interface EventBus {
  subscribe(consumer: Consumer): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Relay + deliver until the log is drained (tests, seed). */
  drain(): Promise<void>;
  isLeader(): boolean;
}
export interface Consumer {
  /** unique, stable name: its cursor and dedup key */
  name: string;
  /** event types, or `*` for every event */
  types: string[];
  /**
   * Runs in the same transaction (scoped to the event's tenant) that records the
   * event as processed and advances the cursor, so effects happen exactly once.
   * Throwing rolls back and retries the event later. Returning 'skipped' (e.g. the
   * capability is not active for this tenant) leaves the event unprocessed so a later
   * backfill can still apply it.
   */
  handle(event: EventEnvelope, tx: Transaction<any>): Promise<void | 'skipped'>;
}

/** OpenSearch later; tsvector/GIN now. */
export interface Search {
  /** A boolean SQL predicate matching `column` against a user query. */
  match(column: string, query: string): RawBuilder<boolean>;
}

/** ClickHouse/Prometheus later; OpenTelemetry metrics API + in-memory snapshot now. */
export interface Metrics {
  increment(name: string, attrs?: Record<string, string>, by?: number): void;
  observe(name: string, value: number, attrs?: Record<string, string>): void;
  snapshot(): Record<string, number>;
}

/** Temporal/queues later; pg-boss now. */
export interface Jobs {
  send(queue: string, data: object, opts?: { singletonKey?: string; startAfter?: number | Date; retryLimit?: number }): Promise<string | null>;
  work<T extends object>(queue: string, handler: (data: T, job: { id: string; retryCount: number }) => Promise<void>): Promise<void>;
  schedule(queue: string, cron: string, data?: object): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Outbound deliveries (Svix later). One method per message; the adapter picks the
 * transport from `target.kind` (webhook, REST push, Kafka, Redis Streams, SFTP, SQS)
 * and enforces the private-address (SSRF) policy on every connection it makes.
 */
export interface Webhooks {
  /** Validates a target before it is saved (URL/host policy, required credentials). */
  checkTarget(target: DeliveryTarget): Promise<void>;
  deliver(target: DeliveryTarget, msg: OutboundMessage): Promise<DeliveryResult>;
}
export interface DeliveryTarget {
  kind: 'webhook' | 'rest_push' | 'kafka' | 'redis_stream' | 'sftp' | 'sqs' | 'http';
  config: Record<string, any>;
  credentials: Record<string, any> | null;
  /** webhook signing secret (Standard Webhooks, `whsec_...`) */
  signingSecret?: string | null;
}
export interface OutboundMessage {
  /** event id: stays the same across retries and replays */
  id: string;
  type: string;
  timestamp: Date;
  /** JSON body */
  body: string;
}
export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
  /** first 2 KB of the response body */
  response?: string;
  durationMs: number;
}

/**
 * Messaging channels. `send` notifies staff (demo mode shows the message on screen);
 * `telegram` and `gmail` are API clients for customer conversations (Milestone E). Both go
 * through the outbound policy (SSRF check, timeouts, capped responses) and are tested
 * against mock servers only until live checks are approved (plan decision 6).
 */
export interface Channel {
  send(msg: { tenantId: string; to: string; subject: string; body: string; link?: string }): Promise<{ via: string; preview?: { subject: string; link?: string } }>;
  telegram: TelegramTransport;
  gmail: GmailTransport;
}

/** Result of one outbound send. `retryable: false` dead-letters at once; `reconnect` asks the tenant to connect again. */
export interface ChannelSendResult {
  ok: boolean;
  externalId?: string;
  /** channel thread the message landed in (Gmail thread id) */
  threadId?: string;
  error?: string;
  retryable?: boolean;
  reconnect?: boolean;
}

/** Telegram Bot API. */
export interface TelegramTransport {
  getMe(token: string): Promise<{ id: number; username: string }>;
  setWebhook(token: string, url: string, secretToken: string): Promise<void>;
  deleteWebhook(token: string): Promise<void>;
  sendMessage(token: string, chatId: string, text: string, replyToMessageId?: number): Promise<ChannelSendResult>;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  historyId: string;
  labelIds: string[];
  from: string;
  to: string;
  subject: string;
  /** RFC 5322 Message-ID and References headers (threading) */
  messageId: string;
  references: string;
  text: string;
  attachments: { attachmentId: string; filename: string; mimeType: string; size: number }[];
}

/** The mailbox must be connected again (revoked access, or a Testing-mode refresh token past its 7 days). */
export class ReconnectRequired extends Error {
  constructor(message = 'Gmail access expired or was revoked; reconnect the mailbox') {
    super(message);
    this.name = 'ReconnectRequired';
  }
}

/** Gmail API + Google OAuth (offline access). The OAuth client belongs to the deployment (plan decision 8). */
export interface GmailTransport {
  configured(): boolean;
  authorizationUrl(p: { redirectUri: string; state: string }): string;
  exchangeCode(p: { code: string; redirectUri: string }): Promise<{ refreshToken: string; accessToken: string }>;
  /** Throws ReconnectRequired on `invalid_grant`. */
  accessToken(refreshToken: string): Promise<string>;
  profile(accessToken: string): Promise<{ emailAddress: string; historyId: string }>;
  /** Message ids added to the inbox since `startHistoryId`; `expired` when the cursor is too old. */
  history(accessToken: string, startHistoryId: string): Promise<{ messageIds: string[]; historyId: string; expired: boolean }>;
  /** Recent inbox message ids (used once after connecting or when the history cursor expired). */
  listRecent(accessToken: string, max: number): Promise<string[]>;
  getMessage(accessToken: string, id: string): Promise<GmailMessage | null>;
  /** Streams an attachment's bytes, capped at `maxBytes`. */
  attachment(accessToken: string, messageId: string, attachmentId: string, maxBytes: number): Promise<AsyncIterable<Uint8Array>>;
  send(accessToken: string, msg: { from: string; to: string; subject: string; text: string; threadId?: string; inReplyTo?: string; references?: string }): Promise<ChannelSendResult>;
}

/**
 * Plain HTTPS API calls to platform-configured services (Telegram, Google, Voyage) under
 * the same outbound policy as Hub deliveries. Never used for tenant-supplied URLs.
 */
export interface OutboundHttp {
  json(req: { url: string; method?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; maxBytes?: number }): Promise<{ status: number; ok: boolean; body: any; retryAfterMs: number | null }>;
  /** A capped byte stream of the response body. */
  stream(req: { url: string; headers?: Record<string, string>; maxBytes: number }): Promise<{ status: number; ok: boolean; body: AsyncIterable<Uint8Array> }>;
}

/** Fixed-window request limits (a token bucket in PostgreSQL in Milestone F); in-process and bounded now. */
export interface RateLimit {
  /** True if the call is allowed; counts it. */
  take(key: string, limit: number, windowMs: number): boolean;
}

/** In-process fan-out of "something changed" signals to open SSE streams (Redis pub/sub later). */
export interface Realtime {
  publish(topic: string): void;
  /**
   * Resolves true when one of `topics` was published since this `cursor` last saw it,
   * false after `timeoutMs` or when `signal` aborts. The cursor (one per stream) makes a
   * publish between two waits impossible to miss.
   */
  wait(topics: string[], timeoutMs: number, signal: AbortSignal, cursor: Map<string, number>): Promise<boolean>;
}

/** Keycloak later; in-process OIDC (openid-client) and SAML (node-saml) now. */
export interface Auth {
  oidcAuthorizationUrl(cfg: OidcSettings, p: { redirectUri: string; state: string; nonce: string; codeVerifier: string }): Promise<string>;
  oidcCallback(cfg: OidcSettings, p: { currentUrl: string; state: string; nonce: string; codeVerifier: string }): Promise<{ email: string; subject: string }>;
  samlAuthorizationUrl(cfg: SamlSettings, p: { callbackUrl: string; relayState: string }): Promise<string>;
  samlCallback(cfg: SamlSettings, p: { callbackUrl: string; body: Record<string, string> }): Promise<{ email: string; subject: string; relayState?: string }>;
}
export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret?: string;
}
export interface SamlSettings {
  entryPoint: string;
  idpIssuer: string;
  idpCert: string;
  spIssuer: string;
}

/** HashiCorp Vault/KMS later; AES-256-GCM with a process key now. */
export interface Vault {
  encrypt(plaintext: string, aad: string): string;
  decrypt(ciphertext: string, aad: string): string;
  /** HMAC-SHA256 (base64url) under a key derived for `purpose`; for signed URLs. */
  mac(data: string, purpose: string): string;
}

/** S3 later. Not used before Milestone B. */
export interface FileMeta {
  name: string;
  contentType: string;
  /** what created it, e.g. `report:<id>` */
  purpose: string;
  createdBy: string;
  expiresAt?: Date | null;
}

/**
 * Object storage (S3 later). Bodies are streamed both ways and never held whole in memory
 * (memory-safe-code §1). Files belong to a tenant; reads are tenant-scoped.
 */
export interface Files {
  /** Streams `body` into storage; rejects (and stores nothing) past `maxBytes`. */
  put(tenantId: string, meta: FileMeta, body: AsyncIterable<Uint8Array | string>, opts: { maxBytes: number }): Promise<{ id: string; size: number; sha256: string }>;
  /** A stream of the file, or null if it does not exist (or is not ready). */
  open(tenantId: string, id: string): Promise<{ stream: Readable; name: string; contentType: string; size: number } | null>;
  remove(tenantId: string, id: string): Promise<void>;
  /** A signed, expiring download token for one file. */
  signToken(tenantId: string, id: string, ttlSeconds: number): string;
  /** Checks a token: the file it grants, or null if forged or expired. */
  verifyToken(token: string): { tenantId: string; fileId: string } | null;
}

/** A point added to a metric's hourly bucket. */
export interface MetricPoint {
  tenantId: string;
  metric: string;
  at: Date;
  store: string;
  channel: string;
  value: number;
  count: number;
}

/**
 * Analytics store (ClickHouse later; PostgreSQL buckets now). Every call runs inside the
 * caller's tenant transaction.
 */
export interface Analytics {
  add(tx: Transaction<any>, points: MetricPoint[]): Promise<void>;
  reset(tx: Transaction<any>, metric: string): Promise<void>;
  query(
    tx: Transaction<any>,
    q: { metric: string; from: Date; to: Date; granularity: 'hour' | 'day' | 'week' | 'month' | null; groupBy: 'store' | 'channel' | null; filters: { store?: string[]; channel?: string[] }; limit?: number },
  ): Promise<{ bucket: string | null; key: string | null; value: number; count: number }[]>;
  total(tx: Transaction<any>, metric: string): Promise<{ value: number; count: number }>;
}

/** OpenTelemetry. */
export interface Telemetry {
  span<T>(name: string, attrs: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T>;
  /** W3C traceparent of the active span, if any */
  traceparent(): string | null;
}

/** Provider-neutral content blocks. `opaque` blocks (e.g. thinking) are replayed to the provider unchanged. */
export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'opaque'; raw: unknown };
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmBlock[];
}
export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema of the tool input */
  inputSchema: Record<string, unknown>;
}
export interface LlmChatResult {
  content: LlmBlock[];
  /** `refusal` and `max_tokens` turns must never have their tool calls executed */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

/** Claude API (model id from CLAUDE_MODEL). `chat` streams text and supports tool use. */
export interface Llm {
  complete(p: { system?: string; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens?: number }): Promise<{ text: string; model: string }>;
  chat(p: { system: string; messages: LlmMessage[]; tools?: LlmTool[]; maxTokens?: number; onText?: (delta: string) => void; signal?: AbortSignal }): Promise<LlmChatResult>;
}

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  title: string;
  kind: 'document' | 'help' | 'record';
  /** set for record chunks: the record the chunk describes */
  ref: { type: string; id: string } | null;
  text: string;
  score: number;
}

/** Text embeddings (Voyage AI; a deterministic fake in CI and local runs). */
export interface Embeddings {
  model: string;
  dimension: number;
  embed(texts: string[], inputType: 'document' | 'query'): Promise<{ vectors: number[][]; tokens: number }>;
}

/**
 * Knowledge retrieval: pgvector cosine similarity fused with PostgreSQL full-text ranking
 * (reciprocal-rank fusion) over `doc_chunk`. Every call is scoped to one tenant.
 */
export interface Retriever {
  /** (Re)chunks and embeds one source. Chunks are searchable by text before their embeddings arrive. */
  index(tenantId: string, sourceId: string, text: string): Promise<{ chunks: number; embedded: number; tokens: number }>;
  /** Embeds chunks still missing an embedding (backfill after an embeddings outage or model change). */
  embedPending(tenantId: string, sourceId: string): Promise<{ embedded: number; remaining: number; tokens: number }>;
  retrieve(tenantId: string, query: string, k: number, opts?: { kinds?: RetrievedChunk['kind'][]; publicOnly?: boolean }): Promise<{ hits: RetrievedChunk[]; tokens: number }>;
}

/** isolated-vm sandbox for custom connector code steps (Milestone B). */
export interface Sandbox {
  run(code: string, input: unknown, limits: { timeoutMs: number; memoryMb: number }): Promise<unknown>;
}

export interface PlanLimits {
  custom_entities: number;
  custom_fields: number;
  hub_endpoints: number;
  api_keys: number;
  workflows: number;
  workflow_nodes: number;
  workflow_runs_month: number;
  workflow_runs_per_chain: number;
  /** assistant + bot tokens (input + output) per calendar month */
  assistant_tokens_month: number;
  channels: number;
  bot_flows: number;
  knowledge_sources: number;
}

/** Billing provider later; plans from config/platform.yaml now. */
export interface Billing {
  plan(planId: string): { label: string; packages: string[]; appSlots: number; limits: PlanLimits } | null;
  trialDays(): number;
}
