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
| B | Phase 2: Data studio, custom entities, link index, Integration Hub, public `/v1` | merged |
| C | Phase 3: workflows on a visual canvas, Approvals, Trace viewer | merged |
| D | Phase 4: dashboards, reports, data governance | merged |
| E | Phase 5: Assistant with pgvector retrieval, Inbox, Channels (Telegram, Gmail, web chat widget), Bot Studio | this branch |
| F | Phase 6: billing and usage (iPaymu), hardening, launch readiness | not started |

Screens for later milestones are in the navigation and show an empty state naming the
owning package and milestone.

## Run it

Requirements: Node.js 24+, pnpm 10, PostgreSQL 16 or 17 **with the pgvector extension**
(`pgvector/pgvector:pg17` in CI and `docker compose`; `apt install postgresql-16-pgvector` locally;
0.8+ recommended, older versions fall back to exact vector scans).

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

Conversations (Milestone E): `LLM_ADAPTER` (`claude` | `fake`; `fake` is the scripted model
used in CI, e2e and `docker compose`), `CLAUDE_FALLBACKS` (server-side refusal fallbacks,
default on), `EMBEDDINGS_ADAPTER` (`voyage` | `fake`; defaults to `fake` without a key),
`VOYAGE_API_KEY`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_DIM` (must equal the `vector(n)` column:
1024), `TELEGRAM_API_URL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`GOOGLE_OAUTH_URL`, `GOOGLE_TOKEN_URL`, `GMAIL_API_URL`, `GMAIL_POLL_SECONDS` (default 30),
`CHANNEL_INTERVAL_MS`. Keys and OAuth secrets live in the deployment's secret store, never
in the repository. Until live checks are approved (plan decision 6) Telegram, Google and
Voyage are only ever called as mock servers in tests.

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
pnpm e2e                  # Playwright J1, phase 2, J3, J4 and J5 journeys + axe (needs a migrated `aod` database)
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
- Phase 3 (`workflows.int.test.ts`): the J3 workflow end to end (test run on a past void,
  a real void pausing at Approvals, a second manager approving, refund + notification,
  trace by correlation, run and record id), rejection and expiry outputs, publishing
  (invalid graphs, service role above the publisher or too narrow), rollback, the loop
  guard (two workflows ping-pong once, then stop) and the hop guard, exactly-once (a
  re-delivered trigger, a node processed twice concurrently), parallel/merge, event waits
  and timeouts, the run DLQ (retry from the failed node) and the `error` output, and the
  service principal losing a permission after publish.
- Phase 4 (`analytics.int.test.ts`, `transports.int.test.ts`): metrics backfilled by a
  rebuild then followed by the consumer (voids come back out of takings), a rebuild
  equal to the incremental path, reconciliation finding a corrupted bucket, events that
  arrive before a metric has state, a deleted tenant's events never stalling the
  consumer, overlapping rebuild jobs counting each event once, a dead rebuild restarted,
  plan entitlement, read permissions and hidden fields (incl. filters and filter values);
  dashboards (defaults,
  validation, sharing per role); reports (CSV, PDF, schedules run as the owner, signed
  downloads incl. tampered/expired/other-tenant tokens); Files (chunking, RLS, size cap);
  governance (PII inventory, access review, retention anonymising old names with a
  per-record audit, data subject export and erase by phone and email, linked records
  exported without PII and left untouched by an erase, audit export paging), and links
  to report files and exports only for those allowed to see them. Kafka and SFTP run against
  Redpanda and atmoz/sftp containers in CI.
- Phase 5 (`assistant.int.test.ts`, `conversations.int.test.ts`, plus the Hub file for the
  order sync): knowledge retrieval on pgvector + full text (citations, documents from
  Files, a tenant never retrieving another tenant's chunks even when those are the nearest
  vectors, public vs internal sources, record chunks without PII, full-text answers during
  an embeddings outage and the backfill after it, the Voyage adapter against a mock);
  the assistant (read tools run as the user, low risk waits for a confirmation, high risk
  for an approval and then runs as the requester exactly once, rejection, a permission
  lost before approval, cut-off and refused model turns, instructions inside documents
  treated as data, a model that obeys an injection still stopped by the risk tier, token
  limits per tenant, private conversations, the SSE route); channels against mock
  Telegram and Google servers (secret-token webhook, idempotent updates, threaded replies,
  retries with backoff, dead letters and retry, undecryptable secrets, Gmail OAuth with a
  signed state, History API polling, attachments in Files, `In-Reply-To`/`References`,
  an expired history cursor, revoked access → reconnect); the web widget (allowed origins,
  CORS and `frame-ancestors`, signed sessions, HMAC identity verification, rate and size
  limits, encrypted email capture, live events); the Inbox (plan and permissions,
  assignment, statuses with versions, canned replies, SLA timers, linked-record updates
  posted once); Bot Studio flows (validation, a service role capped at the publisher,
  rollback, J5 on the widget, Telegram and Gmail, `ask` nodes, the guardrailed assistant
  refusing a prompt injection, exactly-once turns, the test console); and two-way sync for
  orders (conflict rules, no echo, PII never in the body).

CI (`.github/workflows/ci.yml`) runs all of it in one job against a Postgres 17 service
(plus a test-only Redis service for the Redis Streams adapter). The e2e suite has four
journeys: J1, the phase 2 journey (Data studio → custom records with a rule, a formula and
a board → signed webhook → dead letter → replay → API key) and J3 (canvas + keyboard-only
outline → test run → publish → approval by a second manager → execution view → trace) and
J4 (dashboards with a store filter → scheduled report and CSV export → retention → data
subject export and erase → audit export),
with axe checks on every screen. A second CI job builds the Docker image, runs it against
a migrated database and waits for `/api/health`. The fifth journey, J5: a visitor asks the web
widget where their order is and the bot flow answers; asking to cancel hands over to the
Inbox; staff ask the assistant to cancel, a second manager approves, the order is cancelled
and the visitor is told; the same question by Telegram and Gmail (mock APIs) is answered in
the right thread; a policy question is answered with a citation from an uploaded document;
a prompt injection is refused; the Trace viewer shows the chain. Both jobs use the
`pgvector/pgvector:pg17` image.

## Layout

```
apps/server/        Fastify API + SSE; starts the outbox dispatcher and pg-boss workers in-process
  src/db/           Kysely database, tenant-scoped transactions, migrate script
  src/ports/        Port interfaces (EventBus, Search, Metrics, Jobs, Webhooks, Channel, Auth,
                    Vault, Files, Telemetry, Llm, Embeddings, Retriever, Sandbox, Billing,
                    OutboundHttp, RateLimit, Realtime)
  src/adapters/     One prototype adapter per port (stubs only for ports unused in Milestone A)
  src/platform/     Catalog, command pipeline, outbox, audit, consumers, provisioning saga,
                    tenant lifecycle, workspaces, custom fields, …, knowledge, assistant/,
                    conversations/ (channels, inbox), bot/ (flows, runner)
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

## Phase 3 in one page

- **Graph** (`packages/shared/src/workflow.ts`): a DAG with one trigger; edges leave from
  named outputs (`true`/`false`, switch cases, `approved`/`rejected`/`expired`,
  `event`/`timeout`, `error` on action nodes). The validator rejects cycles, zero or several
  triggers, unreachable nodes, a port feeding two nodes (use a parallel node), parallel
  branches meeting anywhere but their merge, unknown events/commands/entities/endpoints/
  roles, invalid expressions, and a command that can emit the workflow's own trigger
  without a filter. `{{ }}` templates use the expression language over `trigger`,
  `steps.<node>.output`, `vars` (and `event` in a wait filter).
- **Lifecycle** (`platform/workflows/definitions.ts`): the Data studio pattern — one draft,
  publish validates and supersedes, rollback re-publishes as a new number. Publishing picks
  the role the workflow acts as; it may not exceed the publisher's permissions or field
  access, and must cover every node (`hub_send` needs `platform:hub.send`). At run time
  the principal holds (the role's permissions now) ∩ (the snapshot taken at publish).
  Enabling a workflow or retrying its run needs the actor to hold that snapshot too.
- **Run data and field rules:** the execution view and test runs mask any key hidden from
  the viewer by a field rule; test runs replay only past events of the trigger's type.
- **Engine** (`platform/workflows/engine.ts`): see the module comment. A consumer starts
  runs in the transaction that marks the event processed; an in-process runner claims
  node executions with a lease; command/record nodes commit with their node, keyed
  `wf:<node run>`. Waits and approval expiries are due node runs; event waits are resolved
  by the consumer. Failed runs keep their state for retry from the failed node.
- **Loop protection:** events written by a run carry `origin: workflow`, the run's hop and
  chain; an event at hop 5, or whose chain holds the workflow, records a cancelled run
  with the reason instead of starting one. One change (correlation chain) starts at most
  `workflow_runs_per_chain` runs, a plan limit in `config/platform.yaml` (trial 20,
  starter 50, growth 200), which bounds fan-out when several workflows re-emit each
  other's triggers.
- **Approvals** (`platform/approvals.ts`): a platform service (workflows now, assistant
  tools in E). Approver roles, quorum (any rejection rejects), expiry; every decision is
  audited under the request's correlation id. The user whose change started the chain
  (from the audit log) cannot approve its requests.
- **Trace viewer** (`platform/trace.ts`): everything under a correlation id — audit,
  events (metadata only), consumers, runs and nodes, Hub deliveries, approvals and
  decisions — found from a correlation, event, record, run or approval id.
- **UI:** the canvas is our own editor on React Flow (`@xyflow/react`, MIT; attribution
  hidden, credited here) with a palette, labelled output ports, inline problems,
  auto-layout, undo/redo and copy/paste. The outline view offers the same editing as an
  ordered list of nodes and outputs, by keyboard and screen reader.

## Phase 4 in one page

- **Metrics** (`platform/analytics/metrics.ts`, `Analytics` port, `adapters/pg-analytics.ts`):
  manifest `analytics.metrics` name the events that move them (a value, filter and time
  expression over event data), their dimensions (store, channel) and a reconciliation
  filter; Data studio adds metrics over custom entities. The `platform.metrics` consumer
  adds points to hourly `metric_bucket` rows in the event's transaction. A new or changed
  metric is rebuilt from `event_log` (reset + batched replay up to the seq recorded at
  the start; consumer adds and rebuild starts share a per-metric advisory lock). A
  nightly job reconciles bucket totals with the source tables and rebuilds once on drift.
- **Reading metrics** (`analytics/query.ts`): the plan must include Analytics, the viewer
  needs the entity's read permission, and a field hidden for the viewer can be neither
  aggregated nor grouped by. Ranges are capped at 400 days.
- **Dashboards**: a built-in Overview and one per app, generated from the metrics the
  viewer may see; saved dashboards are shared per role. Widgets: KPI with comparison, time
  series, bars by dimension, top list; every chart also has a table view.
- **Reports**: saved queries exported as CSV (formula-safe) or PDF (pdfkit, loaded only
  for PDFs), streamed into Files; schedules are claimed every minute across tenants and
  run as the owner. Email delivery waits for the Gmail channel (Milestone E).
- **Files** (`adapters/pg-files.ts`): `file_object` + 256 KB `file_chunk` rows under RLS,
  streamed both ways and size-capped; downloads use signed, expiring tokens
  (`/api/files/download?token=…`).
- **Data governance** (`platform/governance.ts`): PII inventory (manifests + Data
  studio), access review (roles after field rules; API credentials by scope), retention
  policies (anonymise PII on app entities, anonymise or delete custom records; audited
  nightly jobs), data subject requests (find by email or phone across apps and the link
  index; export JSON or erase PII while amounts and the audit log stay), audit-log export.

## Phase 5 in one page

**Knowledge retrieval (Retriever port, pgvector).** Help articles, text documents (stored
through the Files port) and custom records become `doc_source` rows, chunked into
`doc_chunk` with a generated `tsvector` and an `embedding vector(1024)` behind one shared
HNSW index. Retrieval fuses cosine distance with full-text rank (reciprocal-rank fusion),
runs under RLS and also filters by `tenant_id`, with pgvector's iterative index scans so
the tenant filter keeps recall. Embeddings come from the `Embeddings` adapter: Voyage AI as
an API client (document / query input types, retries with backoff, model and dimension
from config) or a deterministic fake in CI and local runs. Chunks are stored before they
are embedded, so full-text search answers during an embeddings outage and a sweep
backfills. Sources are internal or public; bots only ever quote public ones. Record chunks
hold only fields every role may read (never PII) and need `platform:records.read`.

**Assistant (Bot package).** A tool-use loop on the `Llm` port (Claude, model from
`CLAUDE_MODEL`; streamed, adaptive thinking, no forced tool choice, server-side refusal
fallbacks; a scripted fake in CI). Tools are generated from the active apps' manifest
`assistant.tools` (views are read tools, commands keep their risk tier) plus knowledge
search, custom records and Hub status. Every tool runs as the signed-in user through
`authorize()`: the model only sees tools the user holds, and each execution is checked
again. `read` runs at once; `low` waits for the user to confirm in the chat; `high`
creates an approval request (the Milestone C service) and, once another approver decides,
runs as the requester with the permissions they hold then, exactly once. Tool results and
retrieved passages reach the model only as tool results (data). PII fields are dropped
from what the model sees. The transcript is append-only. Token usage is metered per tenant
and month against the plan's limit. Every tool call is audited with origin `assistant`
under the turn's correlation id, so the Trace viewer shows the chain. The chat streams
over Server-Sent Events.

**Channels (Omnichannel package, Channel port).** Telegram: Bot API client, webhook
verified by its secret token, bot token in the vault. Gmail: OAuth with offline access (the
deployment's Google client), refresh token in the vault, History API polling through
pg-boss (30 s by default), replies with `threadId`, `In-Reply-To` and `References`,
attachments stored through Files; a revoked or expired grant turns the channel into
"reconnect Gmail". Web chat widget: an embeddable script and an accessible chat frame
served by the platform, per-widget keys and allowed origins (CORS + `frame-ancestors`),
signed visitor sessions, optional email capture, HMAC identity verification for signed-in
site users, SSE + POST, rate limits per visitor and tenant. Every outbound API call goes
through one policed HTTP client (SSRF check, timeouts, capped responses). Outbound
messages are queued with attempts, backoff, a dead letter and a retry from the Inbox.

**Inbox.** Conversations from all channels with contacts resolved by keyed hashes of their
identities (email and phone are encrypted at rest), assignment, statuses with optimistic
versions, internal notes, canned replies, first-response SLA timers, live updates over
SSE, and links to orders and shipments through the link index. When a linked record
changes status the customer gets an update in their conversation. Message text never
enters event data or the audit log.

**Bot Studio.** Bot flows on the workflow canvas (and its keyboard outline) with the node
types `message`, `ask`, `lookup`, `ask_assistant`, `handoff`, `condition` and `switch`;
draft / publish / rollback with version history; a test console that stores and sends
nothing. A published flow looks things up with a service role capped at its publisher.
A turn is computed without a transaction (lookups, the model call) and applied once.
`ask_assistant` is the guardrailed customer assistant: no tools, public knowledge only,
the customer's text wrapped as data.

**Two-way sync for orders.** A manifest `sync` declaration lets the Hub sync an app entity:
outbound bodies carry declared non-PII fields; inbound changes run the declared commands
with origin `integration` under the same conflict rules as custom records.

Live-readiness checklists for Claude, Telegram, Voyage AI and Gmail are in
`docs/implementation-kit/plan-phases-3-6.md` (section 10); none has been run.

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
- **Workflow nodes are advanced by an in-process claim loop, not pg-boss jobs.** Node runs
  are rows claimed with a lease (`workflow_claim_nodes`, like Hub deliveries), which keeps
  completion and successors in one transaction. Temporal can replace it behind the same
  tables later.
- **`hub_send` nodes publish a `workflow.message` event** addressed to one endpoint, so
  outbound calls keep the Hub's SSRF policy, signatures, retries and dead letters.
- **Files live in PostgreSQL as chunked `bytea`, not large objects.** `pg_largeobject`
  is outside row-level security, so tenant isolation would rest on code alone; chunks
  keep RLS and still stream.
- **Analytics has its own port.** The existing `Metrics` port counts operations; the
  plan's "Metrics port" for tenant analytics is `Analytics` (ClickHouse later).
- **Governance writes app PII columns directly** (anonymise/erase), like Data studio
  backfills: no app has such a command, only PII columns change, and every run is
  recorded with `recordChange` without PII.
- **Notifications go through the outbox:** a `notify` node writes a `workflow.notification`
  event (user ids, never addresses) with its completion; the `platform.notifications`
  consumer calls the Channel port. A crash between send and commit can repeat a send.
