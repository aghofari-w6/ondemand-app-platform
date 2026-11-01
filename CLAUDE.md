# Apps-on-Demand — guide for Claude

Multi-tenant platform prototype: tenants provision apps (Ordering, Payments, POS,
Logistics) from YAML manifests. Bare-minimum infrastructure: **one Node.js container +
one PostgreSQL database**. Anything that would later be Kafka, OpenSearch, ClickHouse,
Temporal, Keycloak, Svix, Redis or S3 is a table or an in-process module behind a port.
Synthetic data only. Never commit secrets or keys.

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Lint (incl. cross-template import ban) | `pnpm lint` |
| Type-check (root + every package) | `pnpm typecheck` |
| Unit tests | `pnpm test` |
| Integration tests (fresh `aod_test` DB, needs Postgres) | `pnpm test:integration` |
| One test file | `npx vitest run --project integration apps/server/test/<file>.int.test.ts` |
| Migrate (owner role) | `pnpm db:migrate` |
| Demo tenant "Acme Coffee" | `pnpm seed` (`-- --reset` to re-create) |
| Build SPA + run server on :3000 | `pnpm --filter @aod/web build && pnpm start` |
| Dev (API :3000, Vite :5173) | `pnpm dev` |
| E2E (J1, phase 2, J3) + axe | `pnpm e2e` (needs a migrated `aod` DB and a built SPA) |
| Redis for the Streams test | `redis-server --daemonize yes` (or set `TEST_REDIS_URL`) |

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` before every
commit. The server runs TypeScript directly on Node 24 (type stripping): use `.ts`
import extensions and erasable syntax only (no enums, namespaces or parameter properties).

## Layout

```
apps/server/src/
  db/          database.ts (withTenant / withoutTenant), migrate.ts
  ports/       port interfaces — call sites depend on these, never on adapters
  adapters/    one prototype adapter per port (pg event bus, pg-boss, vault, OIDC/SAML, …)
  platform/    catalog, commands (write pipeline), outbox, audit, consumers,
               provisioning (sagas), tenants (lifecycle), workspace (list/detail), fields,
               datastudio (metadata versions), records (custom entities), links, hub,
               maintenance (backfills, index builder), openapi, workflows/ (definitions,
               engine, dry run), approvals, trace
  http/        app.ts (hooks, errors, auth helpers) + routes/
apps/web/src/  React SPA: components/ (ui, shell, workspace), screens/, lib/ (api, offline)
packages/shared/src/  envelope, manifest (schema + validator), permissions (authorize),
               template (TemplateModule contract), api (Zod request schemas), expr/
templates/<app>/  manifest.yaml, migrations/*.sql, src/index.ts
db/migrations/    platform migrations (roles, RLS helper, platform tables, definer functions)
config/platform.yaml  plans, trial slots, release channels, capability rules
e2e/               Playwright
```

## Contracts you must not break

1. **Tenant isolation.** Every tenant table has `tenant_id` and
   `SELECT aod_enable_tenant_rls('<table>');` in the migration that creates it. Access
   tenant data only inside `p.database.withTenant(tenantId, tx => …)`. Never connect as
   the owner role at runtime, never add `BYPASSRLS`. Cross-tenant needs go through a
   narrow `SECURITY DEFINER` function, granted to `aod_app` only.
   `apps/server/test/isolation.int.test.ts` discovers tables automatically: a new tenant
   table must get rows for both tenants in its `populate()`; a new global table must be
   added to `GLOBAL_TABLES` with a reason.
2. **Outbox.** Every write emits its events through the outbox in the same transaction:
   app commands via `ctx.emit()`, platform writes via `recordChange()`
   (`platform/record.ts`). Never publish an event any other way. Envelope fields are
   fixed (`packages/shared/src/envelope.ts`).
3. **Writes.** App writes go through `executeCommand()` (`platform/commands.ts`):
   authorize → `Idempotency-Key` → Zod → handler → outbox + audit. Updates use
   `updateVersioned()` (409 on a stale `version`). A handler may only emit events in its
   command's `may_emit`.
4. **Authorization.** Use `authorize(principal, action(id), resource)` or the
   `requirePermission()` route helper. New permissions go in the manifest's
   `permissions` (apps) or `PLATFORM_PERMISSIONS` (platform). Respect field rules
   (`maskFields`, `readonlyFields`).
5. **Audit** is append-only; the app role has no UPDATE/DELETE on `audit_log`.
6. **Manifests** must stay valid (`validateManifest`): every shipped entity's events in
   `events.publishes`, every command with `may_emit` and a declared permission. Releases
   after the first may only contain expand-only migrations.
7. **No cross-app coupling.** Templates import `@aod/shared` only (ESLint enforces it),
   have no foreign keys to other apps, and react to other apps through
   `events.consumes` gated by a capability rule in `config/platform.yaml`. Consumers must
   be idempotent (they may be re-run by a backfill).
8. **Migrations are immutable once merged.** Add a new file; never edit an applied one.
   DDL runs only in the migrate script (owner role), never at runtime.
9. **Expression language** (`packages/shared/src/expr`) is the only way to evaluate
   user-written conditions or formulas. Never use `eval`/`Function`.
10. **Ports.** New infrastructure needs go behind a port in `apps/server/src/ports` with
    one prototype adapter. Stubs only for ports unused in the current milestone.
11. **Data model changes go through Data studio** (`platform/datastudio.ts`): never write
    `field_definition` or `field_access_rule` directly outside a publish. Custom record
    writes go through `executeRecordWrite()` (`platform/records.ts`). PII values are
    encrypted with `encryptPii()` and never put into event data.
12. **Outbound calls go through the `Webhooks` port** (`adapters/delivery.ts`), which
    enforces the SSRF policy (`adapters/ssrf.ts`). Never `fetch` a tenant-supplied URL
    directly. Tenant code runs only in the `Sandbox` port (isolated-vm). Credentials are
    stored encrypted and never returned by an API.
13. **Workflows** act only through `executeCommand()` / `executeRecordWrite()` (inside the
    node's transaction, idempotency key `wf:<node run>`) and the outbox, with the run's
    `workflowHop`/`workflowChain`; outbound sends go through the Hub and notifications
    through a `workflow.notification` outbox event. Their principal is the service role
    capped at publish (`servicePrincipal()`), never `System`; run data shown to a viewer
    is masked with `redact()`.

## Conventions

- Zod 4 for every external input (`parse()` in routes); errors are `CommandError(status, code, message)`.
- Kysely with `Kysely<any>`; SQL identifiers only from manifests or constants, never from user input.
- UI: React Aria Components through `apps/web/src/components/ui.tsx`; design tokens in
  `styles.css` (ground `#F6F7F9`, text `#1B1F27`, secondary `#5F6672`, border `#E3E6EB`,
  accent `#2856D9`); controls at least 44px (`min-h-11`); every input has a visible label;
  new screens must pass the axe check (add them to an e2e test).
- Screens not built yet show `PlannedScreen` naming their package and milestone
  (`apps/web/src/screens/admin.tsx`, `PLANNED`).
- Server code that touches bodies, streams, timers, workers, caches, clients, retries or
  unbounded loops follows the `memory-safe-code` skill (run its detection greps on review).
- Promises follow the `promise-safety` skill: every promise is awaited, returned or caught
  with a log; no unhandled `.finally()`, no empty `.catch`. `pnpm lint` enforces it.
- Claude API model id comes from config (`CLAUDE_MODEL`, default `claude-opus-5-5`); use the `Llm` port.

## Git

- One branch and one PR per milestone (`proto/<milestone>`), against `main`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- In the PR and final report: what's done, what's not, and every deviation from the spec.
