import { z } from 'zod';

/** Integration Hub and public API contracts shared by the server and the SPA. */

const name = z.string().trim().min(1).max(80);
const eventTypes = z.array(z.string().regex(/^(\*|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*(\.\*)?)$/)).min(1).max(100);
const common = {
  name,
  event_types: eventTypes,
  /** expression-language filter over the event (`type`, `app`, `data.*`, ...) */
  filter: z.string().max(500).optional(),
  /** event type -> schema version; omitted types are pinned to the current version on save */
  schema_pins: z.record(z.string(), z.int().positive()).default({}),
};

export const EndpointInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('webhook'), ...common, config: z.object({ url: z.url() }) }),
  z.object({
    kind: z.literal('rest_push'),
    ...common,
    config: z.object({ url: z.url(), method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'), body: z.enum(['envelope', 'data']).default('envelope') }),
    credentials: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('bearer'), token: z.string().min(1) }),
        z.object({ type: z.literal('basic'), username: z.string().min(1), password: z.string().min(1) }),
        z.object({ type: z.literal('header'), header: z.string().regex(/^[A-Za-z0-9-]{1,60}$/), value: z.string().min(1) }),
      ])
      .optional(),
  }),
  z.object({
    kind: z.literal('kafka'),
    ...common,
    config: z.object({ brokers: z.array(z.string().regex(/^[A-Za-z0-9.-]+:\d{2,5}$/)).min(1).max(10), topic: z.string().min(1).max(200), ssl: z.boolean().default(true) }),
    credentials: z.object({ mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']), username: z.string().min(1), password: z.string().min(1) }).optional(),
  }),
  z.object({
    kind: z.literal('redis_stream'),
    ...common,
    config: z.object({ url: z.string().regex(/^rediss?:\/\/[^/\s@]+(\/\d+)?$/, 'redis://host:port[/db] (credentials go in the credentials field)'), stream: z.string().min(1).max(200), maxlen: z.int().positive().max(1_000_000).optional() }),
    credentials: z.object({ password: z.string().min(1) }).optional(),
  }),
  z.object({
    kind: z.literal('sftp'),
    ...common,
    config: z.object({ host: z.string().min(1).max(255), port: z.int().min(1).max(65535).default(22), directory: z.string().min(1).max(500) }),
    credentials: z.object({ username: z.string().min(1), password: z.string().min(1).optional(), private_key: z.string().min(1).optional() }).optional(),
  }),
  z.object({
    kind: z.literal('sqs'),
    ...common,
    config: z.object({ queue_url: z.url(), region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/) }),
    // required: the platform's own AWS identity must never be used for a tenant's queue
    credentials: z.object({ access_key_id: z.string().min(1), secret_access_key: z.string().min(1) }),
  }),
  z.object({
    kind: z.literal('custom'),
    ...common,
    config: z.object({ connector_id: z.uuid() }),
    credentials: z.record(z.string(), z.string()).optional(),
  }),
]);
export type EndpointInput = z.infer<typeof EndpointInput>;
export type EndpointKind = EndpointInput['kind'];

/**
 * Custom connector spec. Steps run in order over a working value that starts as the
 * event envelope: `code` steps run sandboxed JavaScript (`function transform(input, ctx)`),
 * `http` steps send the value to a URL (SSRF-checked), `map` picks fields by path.
 */
export const ConnectorSpec = z.object({
  description: z.string().max(500).default(''),
  steps: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('map'), fields: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(200)) }),
        z.object({ kind: z.literal('code'), source: z.string().min(1).max(20_000), timeout_ms: z.int().min(10).max(2000).default(250), memory_mb: z.int().min(8).max(64).default(16) }),
        z.object({ kind: z.literal('http'), url: z.url(), method: z.enum(['POST', 'PUT', 'PATCH']).default('POST') }),
      ]),
    )
    .min(1)
    .max(10),
});
export type ConnectorSpec = z.infer<typeof ConnectorSpec>;

export const ConnectorInput = z.object({ name, spec: ConnectorSpec });

export const SyncInput = z.object({
  name,
  entity: z.string().regex(/^[a-z][a-z0-9_]*$/),
  endpoint_id: z.uuid().optional(),
  conflict_rule: z.enum(['platform_wins', 'remote_wins', 'last_write_wins']),
  /** local field -> remote field */
  field_map: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string().min(1).max(100)).default({}),
});

export const SyncInbound = z.object({
  external_id: z.string().min(1).max(200),
  /** remote modification time, used by last_write_wins */
  updated_at: z.iso.datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()),
  deleted: z.boolean().default(false),
});

// ------------------------------------------------------------------ public API scopes

export const API_SCOPES = {
  'apps:read': 'Read app records (orders, sales, shipments, payments)',
  'apps:write': 'Run app commands',
  'records:read': 'Read custom entity records',
  'records:write': 'Create, update and delete custom entity records',
  'sync:write': 'Push changes through two-way sync',
} as const;
export type ApiScope = keyof typeof API_SCOPES;
export const ApiScopeSchema = z.enum(Object.keys(API_SCOPES) as [ApiScope, ...ApiScope[]]);

export const ApiKeyInput = z.object({
  name,
  scopes: z.array(ApiScopeSchema).min(1),
  expires_in_days: z.int().min(1).max(365).optional(),
});
export const OAuthClientInput = z.object({ name, scopes: z.array(ApiScopeSchema).min(1) });
export const DelegatedTokenInput = z.object({ name, scopes: z.array(ApiScopeSchema).min(1), expires_in_minutes: z.int().min(5).max(24 * 60).default(60) });

/** Exponential backoff with "equal jitter": half the ceiling plus a random half, ceiling = min(cap, base * 2^attempt). */
export function backoffMs(attempt: number, opts: { baseMs?: number; capMs?: number; random?: () => number } = {}): number {
  const base = opts.baseMs ?? 2000;
  const cap = opts.capMs ?? 15 * 60_000;
  const ceiling = Math.min(cap, base * 2 ** Math.min(attempt, 20));
  return Math.floor(ceiling / 2 + (opts.random ?? Math.random)() * (ceiling / 2));
}
