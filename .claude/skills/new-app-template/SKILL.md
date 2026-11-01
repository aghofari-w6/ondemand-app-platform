---
name: new-app-template
description: Scaffold a new provisionable app template (package, manifest, migrations, module, registry, channels, lint rule, UI route). Use when adding an app beyond Ordering, Payments, POS and Logistics.
---

# Add an app template

1. **Package** `templates/<app>/`: copy `package.json` and `tsconfig.json` from an existing
   template, rename to `@aod/template-<app>`. Dependencies: `@aod/shared`, `kysely`, `zod` only.
2. **Manifest** `templates/<app>/manifest.yaml`: `id`, `name`, `description`, `package`,
   `version`, `releases` (with `channel` and `migrations`), `dependencies`, `entities`
   (resource `<app>::<Type>`, `read_permission` if not `<app>:<entity>.read`), `events`
   (`publishes`, `consumes` with a `capability`), `commands` (each with `may_emit`),
   `views`, `workflows.templates`, `analytics.metrics`, `assistant.tools` (risk tiers),
   `telemetry`, `permissions`, `config`. Validate with `pnpm test`.
3. **Migrations** `templates/<app>/migrations/` — follow the `new-tenant-table` skill.
4. **Module** `templates/<app>/src/index.ts` exporting a default `TemplateModule`:
   `id`, `dir`, `commands`, optional `consumers` / `queries` / `inbound` / `demoSeed`,
   and `seed`, `purge`, `health`. Import nothing from other templates or the server.
5. **Register it:**
   - `apps/server/package.json` dependency `@aod/template-<app>: workspace:*`, then `pnpm install`.
   - `apps/server/src/platform/templates.ts` → add to `TEMPLATES`.
   - `config/platform.yaml` → `channels.<app>` and any `capabilities` it takes part in.
   - `eslint.config.js` → add the app to `TEMPLATES` so the cross-template ban covers it.
6. **Migrate and test:** `pnpm db:migrate`, then `pnpm test:integration` (the isolation test
   must see the new tables populated — extend `populate()` and the plan's slot count if needed).
7. **UI:** a nav entry in `apps/web/src/components/shell.tsx`, a route in `router.tsx`, and a
   screen built from `AppGate` + `Workspace` + `Detail` (`components/workspace.tsx`).
   Add the screen to an e2e test with `expectAccessible`.
