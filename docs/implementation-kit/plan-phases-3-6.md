# Apps-on-Demand prototype: plan for phases 3–6 (Milestones C–F)

Status: **draft v0.1, written 2026-11-01** after Milestones A (week 0 + phase 1) and B
(phase 2) were merged.

> **Read this first.** The original implementation plan (`prototype-implementation-plan.md`
> v0.2) is not in this repository. This plan is a reconstruction from:
> - the product brief: packages Apps, Analytics, Bot and Omnichannel; event-triggered
>   workflows; a Claude-based assistant; Telegram, with email and SMS optional; payment
>   provider test mode;
> - the left navigation, which lists every screen still to build;
> - the hooks already in the code: manifest `workflows.templates`, `analytics.metrics` and
>   `assistant.tools` with risk tiers; the envelope's `workflow_hop` and `workflow_chain`;
>   the `Llm`, `Channel`, `Files`, `Retriever` and `Billing` ports.
>
> Reconcile the scope and the week numbers with v0.2 before starting Milestone C. Section 8
> lists the decisions that need a yes or no.

## 1. Where we are

| Milestone | Phase | Scope | State |
| --- | --- | --- | --- |
| A | week 0 + 1 | Tenancy, RLS, outbox, sign-in (magic link, OIDC, SAML), roles, catalog and provisioning saga, Ordering/Payments/POS/Logistics, workspaces, J1 | merged (#1) |
| B | 2 | Data studio, custom entities, link index, Integration Hub, public `/v1` | merged (#2) |
| **C** | **3** | **Workflows, Approvals, Trace viewer** (Apps package) | this plan |
| **D** | **4** | **Dashboards, Reports, Data governance** (Analytics package) | this plan |
| **E** | **5** | **Assistant, Inbox, Channels, Bot Studio** (Bot + Omnichannel packages) | this plan |
| **F** | **6** | **Billing and usage, hardening, launch readiness** | this plan |

Proposed timeline for 2 engineers. This assumes A and B took weeks 0–7 of the ~19-week
budget; adjust to v0.2.

| Milestone | Weeks | Length | Why that long |
| --- | --- | --- | --- |
| C | 8–10 | 3 weeks | Workflow engine + approvals UI |
| D | 11–13 | 3 weeks | Metric pipeline + dashboard UI |
| E | 14–17 | 4 weeks | Assistant safety + external channels + Bot Studio; the riskiest phase |
| F | 18–19 | 2 weeks | Billing in test mode + hardening |

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
- **Running a milestone.** Start each one with its kickoff prompt in
  `claude/prompts/milestone-<x>.md` and the `milestone` skill.

## 3. Carry-over from A and B

These are small gaps, scheduled into early milestones so they don't pile up.

| Item | Milestone | Done when |
| --- | --- | --- |
| Build the Docker image in CI and smoke-test `/api/health` in it | C, week 1 | CI job step green |
| Kafka and SFTP tested against real services (test-only CI containers: Redpanda, atmoz/sftp) | D | integration tests use the live services |
| Other cloud queues (Google Pub/Sub, Azure Service Bus) | D, if v0.2 asks for them | adapter + fake-client unit tests |
| Two-way sync for app entities, starting with orders | E (Omnichannel needs order status from outside) | sync test with conflict rules |
| Retire the Files/Retriever stubs | D (Files), E (Retriever) | adapters + tests |

## 4. Milestone C — phase 3: Workflows, Approvals, Trace viewer

**Package:** Apps. **Screens replaced:** Workflows, Approvals, Trace viewer.

### Scope

1. **Workflow definitions.**
   - Shape: a trigger (an event type, optionally filtered with the expression language),
     then steps:
     - `condition` (expression)
     - `command` (app command, run as the workflow's service principal)
     - `record` (custom record write)
     - `hub_send` (a Hub endpoint)
     - `notify` (Channel port)
     - `wait` (duration, or until an event arrives, with a timeout)
     - `approval`
     - `set` (variables)
   - Lifecycle: draft, publish and rollback with version history, the same pattern as Data
     studio (`workflow_version`).
   - Built from manifest `workflows.templates`: "Use template" pre-fills a definition.
   - Plan limits: number of workflows and runs per month.
2. **Engine on the event bus.**
   - A consumer (`platform.workflows`) starts a run per matching trigger in the same
     transaction that marks the event processed, so a run is never lost or doubled.
   - Runs and step executions are stored in tables (`workflow_run`, `workflow_step_run`)
     and advanced by pg-boss jobs keyed by run+step, so steps are idempotent. Temporal
     replaces this later behind the `Jobs` port.
   - Retries use backoff (the Hub policy). Failed runs go to a run DLQ with retry from the
     failed step, like the provisioning saga.
3. **Loop protection.** Events emitted by a workflow carry `origin: workflow`,
   `workflow_hop + 1` and the workflow id appended to `workflow_chain`. Runs stop at hop 5,
   and a workflow already in the chain is never re-entered. Integration tests cover both
   guards.
4. **Approvals.**
   - An `approval` step creates an approval request with approvers (role or users),
     quorum, expiry and the data to show; the run pauses.
   - The **Approvals** inbox lets approvers approve or reject with a comment. Every
     decision is audited; expired requests take the step's timeout path.
   - Approvals are also the gate for high-risk assistant tools in Milestone E, so build
     them as a platform service (`approval_request`), not as a workflow-only feature.
5. **Trace viewer.**
   - Enter a correlation id, record id or event id and see the full chain:
     command → events → consumers → workflow runs/steps → Hub deliveries → approvals.
   - It is built from `correlation_id`/`causation_id` (already on every envelope) plus run
     and delivery tables, laid out as a timeline.
   - Add OTel `traceparent` links where present.
6. **UI.**
   - The Workflows screen: list, an editor with a step list, the trigger and expression
     fields, and a test run against a sample or past event (dry run: commands are not
     executed).
   - The run history page.
   - The Approvals inbox and the Trace viewer.

### Acceptance (journey J3)

A Manager builds the workflow "When a POS sale over Rp 1,000,000 is voided, require a
manager's approval, then refund the payment and notify the store".

1. A test run shows the steps.
2. After publishing, a real void starts a run, which pauses at Approvals.
3. A second manager approves; the refund command runs and the notification is recorded.
4. The Trace viewer shows the full chain from one correlation id.
5. Loop and hop guards are proven in integration tests.
6. axe passes on every new screen.

## 5. Milestone D — phase 4: Dashboards, Reports, Data governance

**Package:** Analytics, which must be enabled by the plan through the existing
package/entitlement check. **Screens replaced:** Dashboards, Reports, Data governance.

### Scope

1. **Metrics pipeline (Metrics port: ClickHouse later, Postgres now).**
   - A consumer turns events into per-tenant time buckets (`metric_bucket`: metric,
     dimension set, bucket start (hour/day), count/sum/min/max).
   - Driven by manifest `analytics.metrics`, plus metrics defined on custom entities in
     Data studio.
   - Backfill from `event_log` when a metric is added. Late and duplicate events are
     handled by `processed_event` dedup.
   - Queries go through the Metrics port only.
2. **Dashboards.**
   - Widgets: KPI with comparison, time series, bar by dimension, top-N table.
   - Filters: date range, store, channel.
   - Dashboards can be shared per role. Each tenant starts with a default dashboard per
     active app.
   - Field rules apply: no widget can aggregate a field hidden for the viewer (the same
     principle as the B review fix).
3. **Reports.**
   - Saved queries over workspaces and metrics, exported as CSV and as PDF (server-side
     rendering).
   - Schedules (pg-boss cron) deliver through the Channel port (email adapter) or the
     Files port.
   - **Files port:** the prototype adapter stores files in PostgreSQL (`file_object`,
     bytea, size-capped, RLS) behind signed, expiring download URLs. S3 replaces it later.
4. **Data governance.**
   - A PII inventory, generated from Data studio flags and manifest `pii` fields.
   - Retention policies per entity (purge or anonymise after N days) run as audited
     backfill-style jobs.
   - Access review: which roles and API credentials can read each PII field, with export.
   - Data subject requests: find everything about a person by email or phone across
     apps and the link index, then export it (Files) or erase it (anonymise, keeping audit
     and accounting integrity). Every step is audited.
   - An audit-log export.
5. Carry-over: Kafka and SFTP live tests, plus extra cloud queues if v0.2 lists them.

### Acceptance (journey J4)

1. Acme Coffee's default dashboard shows orders, revenue and POS takings per store.
2. Filtering by store updates all widgets.
3. A weekly report is scheduled and a manual run produces a downloadable CSV.
4. A retention policy anonymises customer names on orders older than N days. The
   governance page shows the inventory and the access review.
5. A data subject request for a test customer produces an export file and then an
   erasure, both visible in the audit log.
6. axe passes on every new screen.

## 6. Milestone E — phase 5: Assistant, Inbox, Channels, Bot Studio

**Packages:** Bot (Assistant, Bot Studio) and Omnichannel (Inbox, Channels).
**Screens replaced:** all four Conversations screens.

### Scope

1. **Assistant.** Claude through the existing `Llm` port, model id from `CLAUDE_MODEL`.
   - **Tools:**
     - Generated from active apps' manifest `assistant.tools`: views become read tools and
       commands become write tools.
     - Custom-record and Hub-status tools are added on top.
     - Every tool call runs as the signed-in user through `authorize()`, so the assistant
       can never do more than the user.
   - **Risk tiers:**
     - `read` runs automatically.
     - `low` asks the user to confirm in the chat.
     - `high` creates an approval request (Milestone C) and the assistant waits.
   - **Safety:**
     - Tool results and retrieved text are wrapped as data, never as instructions.
     - A system prompt that says so, plus per-tenant token and cost limits from the plan.
     - Every tool call is recorded with origin `assistant` in the audit log and the Trace
       viewer.
   - **Retriever port:** PostgreSQL full-text search over records, help articles and
     tenant documents (from Files), with chunks and citations. pgvector is optional and
     needs a decision (§8).
   - **Experience:** streaming over SSE; conversation history per user; "explain this
     record" from detail pages.
2. **Channels (Channel port: real adapters).**
   - Telegram Bot API: inbound webhook with secret-token verification, outbound
     `sendMessage`, and per-tenant bot tokens kept in the Vault.
   - Email: SMTP or provider API, optional. SMS: provider API, optional.
   - Outbound goes through the SSRF policy. Delivery status is recorded, and failed sends
     use the Hub retry and DLQ machinery.
3. **Inbox.**
   - Conversations from all channels, with customer identity resolved by phone or email
     and linked through the link index to orders and shipments.
   - Assignment, statuses, internal notes, canned replies, and SLA timers (pg-boss).
   - Real-time updates over SSE.
4. **Bot Studio.**
   - Bot flows: intents or keywords → replies, collect details (with validation via the
     expression language), look up data with read tools, "ask the assistant" with
     guardrails, and hand off to a human in the Inbox.
   - A test console, and draft/publish/rollback (the shared versioning pattern).
5. Carry-over: two-way sync for orders, if Omnichannel needs external status updates.

### Acceptance (journey J5)

1. A customer messages the Acme Telegram bot "where is my order 1042?". Use a mock
   Telegram server in tests; one manual run against the real Bot API is recommended (§8).
2. The bot looks up the order through a read tool and replies with its status.
3. The customer asks to cancel. The bot hands off to the Inbox.
4. Staff ask the assistant to cancel order 1042. It is a `high`-risk tool, so it waits on
   an approval; after approval the order is cancelled and the customer gets a reply.
5. The Trace viewer shows the whole chain.
6. The assistant refuses a prompt-injection attempt embedded in a customer message:
   integration test with a fake `Llm` adapter, plus a manual eval against Claude.
7. axe passes on every new screen.

## 7. Milestone F — phase 6: Billing and usage, hardening, launch readiness

**Screens replaced:** Billing and usage. After F, no placeholder screens remain.

### Scope

1. **Billing (Billing port).**
   - Plans and packages stay in `config/platform.yaml`.
   - Subscriptions and invoices run in payment-provider **test mode** (provider to be
     chosen, §8). The adapter is an API client; checkout and webhooks use signature
     verification and idempotency.
   - Trial → active conversion through checkout.
   - Dunning: a failed payment leads to grace, then `suspended`, using the existing
     lifecycle jobs.
2. **Usage metering.**
   - Meters: active app slots, API calls (`/v1`), Hub deliveries, workflow runs, assistant
     tokens, channel messages, storage.
   - Counted from events and request logs into `usage_counter` (Metrics port). Plan limits
     are enforced from them.
   - The Billing and usage screen shows the plan, usage against limits, invoices and the
     payment method (provider-hosted).
3. **Hardening.**
   - Per-tenant rate limiting: a token bucket in PostgreSQL in front of `/v1` and `/api`.
   - OpenTelemetry export plus a basic SLO dashboard.
   - A backup and restore drill, documented.
   - Load tests (k6) against agreed targets: e.g. p95 < 300 ms for workspace lists at
     10k records per tenant, and an outbox lag under 2 s at 50 events/s.
   - Dependency and licence audit, and a threat model review of everything built in
     A–E.
   - A full accessibility audit.
4. **Readiness.**
   - Demo data for every package in the Acme seed, and a scripted end-to-end demo.
   - A runbook.
   - A **"path to the full stack"** document: per port, how to swap the prototype adapter
     (Kafka, OpenSearch, ClickHouse, Temporal, Keycloak, Svix, Redis, S3) and the
     migration steps for the data the PostgreSQL adapters hold.

### Acceptance (journey J6)

1. A trial tenant upgrades through test-mode checkout and becomes `active`.
2. Usage of API calls and assistant tokens shows on Billing and usage.
3. Exceeding a limit is refused with a clear message.
4. A test-mode payment failure leads to `suspended` after the grace period, and paying
   restores the tenant.
5. Load-test results are recorded against the targets.
6. axe passes on the Billing screen.

## 8. Decisions needed before Milestone C

1. **Scope and order.** Does this split (C workflows/approvals, D analytics,
   E conversations, F billing/hardening) match v0.2? In particular, v0.2 may place the
   Trace viewer or Approvals elsewhere. The navigation placeholders currently say
   Trace viewer → F; this plan moves it to C, where it's needed first.
2. **Workflow editor.** Is a step-list editor enough, or does v0.2 call for a visual
   canvas? The step list is much cheaper and fits the 3-week budget.
3. **pgvector.** Is the `vector` extension acceptable on the single PostgreSQL? Without
   it the Retriever uses full-text search only.
4. **Channels.** Telegram is required. Are email and SMS in or out, and which providers?
5. **Billing provider.** Which payment provider for test mode?
6. **Live external checks.** Is it allowed to run a manual check against the real
   Telegram Bot API and Claude API with test credentials kept outside the repo, never
   committed?

## 9. Risks

| Risk | Milestone | Mitigation |
| --- | --- | --- |
| Workflow engine grows into a general orchestrator | C | Fixed step types; anything else is a Hub connector code step |
| Assistant does something the user didn't intend | E | Tools run as the user; risk tiers; approvals for `high`; injection tests; full audit |
| Metric pipeline drifts from source data | D | Rebuildable from `event_log`; nightly reconciliation job compares counts |
| External APIs (Telegram, payment provider, Claude) are flaky in CI | E, F | Mock servers in CI; live checks only manual |
| E overruns its 4 weeks | E | Bot Studio is the cut line: ship with assistant + Inbox + Telegram first |
| Performance at realistic data sizes | F | Load tests early in F; indexes from Data studio; keyset paging everywhere already |
