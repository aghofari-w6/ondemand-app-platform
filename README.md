# Apps-on-Demand — prototype

Apps-on-Demand is a multi-tenant platform: tenants buy packages (Apps, Analytics, Bot,
Omnichannel), provision apps (Ordering, Payments, POS, Logistics) from YAML manifests,
customize fields, connect external systems through an Integration Hub, automate with
event-triggered workflows, and use a Claude-based assistant.

This repository holds the **prototype**. Its core rule is bare-minimum infrastructure:
**one Node.js container plus one PostgreSQL database**. Everything that would later be
Kafka, OpenSearch, ClickHouse, Temporal, Keycloak, Svix, Redis or S3 is a table or an
in-process module behind a port, so the code can grow into the full stack later.
External services are only called as API clients. Synthetic data only; never commit secrets.

## Status

| Milestone | Scope | State |
| --- | --- | --- |
| A | Week 0 + phase 1 (journey J1) | merged |
| B | Phase 2: Data studio, custom entities, link index, Integration Hub, public `/v1` | this branch |

Screens for later milestones are in the navigation and show an empty state naming the
owning package and milestone.

## Run it

Requirements: Node.js 24+, pnpm 10, PostgreSQL 17 (or `docker compose`).

```bash
pnpm install
```

```bash
cp .env.example .env   # set VAULT_KEY; everything else has dev defaults
```

```bash
createdb aod && pnpm db:migrate   # owner role: platform + template migrations, pg-boss schema
```

```bash
pnpm seed                         # demo tenant "Acme Coffee" (add --reset to re-create)
```

```bash
pnpm --filter @aod/web build && pnpm start   # http://localhost:3000
```

For development, run `pnpm dev` (API on :3000, Vite on :5173 with a proxy). Sign in to the
demo with workspace `acme-coffee` and `ayu@acme-coffee.example`; in demo mode the magic
link appears on screen instead of being emailed.

With Docker: `docker compose up --build` migrates, seeds and starts the app on :3000.

Environment (see `apps/server/src/config.ts`): `DATABASE_URL` (app role `aod_app`),
`MIGRATION_DATABASE_URL` (owner role, migrations and seed only), `PUBLIC_URL`, `DEMO_MODE`,
`VAULT_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (default `claude-opus-5-5`),
`OTEL_EXPORTER_OTLP_ENDPOINT`, `WORKERS`, `INDEX_DATABASE_URL` (owner connection for the index
builder; defaults to `MIGRATION_DATABASE_URL`), `HUB_ALLOW_PRIVATE_HOSTS` (dev/test only),
`HUB_MAX_ATTEMPTS`, `HUB_BACKOFF_BASE_MS`, `HUB_BREAKER_THRESHOLD`, `HUB_BREAKER_COOLDOWN_MS`,
`HUB_INTERVAL_MS`.

## Tests

```bash
pnpm lint && pnpm typecheck
```

```bash
pnpm test                 # unit: expression language, manifests, authorize, envelope, fields, vault
```

```bash
pnpm test:integration     # creates a fresh aod_test database (TEST_ADMIN_URL)
```

```bash
pnpm e2e                  # Playwright J1 journey + axe (needs a migrated `aod` database)
```

The integration suite includes the contracts that must hold from day one:

- **Two-tenant isolation** (`apps/server/test/isolation.int.test.ts`): discovers every table
  from the catalog, fails if a table with `tenant_id` lacks forced RLS with the tenant
  policy (or a table without `tenant_id` is not declared global), populates both tenants
  through real commands, and checks reads, cross-tenant writes and the no-context case.
- **Outbox no-loss** (`outbox.int.test.ts`): a child process writes business rows + outbox
  events and runs the dispatcher; it is `SIGKILL`ed mid-flight; a fresh dispatcher must
  deliver every committed event exactly once and nothing else. A second dispatcher stays
  idle while the first holds the advisory lock.
- Provisioning saga (retry from failed step, reverse compensation, retain/purge,
  upgrades, pins, backfill), command pipeline (idempotency, 409s, field rules, custom
  fields, cursor paging), HTTP flows (signup, invites, last-Owner guard, carrier inbound,
  lifecycle jobs, SSE), and OIDC sign-in against an in-process mock IdP.
- Phase 2: Data studio (publish/rollback, impact and blocking rules, PII encryption and
  decryption backfills, field access per role, concurrent index builds, plan limits),
  custom records (formulas, rollups, rules, idempotency, versions, link index), the
  Integration Hub against a local receiver (signatures, retries, dead letters and replay
  with the same event id, circuit breaker under concurrent failures, filters, schema pins,
  SSRF refusals, encrypted credentials, sandboxed connectors, Redis Streams, two-way sync
  with conflicts and loop prevention), and the public API (scopes, OAuth client
  credentials, delegated tokens, OpenAPI). Kafka, SFTP and SQS are tested with fake clients.

CI (`.github/workflows/ci.yml`) runs all of it in one job against a Postgres 17 service
(plus a test-only Redis service for the Redis Streams adapter). The e2e suite has two
journeys: J1 and the phase 2 journey (Data studio → custom records with a rule, a
formula and a board → signed webhook → dead letter → replay → API key), with axe checks.

## Layout

```
apps/server/        Fastify API + SSE; starts the outbox dispatcher and pg-boss workers in-process
  src/db/           Kysely database, tenant-scoped transactions, migrate script
  src/ports/        Port interfaces (EventBus, Search, Metrics, Jobs, Webhooks, Channel, Auth,
                    Vault, Files, Telemetry, Llm, Retriever, Sandbox, Billing)
  src/adapters/     One prototype adapter per port (stubs only for ports unused in Milestone A)
  src/platform/     Catalog, command pipeline, outbox, audit, consumers, provisioning saga,
                    tenant lifecycle, workspaces, custom fields
  src/http/         Routes
apps/web/           React 19 SPA (TanStack Router/Query, React Aria Components, Tailwind 4)
packages/shared/    Zod schemas, event envelope, manifest schema + validator, permission
                    catalog + authorize(), template contract, expression language
templates/<app>/    manifest.yaml, migrations/, src/ (commands, consumers, queries, seed)
db/migrations/      Platform migrations incl. roles and RLS policies
config/platform.yaml  Plans, trial app-slot limits, release channels, capability rules
e2e/                Playwright
```

## How the core contracts are built

**Tenant isolation.** Every tenant row has `tenant_id`; every tenant table has
`ENABLE` + `FORCE ROW LEVEL SECURITY` and the policy
`tenant_id = current_tenant_id()` for both `USING` and `WITH CHECK`
(`aod_enable_tenant_rls()`, used by templates too). Each request runs in a transaction that
first does `set_config('app.tenant_id', …, true)` (i.e. `SET LOCAL`). The server connects as
`aod_app`: no superuser, no `BYPASSRLS`, no DDL. The few cross-tenant needs (slug lookup at
sign-in, outbox relay, reading the event log, lifecycle sweeps) are narrow
`SECURITY DEFINER` functions.

**Outbox and events.** Every write inserts `outbox_event` rows (Debezium outbox-router
columns `id, aggregatetype, aggregateid, type, payload` + `tenant_id, created_at`) in the
same transaction. Payloads use the envelope in `packages/shared/src/envelope.ts`
(`id, type, version, tenant_id, app, occurred_at, traceparent, correlation_id,
causation_id, origin, workflow_hop, workflow_chain, data, schema_ref`). The in-process
dispatcher holds a session advisory lock (a second instance stays idle), relays committed
rows into `event_log` with `FOR UPDATE SKIP LOCKED`, and delivers to consumers with a cursor
per consumer; dedup insert into `processed_event`, the handler and the cursor advance
share one tenant-scoped transaction.

**Writes.** App commands go through one pipeline (`apps/server/src/platform/commands.ts`):
tenant and app checks → `authorize()` → `Idempotency-Key` (stored 24 h; replays return the
stored response, reuse with another body is 422) → Zod validation → handler → outbox +
audit. Handlers may only emit events listed in their command's `may_emit`. Updates use the
`version` column (409 on mismatch).

**Authorization.** `authorize(principal, action, resource, context)` in
`packages/shared/src/permissions.ts` takes Cedar-shaped entity UIDs. Role presets (Owner,
Admin, Manager, Staff, Viewer) map onto permission levels from the catalog (platform +
every manifest's `permissions`); custom roles pick permissions and field rules
(`hidden`/`read`/`write` per resource field), which mask list/detail output and block writes.

**Audit.** `audit_log` is append-only: the app role has no `UPDATE`/`DELETE` grant. It
survives a tenant purge.

**Manifests and templates.** `templates/<app>/manifest.yaml` declares entities, published
and consumed events, commands with `may_emit`, views, workflow templates, analytics,
assistant tools with risk tiers, telemetry, permissions and releases. The validator rejects
incomplete contracts and non-expand-only migrations in later releases. Templates are
separate packages that import only `@aod/shared`; an ESLint rule blocks cross-template
imports and there are no foreign keys between apps. Apps react to each other through events
gated by capability rules (e.g. POS sales become Ordering orders only while both are active).

**Expression language.** `packages/shared/src/expr`: own lexer and recursive-descent
parser; field references, literals, comparison/boolean/arithmetic operators, an allowlisted
function set, own-property lookups only, a depth limit and a step limit.

**Provisioning.** Eight pg-boss steps (entitlement, dependencies, allocate, migrate+seed,
config/theme, register contracts, health check, activate), each idempotent by run+step,
streamed to the UI over SSE. A failed run waits: retry resumes from the failed step; roll
back compensates completed steps in reverse. Deprovisioning is the reverse saga with retain
(30 days, restorable) or purge. Upgrades move a tenant along its release channel
(stable/canary); pins block them.

## Phase 2 in one page

- **Data studio** (`apps/server/src/platform/datastudio.ts`): one draft per tenant over a
  versioned `Definition` (`packages/shared/src/datastudio.ts`). Publishing validates it
  (expressions, links, layouts, plan limits), computes an impact summary (changes, records
  affected, backfills, index jobs, blocking problems such as a required field without a
  default), swaps the runtime projections (`field_definition`, `field_access_rule`) in the
  same transaction, and queues backfills (`set_default`, `encrypt`, `decrypt`) and index
  requests. Rollback re-publishes an earlier version as a new version.
- **PII** values are stored as `enc:v1…` (AES-256-GCM via the Vault port, bound to tenant,
  record type and field), decrypted only on read, and never put in events.
- **Custom entities** live in one RLS table (`custom_record`) and are written through the
  same contract as app commands. Formulas and rollups are computed on read; rules run on
  every write. Link fields feed the link index.
- **Link index** (`record_link`): manifests declare `links` (e.g. a shipment ships an
  order); a platform consumer records them, and detail pages show linked records the
  viewer may read.
- **Integration Hub** (`apps/server/src/platform/hub.ts`, `adapters/delivery.ts`,
  `adapters/ssrf.ts`, `adapters/sandbox.ts`): see the module comments for fan-out,
  delivery, breaker, replay and two-way sync.
- **Public API** (`/v1`, `apps/server/src/http/routes/v1.ts`): bearer only; API keys,
  OAuth client-credentials tokens and delegated tokens resolve to a scoped principal and go
  through the same authorize/RLS/idempotency/outbox/audit paths. `/v1/openapi.json` is
  generated per tenant from active apps and the published data model.

## Decisions worth knowing

- **DDL happens at deploy time, not at provision time.** The migrate script (owner role)
  applies platform and all template migrations; the provisioning `migrate+seed` step
  verifies the release's migrations are present and seeds tenant data. This keeps the
  runtime role free of DDL rights. Because tables are shared across tenants, later releases
  must be expand-only (enforced by the manifest validator).
- **The server runs TypeScript directly** on Node 24 (type stripping): no server build step.
- **pg-boss lives in its own `pgboss` schema owned by `aod_app`** because it creates
  partitions at runtime; that schema holds no tenant data.
- **A failed provisioning run pauses** for retry or rollback instead of compensating
  automatically, so "retry from the failed step" is possible.
- The demo flag `POST /api/provisioning/fail-once {step}` (demo mode only) makes one step
  fail, to show retry and rollback.
- **The index builder is the one runtime DDL path.** `CREATE INDEX CONCURRENTLY` cannot run
  inside a transaction or a function and needs table ownership, so a single worker uses
  the owner connection (`INDEX_DATABASE_URL`) and only ever issues CREATE/DROP INDEX built
  from catalog names and validated keys. Everything else still connects as `aod_app`.
- **The `Webhooks` port covers all outbound transports** (webhook, REST push, Kafka, Redis
  Streams, SFTP, SQS); Svix or managed brokers can replace the adapter later.
- **SSRF:** HTTP connections are pinned to the checked addresses (no DNS rebinding) and
  redirects are not followed; SFTP connects to the checked IP; every Kafka broker socket
  (including brokers the cluster advertises) goes through the policy; Redis and SQS hosts
  are checked right before connecting. SQS endpoints must bring their own credentials, so
  the platform's AWS identity is never used for a tenant's queue.
- **Two-way sync covers custom entities**, whose shape is generic; app entities sync one
  way through events and commands.
- **API keys and OAuth clients carry scopes, not roles:** field rules apply to users and
  delegated tokens; machine credentials see every field their scopes allow.
- Formulas and rollups are computed on read, so they need no backfill.
