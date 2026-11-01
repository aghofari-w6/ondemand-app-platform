/**
 * Ports. Every piece of infrastructure the full platform would run as a separate
 * system (Kafka, OpenSearch, ClickHouse, Temporal, Keycloak, Svix, Redis, S3, ...)
 * is an interface here with exactly one prototype adapter backed by PostgreSQL or
 * an in-process module. Swapping an adapter must not touch call sites.
 */
import type { EventEnvelope } from '@aod/shared';
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

/** Email/SMS/Telegram later; demo mode shows the message on screen. */
export interface Channel {
  send(msg: { tenantId: string; to: string; subject: string; body: string; link?: string }): Promise<{ via: string; preview?: { subject: string; link?: string } }>;
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
}

/** S3 later. Not used before Milestone B. */
export interface Files {
  put(tenantId: string, key: string, body: Buffer, contentType: string): Promise<{ url: string }>;
  get(tenantId: string, key: string): Promise<Buffer | null>;
}

/** OpenTelemetry. */
export interface Telemetry {
  span<T>(name: string, attrs: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T>;
  /** W3C traceparent of the active span, if any */
  traceparent(): string | null;
}

/** Claude API. Used by the assistant (later milestone); the adapter is real. */
export interface Llm {
  complete(p: { system?: string; messages: { role: 'user' | 'assistant'; content: string }[]; maxTokens?: number }): Promise<{ text: string; model: string }>;
}

/** Vector search later. Not used before the assistant milestone. */
export interface Retriever {
  retrieve(tenantId: string, query: string, k: number): Promise<{ id: string; text: string; score: number }[]>;
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
}

/** Billing provider later; plans from config/platform.yaml now. */
export interface Billing {
  plan(planId: string): { label: string; packages: string[]; appSlots: number; limits: PlanLimits } | null;
  trialDays(): number;
}
