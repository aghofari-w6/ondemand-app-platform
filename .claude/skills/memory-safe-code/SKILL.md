---
name: memory-safe-code
description: Rules for server code that must not leak memory or spin the CPU, adapted from the Mobichat Oct 2026 off-heap memory / CPU runaway incident to this codebase. Use whenever writing or reviewing server-side code (Fastify routes, platform/, adapters/, workers, consumers) that touches request bodies or file upload/download, outbound HTTP or Hub transports, streams/SSE, timers/polling loops/background workers, module-level caches or Maps, pg/pg-boss/Kafka/Redis/SFTP/SQS/Anthropic or other long-lived clients, retry/reconnect loops, date or pagination loops, isolated-vm or other heavy libraries, or large Buffers.
---

# Memory- and CPU-safe code

This skill is adapted from a production incident on another Node service (Mobichat, Oct
2026): pods leaked RAM (1 GB → 2.5 GB spikes) and pinned CPU above 100%. Every cause was
a pattern that looked harmless in a PR. The same patterns apply here, because this
prototype runs **everything in one Node container** (API, event bus, Hub deliverer,
workflow runner, pg-boss workers). One leaking loop takes all of it down.

Apply every rule below that matches what you are writing. When reviewing, run the
**Detection greps** at the end over the changed files. Each rule names this repo's
reference code. "Known gaps" lists places that do not follow the rule yet.

---

## 1. Never buffer whole bodies in memory

**Incident:** download routes concatenated whole S3 objects (`chunks → Buffer.concat`).
That held about 2× the file size per request: 20 concurrent 30 MB downloads ≈ 1.2 GB.
Uploads peaked at ~4× the file size, from `Buffer.from(await file.arrayBuffer())` and
then an upload.

**Inbound request bodies**
- Fastify's global `bodyLimit` is 1 MB (`apps/server/src/http/app.ts`). Never raise it
  globally.
- A route that needs more sets its own `bodyLimit` with an explicit `MAX_*_BYTES`
  constant. Never accept unbounded input.
- Files (the `Files` port, S3 later, Milestone D) are **streamed**:
  - Uploads: reject on `content-length` before reading. Sniff only the first bytes for
    MIME. Pipe the rest to storage.
  - Downloads: return a stream with `Content-Length`. Never return a concatenated Buffer.
  - When the `Files` port is implemented, change `put(…, body: Buffer)` to accept a
    `Readable`.
- Exports and reports (CSV/XLSX, Milestone D) stream rows from a cursor. Never build the
  whole file in memory.

**Outbound calls (server → internet): cap bytes and time**
- All outbound calls go through the `Webhooks` port (`adapters/delivery.ts`, contract
  12). It enforces the SSRF policy and `TIMEOUT_MS` (connect, headers and body
  timeouts on the undici `Agent`, plus `AbortSignal.timeout`).
- Read remote response bodies **with a byte cap**: stop reading after N bytes and
  cancel the stream.
- ❌ `await res.text()`, `res.json()` or `res.arrayBuffer()` on a response from a
  tenant-configured URL, followed by `.slice()`. The whole body is already in memory
  by then.
- Logged or stored excerpts stay small: delivery responses 2 KB, error messages 500
  chars (`errMessage`).

## 2. Every timer, poller and stream must die with its owner

**Incident:** an SSE `cancel()` only set `closed = true`, so the 2.5 s DB poll and the
heartbeat ran **for the life of the pod**. 100 abandoned streams cost 44% CPU.

- **Background workers** follow one pattern (references: `HubDeliverer` in
  `platform/hub.ts`, `WorkflowRunner` in `platform/workflows/engine.ts`, `PgEventBus` in
  `adapters/pg-event-bus.ts`):
  - a `running` flag;
  - a `setTimeout` chain, never `setInterval`, so a slow tick never overlaps the next;
  - `stop()` clears the timer **and awaits the in-flight tick**.
- A new worker is started in `startWorkers()` and stopped in `stopPlatform()`
  (`platform/create.ts`), and in the test helper `closePlatform()`
  (`apps/server/test/helpers.ts`). It must not be able to start twice.
- **SSE / long-poll routes** (reference: `GET /api/provisioning/runs/:id/stream` in
  `http/routes/apps.ts`):
  - listen for `req.raw.on('close')`;
  - check the flag every iteration;
  - have a hard deadline;
  - `res.end()` on every exit path.
- Any `setTimeout`, `setInterval`, `.on(...)`, `subscribe(...)` or `process.on(...)` you
  add needs a matching clear or `off` in the owner's close path. Whoever registers it
  unregisters it.
- Await sleeps through a real timer (`await new Promise((r) => setTimeout(r, ms))`)
  inside a loop that has an exit condition.

## 3. Long-lived clients: one shared instance, never one per call

**Incident:**
- On a Redis outage, every `error`/`close` created a new client while the old one kept
  retrying forever.
- `connect()` built a new client and pool on every call.
- Connections and CPU grew without bound.

- **PostgreSQL:** use `p.database` (one `pg.Pool` from `createDatabase`,
  `db/database.ts`) through `withTenant` / `withoutTenant`.
  - ❌ `new pg.Pool()` or `new pg.Client()` in feature code.
  - The only allowed exceptions are the migrate script, the seed and the index builder's
    owner connection (`platform/maintenance.ts`). Each of those closes its client in
    `finally`.
- **pg-boss:** the single instance from `adapters/pg-boss-jobs.ts`, behind the `Jobs`
  port.
- **Per-delivery Hub transports** (Kafka producer, Redis Stream, SFTP, SQS in
  `adapters/delivery.ts`) are created per message because each targets a
  tenant-configured system. Each one:
  - has a connect timeout (`TIMEOUT_MS`);
  - has no reconnect loop (`retry: { retries: 0 }`, `maxRetriesPerRequest: 1`);
  - is closed in `finally` (`disconnect()`, `quit()`, `end()`).
  Keep it that way. A pooled transport needs a bounded pool with eviction (§5).
- **SDK clients** (Anthropic in `createLlm`, the Voyage AI embeddings client in
  Milestone E): create once per adapter, not per call.
- **Reconnects:** let the library reconnect the same client. Replace a client only after
  it has ended, one at a time, never from inside an `error` handler.

## 4. Retry, requeue and reconnect loops need backoff and a give-up path

**Incidents:**
- Throttled queue messages were requeued immediately, so consumers spun at 100% CPU.
- A failing SDK `start()` retried in a microtask-only loop: 50k+ iterations in 3 s,
  which starved the event loop.

- **Every retry loop** needs:
  - a max attempt count or a deadline;
  - a wait on a real timer between attempts (`backoffMs()` in `packages/shared/src/hub.ts`
    gives exponential backoff with jitter), never `Promise.resolve()` or
    `queueMicrotask`;
  - a terminal "give up + record + log" branch.
- References:
  - Hub deliveries: `HUB_MAX_ATTEMPTS`, then dead-letter, with the circuit breaker.
  - Workflow nodes: `MAX_NODE_ATTEMPTS`; `NodeError.retry` is false for deterministic
    failures, so a 4xx is never retried.
  - The provisioning saga pauses for retry or rollback instead of looping.
- **Event-bus consumers:** a thrown error retries the same event on every dispatcher
  tick, and the event blocks that consumer (head-of-line). Throw only for transient
  errors (DB, network). For errors that will never succeed (bad data, a missing app),
  return `'skipped'` or record the failure, so one poison event cannot stall the
  consumer forever.
- Errors the user must fix (revoked credentials, undecryptable secrets, 4xx) go
  straight to the terminal branch (example: `hub.ts` dead-letters undecryptable
  secrets).

## 5. Bound every cache and in-memory collection

**Incident:** a template cache, a preview cache, the sharp cache and SDK app instances
were all module-level and grew forever.

- A module-level or adapter-level `Map`/`Set`/object/array that gains entries per
  request, tenant, workflow, endpoint or user **must** have a max size with eviction,
  and/or a TTL **that also evicts** (checking age on read alone is not a bound).
  - Reference: `graphCache` in `platform/workflows/engine.ts` (cleared at 500 entries).
- Keys that come from tenant input (issuer URLs, endpoint ids, workflow ids) make the
  bound mandatory: a tenant can create them without limit.
- Shared or cross-instance state lives in PostgreSQL (with expiry, like
  `idempotency_key`), not in process memory.
- Never cache whole query results, event payloads or file contents keyed by user input
  without a cap.

## 6. Heavy libraries: load lazily, create once, dispose

**Incident:** a new JSDOM window (each its own V8 context) was created per rich-text
block and never closed, and jsdom loaded at import time. That cost ~950 MB of idle RSS
and a 15 s startup stall.

- **isolated-vm** (the `Sandbox` port, `adapters/sandbox.ts`):
  - one isolate per run;
  - `memoryLimit` and a wall-clock timeout set;
  - `isolate.dispose()` in `finally`.
  Keep all three.
- **Load heavy modules** (PDF/XLSX/report renderers in Milestone D, headless browsers,
  large SDKs only some routes use) with `await import()` inside the function that needs
  them, not at the top of a module every route imports.
- Reuse one instance where possible. When you must create one per call, close it in
  `finally`.
- **Web bundle:** the SPA already warns about a >500 kB chunk. Lazy-load heavy screens
  (the React Flow canvas) with `React.lazy`, not new top-level imports.

## 7. Bound loops over dates, pages and user-provided ranges

**Incident:** date loops in schedules and reports never ended for dates past year 9999,
and the routes had no range cap.

- Validate and **cap** `from`/`to` ranges at the API boundary with Zod before looping
  (dashboards and reports in Milestone D). Reject invalid dates.
- `while` loops over dates or cursors need a hard iteration ceiling.
  - References: the dry run's `MAX_STEPS` and `MAX_MS` (`workflows/dryrun.ts`);
    `drain()` loops capped at 100–200 ticks.
- **Every read of a growing table** needs `.limit()` or a cursor. Growing tables include
  `event_log`, `outbox_event`, `audit_log`, `hub_delivery`, `hub_delivery_attempt`,
  `workflow_run`, `workflow_node_run`, `custom_record` and app tables.
  - References: cursor paging in `listRecords`, batches of 200 in `backfillTenant`, the
    trace viewer's 500-row limit, the approvals inbox's 200.
- Avoid O(n × m) work over large sets. Build a `Map` once and look up from it.
- Don't store whole request bodies in log tables, audit `data` or span attributes.
  Truncate them.

## 8. Promise safety (process-killing, not just leaky)

Node exits on an unhandled rejection, and in this container that kills the API and every
worker at once.
- Fire-and-forget calls get `.catch((e) => p.log.error({ err: String(e) }, '…'))`, as
  the worker loops do. Mark them with `void`.
- An empty `.catch(() => {})` is only acceptable where failure is truly irrelevant, with
  a comment saying why (e.g. best-effort cleanup in `finally`).
- No dangling `.finally()` chains without a `.catch()`.

---

## Verifying a change

- **Unit-test the cleanup.** Use vitest fake timers (`vi.useFakeTimers()`) to assert:
  - `stop()`/`close()` clears every timer;
  - caches stop growing at their max;
  - retries stop at the cap and wait between attempts.
- **Integration-test the stop path.** `closePlatform()` must return, and the test run
  must exit. A test file that hangs after its last test means a timer or connection was
  left open.
- **Watch memory under load.**
  - `process.memoryUsage()` (rss, heapUsed, external, arrayBuffers) and
    `perf_hooks.monitorEventLoopDelay()` show the trend.
  - Expose numbers through the `Metrics` port (`/api/ops/metrics`).
  - Growing `arrayBuffers` or `external` ⇒ Buffer/stream problem (§1).
  - Growing `heapUsed` ⇒ cache, collection or listener (§2, §5).
  - High event-loop delay ⇒ a CPU loop (§4, §6, §7).
  - For heap snapshots: `node --inspect apps/server/src/main.ts`, then Chrome DevTools.

## Detection greps (run on changed files during review)

```bash
# 1. whole-body reads / buffering
grep -nE "\.text\(\)|\.json\(\)|arrayBuffer\(\)|Buffer\.concat|bodyLimit" <files>
# 2. timers / listeners: check each has a matching clear/off and an owner that stops it
grep -nE "setInterval|setTimeout|\.on\(|\.once\(|\.subscribe\(|process\.on\(" <files>
# 3. ad-hoc clients
grep -nE "new (pg\.Pool|pg\.Client|Pool|Client|PgBoss|Redis|Kafka|SQSClient|Anthropic|SftpClient)\(" <files>
# 4. retry / spin loops
grep -nE "while ?\(true\)|for ?\(;;\)|retry|attempt|queueMicrotask|Promise\.resolve\(\)\.then" <files>
# 5. module-level collections
grep -nE "^(export )?(const|let) \w+ = new (Map|Set)\(|^(export )?(const|let) \w+ = (\[\]|\{\})" <files>
# 6. heavy imports at module top
grep -nE "^import .*(isolated-vm|pdf|xlsx|puppeteer|playwright|canvas|jsdom)" <files>
# 7. unbounded reads (check each has .limit()/cursor, or is a small table)
grep -nE "selectFrom\('(event_log|outbox_event|audit_log|hub_delivery|hub_delivery_attempt|workflow_run|workflow_node_run|custom_record)'" <files>
# 8. floating promises in workers / loops
grep -nE "^\s+void [a-zA-Z_.]+\(|\.catch\(\(\) => \{\}\)" <files>
```

For every hit, the PR must show the bound, the cleanup, or a one-line justification.

## Fixed when this skill was added (use as references)

- §1 `readExcerpt()` in `adapters/delivery.ts`: Hub responses are read up to
  `RESPONSE_EXCERPT_BYTES` and the stream is cancelled (was `res.text()` then slice).
- §5 `BoundedCache` (`adapters/bounded-cache.ts`): max size plus a TTL that evicts on
  write. Used for OIDC configurations, which are keyed by tenant-supplied issuers.
- §3 `createLlm`: one Anthropic client per process, created on first use.
- §3 `PgEventBus`: a broken relay-lock connection is released to the pool (destroyed)
  exactly once, instead of being forgotten with its pool slot.
- §1 The `Files` port streams: `put(…, body: Readable, …, { maxBytes })` and
  `get() → { stream, … }`. Its adapter (Milestone D) must keep that shape.
