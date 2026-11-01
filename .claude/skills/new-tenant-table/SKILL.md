---
name: new-tenant-table
description: Add a tenant-scoped table (platform or app template) with forced RLS, grants and isolation-test coverage. Use whenever a migration creates a table that holds tenant data.
---

# Add a tenant table

1. **Pick the migration location.**
   - Platform table → new file in `db/migrations/` named `<yyyymmddHHMMSS>_<name>.sql`.
   - App table → new file in `templates/<app>/migrations/`, and append it to the
     `migrations` list of a release in `templates/<app>/manifest.yaml` (a new release if
     the current one is merged; later releases must be expand-only).
   - Never edit a migration that is already on `main`.

2. **Write the table.** Use `-- Up Migration` / `-- Down Migration` sections.
   ```sql
   CREATE TABLE <prefix>_<name> (
     id uuid PRIMARY KEY,
     tenant_id uuid NOT NULL,
     -- …columns…
     version integer NOT NULL DEFAULT 1,          -- if rows are updated (optimistic concurrency)
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   SELECT aod_enable_tenant_rls('<prefix>_<name>');
   ```
   - App tables use the app prefix (`ord_`, `pay_`, `pos_`, `lgx_`) and have **no foreign
     keys to other apps' or platform tables**. Platform tables reference `tenant(id) ON DELETE CASCADE`.
   - Grants come from default privileges; only add `REVOKE` for append-only tables.
   - Searchable workspace entities get a generated `search tsvector … STORED` column with a GIN index,
     and `custom jsonb NOT NULL DEFAULT '{}'` if the manifest entity has `custom_fields: true`.

3. **Use it under RLS.** Read and write only inside `withTenant` (or the `ctx.tx` a command,
   consumer or saga step receives). Add `.where('tenant_id', '=', ctx.tenantId)` on deletes for
   defense in depth.

4. **Purge.** Add the table to the app's `purge()` (templates) or make sure
   `purgeTenant()` reaches it (platform: FK cascade from `tenant`).

5. **Isolation test.** Run `pnpm db:migrate`, then
   `npx vitest run --project integration apps/server/test/isolation.int.test.ts`.
   The test discovers the table; if it reports it empty for tenant A/B, extend
   `populate()` so both tenants create rows through the real code path.

6. Run `pnpm lint && pnpm typecheck && pnpm test:integration`.
