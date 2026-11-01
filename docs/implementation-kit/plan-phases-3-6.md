# Apps-on-Demand prototype: plan for phases 3–6 (Milestones C–F)

Status: **v0.2, 2026-11-01.** The decisions in section 8 are answered. Written after
Milestones A (week 0 + phase 1) and B (phase 2) were merged.

> The original implementation plan (`prototype-implementation-plan.md` v0.2) is not in this
> repository. This plan is reconstructed from the product brief, the navigation
> placeholders, and the hooks already in the code:
> - manifest `workflows.templates`, `analytics.metrics` and `assistant.tools` with risk tiers;
> - the envelope's `workflow_hop` and `workflow_chain`;
> - the `Llm`, `Channel`, `Files`, `Retriever` and `Billing` ports.
>
> The product owner confirmed the scope decisions on 2026-11-01 (section 8).

## 1. Where we are

| Milestone | Phase | Scope | State |
| --- | --- | --- | --- |
| A | week 0 + 1 | Tenancy, RLS, outbox, sign-in (magic link, OIDC, SAML), roles, catalog and provisioning saga, Ordering/Payments/POS/Logistics, workspaces, J1 | merged (#1) |
| B | 2 | Data studio, custom entities, link index, Integration Hub, public `/v1` | merged (#2) |
| **C** | **3** | **Workflows on a visual canvas, Approvals, Trace viewer** (Apps package) | planned |
| **D** | **4** | **Dashboards, Reports, Data governance** (Analytics package) | planned |
| **E** | **5** | **Assistant (pgvector retrieval), Inbox, Channels (Telegram, Gmail, web chat widget), Bot Studio** (Bot + Omnichannel packages) | planned |
| **F** | **6** | **Billing and usage with iPaymu, hardening, launch readiness** | planned |

### Timeline for 2 engineers

This assumes A and B used weeks 0–7. The decisions added scope: a visual workflow canvas,
plus Gmail and a web chat widget. That makes the plan **~22 weeks instead of ~19**.

| Milestone | Weeks | Length | Change | Cut line if the 19-week budget must hold |
| --- | --- | --- | --- | --- |
| C | 8–11 | 4 weeks | +1 for the canvas | Ship single-path flows first; parallel branches and merge come later |
| D | 12–14 | 3 weeks | — | PDF reports; keep CSV only |
| E | 15–19 | 5 weeks | +1 for Gmail and the widget; Bot Studio reuses C's canvas | Bot Studio after the assistant, Inbox and channels |
| F | 20–21 | 2 weeks | — | Load testing at a reduced scale |

## 2. Rules that carry over unchanged

Every milestone keeps the contracts in `CLAUDE.md`:

- **Infrastructure.** One container and one PostgreSQL database. New infrastructure goes
  behind a port with one prototype adapter. External services are reached only as API
  clients.
- **Tenant isolation.** Every new tenant table gets `aod_enable_tenant_rls`, and the
  isolation test must populate it.
- **Writes.** Every write goes through the command or record pipeline: authorize →
  idempotency → validation → outbox + audit.
- **Outbound calls.** Everything outbound goes through the `Webhooks`/`Channel` ports and
  the SSRF policy. Tenant code runs only in the `Sandbox` port.
- **Testing.** Each milestone adds integration tests for its contracts, one e2e journey with
  axe checks on every new screen, and a `contract-reviewer` pass before the PR.
- **No live external calls yet (decision 6).**
  - Telegram, Gmail, iPaymu and Claude are tested against mock servers and fake adapters,
    in CI and locally.
  - Each external integration ships a *live-readiness checklist* (section 10) to run once
    live checks are allowed.
  - No real credentials are created or stored anywhere until then.
- **Running a milestone.** Start each one with its kickoff prompt in
  `claude/prompts/milestone-<x>.md` and the `milestone` skill.

## 3. Carry-over from A and B

| Item | Milestone | Done when |
| --- | --- | --- |
| Build the Docker image in CI and smoke-test `/api/health` in it | C, week 1 | CI step green |
| Kafka and SFTP against real services (test-only CI containers: Redpanda, atmoz/sftp) | D | integration tests use the live services |
| Other cloud queues (Google Pub/Sub, Azure Service Bus), only if v0.2 lists them | D | adapter + fake-client tests |
| Two-way sync for app entities, starting with orders | E | sync test with conflict rules |
| Retire the Files stub (D) and the Retriever stub (E) | D, E | adapters + tests |
| PostgreSQL with pgvector in CI (`pgvector/pgvector:pg17`), docker-compose and local dev (`postgresql-16-pgvector`) | E, week 1 | `CREATE EXTENSION vector` in the migrate script; CI green |

## 4. Milestone C — phase 3: Workflows (visual canvas), Approvals, Trace viewer

**Package:** Apps. **Screens replaced:** Workflows, Approvals, Trace viewer.

### Scope

1. **Workflow graph model.**
   - A workflow is a directed acyclic graph: one **trigger** node, then action and
     control nodes joined by edges. Each edge leaves from a named output.
   - Node types:
     - `trigger` (event type + expression filter)
     - `condition` (outputs `true` / `false`)
     - `switch` (one output per case + `default`)
     - `command` (app command)
     - `record` (custom record write)
     - `hub_send` (Hub endpoint)
     - `notify` (Channel port)
     - `wait` (duration, or until an event; outputs `event` / `timeout`)
     - `approval` (outputs `approved` / `rejected` / `expired`)
     - `set` (variables)
     - `code` (Sandbox port, isolated-vm, same limits as Hub connectors)
   - Expressions use the expression language with `{{ }}` templates over
     `trigger.*`, `steps.<node>.output.*` and `vars.*`.
   - **v1 runs one path at a time.** A node's output picks exactly one outgoing edge.
     **Parallel branches with a merge node** are scoped to C, behind the cut line in
     section 1.
   - The validator rejects:
     - cycles, or a graph with zero or several triggers;
     - unreachable nodes and dangling outputs;
     - unknown commands or fields;
     - invalid expressions;
     - a `command`/`record` node that would emit the workflow's own trigger with no
       guard (loop risk).
   - Lifecycle: draft, publish and rollback with version history (`workflow_version`), the
     Data studio pattern.
   - Manifest `workflows.templates` become one-click starter graphs.
2. **Visual canvas editor in the n8n style**, as our own implementation.
   - Built on React Flow (`@xyflow/react`, MIT): a node palette, drag to connect outputs to
     inputs, a node config side panel with typed forms per node, zoom/pan, a minimap,
     auto-layout, undo/redo, copy/paste, and inline validation errors on nodes and edges.
   - **Test run:** execute the draft against a pinned sample or a past real event, with
     side-effecting nodes in dry-run mode. Each node then shows its input and output
     inline, and failed nodes are highlighted.
   - **Execution view:** open any past run on the canvas with the path taken and each
     node's data, timing and errors.
   - **Accessibility (WCAG 2.1 AA).** A canvas alone is not accessible, so the editor has a
     synchronized **outline view**: an ordered tree of nodes and their outputs where
     everything can be done by keyboard and screen reader (add, connect, configure,
     delete). Nodes on the canvas are focusable with arrow-key movement and labelled
     ports. axe runs on both views.
3. **Engine on the event bus.**
   - A consumer (`platform.workflows`) starts a run for each matching published workflow,
     in the transaction that marks the event processed (never lost or doubled).
   - Runs and node executions are stored in tables (`workflow_run`, `workflow_node_run`)
     and advanced by pg-boss jobs keyed by run+node, so each node runs idempotently.
     Temporal replaces this later behind the `Jobs` port.
   - Retries use backoff. Failed runs go to a run DLQ with retry from the failed node, like
     the provisioning saga.
   - Commands run as the workflow's service principal, whose permissions come from a role
     chosen at publish time and can never exceed the publisher's.
4. **Loop protection.**
   - Emitted events carry `origin: workflow`, `workflow_hop + 1` and the workflow id
     appended to `workflow_chain`.
   - Runs stop at hop 5, and a workflow already in the chain is never re-entered.
   - Integration tests prove both guards.
5. **Approvals.** A platform service (`approval_request`), not workflow-only, because
   Milestone E reuses it for high-risk assistant tools.
   - A request has approvers (a role or users), a quorum, an expiry and the data to show.
   - The Approvals inbox lets approvers approve or reject with a comment; every decision
     is audited.
   - Expiry takes the `expired` output.
6. **Trace viewer (decision 1: moved here from F).**
   - Search by correlation id, record id or event id to see the chain:
     command → events → consumers → workflow runs/nodes → Hub deliveries → approvals.
   - Shown as a timeline, with links into the canvas execution view and OTel
     `traceparent` where present.
7. Plan limits: number of workflows, nodes per workflow, and runs per month.
8. Carry-over: the Docker image built in CI.

### Acceptance (journey J3)

A Manager builds, on the canvas, "When a POS sale over Rp 1,000,000 is voided → approval
by a manager → approved: refund the payment and notify the store; rejected: notify the
cashier".

1. A test run on a past void shows each node's input and output.
2. After publishing, a real void starts a run, which pauses at Approvals.
3. A second manager approves; the refund runs and the notification is recorded.
4. The execution view shows the path taken.
5. The Trace viewer shows the whole chain from one correlation id.
6. The same workflow can be built with the outline view using only the keyboard.
7. Loop and hop guards are proven in integration tests.
8. axe passes on the canvas, the outline view, Approvals and the Trace viewer.

## 5. Milestone D — phase 4: Dashboards, Reports, Data governance

**Package:** Analytics, which must be enabled by the plan through the existing entitlement
check. **Screens replaced:** Dashboards, Reports, Data governance.

### Scope

1. **Metrics pipeline (Metrics port: ClickHouse later, Postgres now).**
   - A consumer turns events into per-tenant time buckets (`metric_bucket`).
   - Driven by manifest `analytics.metrics` plus metrics defined in Data studio.
   - Backfill from `event_log`; dedup via `processed_event`.
   - A nightly reconciliation job compares buckets with the source tables.
2. **Dashboards.**
   - Widgets: KPI with comparison, time series, bar by dimension, top-N table.
   - Filters: date range, store, channel.
   - Sharing per role; a default dashboard per active app.
   - Field rules apply: no widget can aggregate a field hidden for the viewer.
3. **Reports.**
   - Saved queries, exported as CSV and as PDF (server-side rendering).
   - Schedules (pg-boss cron) deliver by email (the Gmail channel from E, if present, or a
     downloadable file) or to Files.
   - **Files port:** a PostgreSQL adapter (`file_object`, bytea, size-capped, RLS) with
     signed, expiring download URLs. S3 replaces it later.
4. **Data governance.**
   - A PII inventory, from Data studio flags and manifest `pii` fields.
   - Retention policies per entity (purge or anonymise after N days) run as audited jobs.
   - Access review: which roles and API credentials can read each PII field.
   - Data subject requests: find everything about a person by email or phone across apps
     and the link index, then export it (Files) or erase it (anonymise, keeping audit and
     accounting integrity).
   - An audit-log export.
5. Carry-over: Kafka and SFTP live tests, plus extra cloud queues if v0.2 lists them.

### Acceptance (journey J4)

1. Acme Coffee's default dashboard shows orders, revenue and POS takings per store, and a
   store filter updates every widget.
2. A scheduled report and a manual CSV export both work.
3. A retention policy anonymises old customer names.
4. A data subject request exports and then erases a test customer, with everything audited.
5. axe passes on every new screen.

## 6. Milestone E — phase 5: Assistant, Inbox, Channels, Bot Studio

**Packages:** Bot (Assistant, Bot Studio) and Omnichannel (Inbox, Channels).
**Screens replaced:** all four Conversations screens.

### Scope

1. **Assistant.** Claude through the `Llm` port, model id from `CLAUDE_MODEL`.
   - **Tools:**
     - Generated from active apps' manifest `assistant.tools`, plus custom-record and
       Hub-status tools.
     - Every tool call runs as the signed-in user through `authorize()`, so the assistant
       can never exceed the user.
   - **Risk tiers:**
     - `read` runs automatically.
     - `low` asks the user to confirm in the chat.
     - `high` creates an approval request (Milestone C) and the assistant waits.
   - **Safety:**
     - Tool results and retrieved text are passed as data, never as instructions.
     - Per-tenant token and cost limits.
     - Every tool call is audited with origin `assistant` and visible in the Trace viewer.
   - **Experience:** streaming over SSE; conversation history; "explain this record".
2. **Retriever port with pgvector (decision 3).**
   - Hybrid retrieval: pgvector cosine similarity combined with PostgreSQL full-text
     ranking (reciprocal-rank fusion).
   - Sources: records, help articles and tenant documents from Files. Chunks are stored in
     `doc_chunk`, RLS-protected, with an `embedding vector(n)` column. Every answer comes
     with citations.
   - **Index:** HNSW on the shared table, queried with
     `WHERE tenant_id = … ORDER BY embedding <=> $q` and pgvector's iterative index scans
     so tenant filtering keeps recall. Tests check that a tenant can never retrieve
     another tenant's chunks.
   - **Embeddings (default; decide with E's kickoff if you prefer otherwise).** An
     `Embeddings` adapter inside the Retriever port. The default is an in-process
     open-source model (transformers.js / ONNX; no data leaves the container, no extra
     vendor key). A Voyage AI API client, Anthropic's recommended embedding partner, is
     the alternative. CI uses a deterministic fake embedder.
   - Re-embedding runs as backfill jobs when a source changes.
3. **Channels (Channel port, real adapters; decision 4).**
   - **Telegram:** Bot API webhook with secret-token verification, `sendMessage`, and
     per-tenant bot tokens in the Vault.
   - **Gmail:**
     - A tenant connects a Gmail / Google Workspace mailbox with OAuth (offline access);
       refresh tokens are encrypted in the Vault.
     - Inbound: History API polling through pg-boss (default every 30 s; Gmail push via
       Pub/Sub is a later option).
     - Outbound: `users.messages.send` with correct threading (`threadId`, `In-Reply-To`,
       `References`). Attachments go to Files.
     - Google restricted-scope verification is needed before production; tracked in
       section 10.
   - **Web chat widget (live chat):**
     - An embeddable `<script>` served by the platform, with per-tenant widget keys and
       allowed origins (CORS + `frame-ancestors`).
     - Anonymous visitor sessions with optional email capture, and identity verification
       for signed-in site users (HMAC of the user id with a tenant secret).
     - Real time over SSE plus POST, on the one container; rate limits per visitor and per
       tenant.
     - The widget is accessible itself (WCAG 2.1 AA, axe-checked) and themable with the
       tenant accent.
   - Outbound goes through the SSRF policy. Delivery status is recorded, and failures use
     the Hub retry/DLQ machinery.
   - SMS is out of scope.
4. **Inbox.**
   - Conversations from all channels in one place.
   - Customer identity resolved by phone, email or widget identity, and linked to orders
     and shipments through the link index.
   - Assignment, statuses, internal notes, canned replies, and SLA timers.
   - Real-time updates over SSE.
5. **Bot Studio, on the Milestone C canvas.**
   - Bot flows reuse the canvas component and graph engine with bot node types:
     - `message`
     - `ask` (collect and validate with the expression language)
     - `lookup` (read tools)
     - `ask_assistant` (guardrailed)
     - `handoff` (to the Inbox)
     - `condition` and `switch`
   - Triggered per channel (Telegram, Gmail, widget).
   - A test console, and draft/publish/rollback.
6. Carry-over:
   - pgvector images in CI and compose.
   - Two-way sync for orders, if Omnichannel needs external status.

### Acceptance (journey J5)

All against mocks, per decision 6.

1. A visitor opens the **web widget** on a demo page and asks "where is my order 1042?". The
   Bot Studio flow looks it up and answers.
2. The visitor asks to cancel and is handed off to the Inbox.
3. Staff ask the assistant to cancel order 1042. It is a `high`-risk tool, so it waits on
   an approval; after approval the order is cancelled and the visitor gets a reply in the
   widget.
4. The same question by **Gmail** (mock API) and **Telegram** (mock API) is answered and
   threaded correctly.
5. The assistant answers a policy question with a citation from an uploaded document
   (pgvector + full-text).
6. A prompt-injection attempt in a customer message is refused (fake `Llm` in CI).
7. The Trace viewer shows the whole chain.
8. axe passes on every new screen and on the widget.

## 7. Milestone F — phase 6: Billing and usage (iPaymu), hardening, launch readiness

**Screens replaced:** Billing and usage. After F, no placeholder screens remain.

### Scope

1. **Billing with iPaymu (decision 5), behind the Billing port.**
   - Plans and packages stay in `config/platform.yaml`, priced in IDR.
   - The platform owns subscriptions and invoices: it issues a monthly invoice per tenant
     and collects it through an **iPaymu payment link** (QRIS, virtual account and other
     methods iPaymu offers).
   - The adapter is an API client to iPaymu API v2:
     - requests are signed with the merchant `va` + API key (HMAC-SHA256 over method, `va`,
       body hash and key);
     - sandbox base URL in all non-production environments.
   - **Payment notification (`notify_url`):** never trusted as-is. The adapter
     re-confirms the transaction status with iPaymu's check-transaction API before marking
     an invoice paid. Notifications are idempotent per transaction id.
   - Trial → active conversion through the first paid invoice.
   - Dunning: reminders through the Gmail channel, a grace period, then `suspended` (the
     existing lifecycle jobs); payment restores the tenant.
   - *To verify against iPaymu's current docs at F's kickoff:* the exact signature format,
     callback fields, sandbox behaviour, and whether recurring payments exist (the design
     does not depend on them).
   - Optional, only if v0.2 asks: an iPaymu adapter for the **Payments app's**
     `PaymentProvider`, next to the fake provider.
2. **Usage metering.**
   - Meters: active app slots, `/v1` calls, Hub deliveries, workflow runs, assistant
     tokens, channel messages, storage.
   - Counted into `usage_counter` through the Metrics port; plan limits are enforced from
     them.
   - The Billing and usage screen shows the plan, usage against limits, invoices with
     payment links, and payment history.
3. **Hardening.**
   - Per-tenant rate limiting (a token bucket in PostgreSQL) on `/v1`, `/api` and the
     widget.
   - OpenTelemetry export plus a basic SLO dashboard.
   - A backup and restore drill.
   - k6 load tests: p95 < 300 ms for workspace lists at 10k records per tenant; outbox lag
     under 2 s at 50 events/s; widget message round trip under 1 s.
   - Dependency and licence audit, a threat model review of A–E, and a full accessibility
     audit.
4. **Readiness.**
   - Demo data for every package in the Acme seed, and a scripted end-to-end demo.
   - A runbook.
   - A "path to the full stack" document per port: Kafka, OpenSearch, ClickHouse, Temporal,
     Keycloak, Svix, Redis, S3, plus the vector store.

### Acceptance (journey J6)

All against the iPaymu mock, per decision 6.

1. A trial tenant receives an invoice and pays through the payment link (mock iPaymu,
   sandbox shape).
2. The notification is re-confirmed and the tenant becomes `active`.
3. Usage shows on Billing and usage, and exceeding a limit is refused clearly.
4. An unpaid invoice leads to reminders, then `suspended` after the grace period; payment
   restores the tenant.
5. Load-test results are recorded.
6. axe passes on the Billing screen.

## 8. Decisions (answered 2026-11-01)

| # | Question | Answer | Effect on the plan |
| --- | --- | --- | --- |
| 1 | Scope split, Trace viewer placement | Split confirmed; **Trace viewer moves to C** | Section 4.6; the placeholder now says Milestone C |
| 2 | Workflow editor | **Visual canvas, n8n-style** | Section 4.2; C grows to 4 weeks; Bot Studio reuses it |
| 3 | pgvector on the single PostgreSQL | **Yes** | Section 6.2; pgvector images in CI, compose and dev |
| 4 | Channels besides Telegram | **Gmail and a web chat widget**; no SMS | Section 6.3; E grows to 5 weeks |
| 5 | Billing provider (test mode) | **iPaymu** (sandbox) | Section 7.1 |
| 6 | Live checks with real Telegram/Claude APIs | **Not yet** | Mocks and fakes only; live-readiness checklists in section 10 |

Still open; the default applies unless changed:
- **Embeddings model:** default in-process open-source model; Voyage AI as the alternative
  (section 6.2). Decide at E's kickoff.
- **Google Cloud project for Gmail OAuth:** who owns the OAuth client and its
  verification. Needed before any live Gmail check; not needed for E's mock-based
  acceptance.
- **The 19-week budget:** accept ~22 weeks, or apply the cut lines in section 1.

## 9. Risks

| Risk | Milestone | Mitigation |
| --- | --- | --- |
| The canvas editor eats the milestone | C | React Flow for the canvas basics; single-path flows first; parallel/merge behind a cut line; the outline view doubles as the accessible editor and the test surface |
| Canvas accessibility | C | Outline view with full parity; keyboard and screen-reader tests in e2e; axe on both views |
| Workflow engine grows into a general orchestrator | C | Fixed node types; anything else is a `code` node (Sandbox) or a Hub connector |
| Assistant does something the user didn't intend | E | Tools run as the user; risk tiers; approvals for `high`; injection tests; full audit |
| Cross-tenant leakage through vector search | E | Chunks under RLS; tenant-filtered ANN queries; a two-tenant retrieval test added to the isolation suite |
| Embeddings model too heavy for one container | E | Small model, batched backfill jobs, concurrency cap; swap to the Voyage API client if needed |
| Gmail restricted scopes and verification delay a launch | E | Mock-based acceptance now; verification tracked in section 10 |
| Widget abuse (spam, origin spoofing) | E | Allowed origins, per-visitor rate limits, HMAC identity verification, size caps |
| iPaymu API details differ from assumptions | F | Verify against current docs at F's kickoff; the adapter is isolated behind the Billing port; mock built from the documented shapes |
| No live external checks until approved | C–F | Live-readiness checklists; contract tests against recorded API shapes |
| Schedule (~22 vs ~19 weeks) | all | Cut lines in section 1 |

## 10. Live-readiness checklists (run once live checks are approved)

- **Claude API:**
  - A key in the deployment's secret store, never in the repo.
  - An evaluation set for tool use and injection resistance, run against `CLAUDE_MODEL`.
  - Cost limits verified.
- **Telegram:**
  - A test bot.
  - `setWebhook` with a secret token.
  - Send and receive, and verify a bad secret token is rejected.
- **Gmail:**
  - A Google Cloud project and OAuth client; the restricted-scope verification plan.
  - A test mailbox.
  - Inbound polling, threading and outbound send verified.
  - Revoking access from Google's side handled.
- **iPaymu:**
  - Sandbox merchant credentials in the secret store.
  - Create a payment link.
  - Notification → check-transaction confirmation.
  - Expired and failed payments.
  - Then production credentials, only after sign-off.
