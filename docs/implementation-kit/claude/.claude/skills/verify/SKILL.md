---
name: verify
description: Run every local check the CI job runs (lint, type-check, unit, integration, SPA build, e2e) and report results. Use before committing or pushing.
---

# Verify

Run in order and stop at the first failure; fix it and re-run that step.

```bash
pnpm lint
```
```bash
pnpm typecheck
```
```bash
pnpm test
```
```bash
pnpm test:integration
```
```bash
pnpm db:migrate && pnpm --filter @aod/web build && pnpm e2e
```

Notes:
- Integration tests need PostgreSQL; `TEST_ADMIN_URL` defaults to
  `postgres://postgres:postgres@localhost:5432/postgres` and the suite recreates `aod_test`.
- E2E starts the server itself on port 3100 unless one is already running there; it needs a
  migrated `aod` database and a fresh SPA build (the server serves `apps/web/dist`).
- Report the pass/fail counts. Never skip, disable or loosen a test to get green.
