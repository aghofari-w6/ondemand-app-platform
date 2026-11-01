---
name: new-app-command
description: Add or change a command in an app template (manifest entry, permission, may_emit, handler, tests). Use for any new write operation in Ordering, Payments, POS, Logistics or a new app.
---

# Add an app command

1. **Manifest** (`templates/<app>/manifest.yaml`):
   - Add the command under `commands` with `name: <entity>.<verb>`, `description`,
     `permission`, `entity` and `may_emit` (explicit, `[]` if it emits nothing).
   - Every event in `may_emit` must be in `events.publishes` and in the entity's `events`.
   - Add a new permission under `permissions` if needed (`<app>:<entity>.<verb>`, with a
     `level`: read / operate / manage / admin — this decides which role presets get it).
   - If the assistant may call it, add an `assistant.tools` entry with a risk tier (`low`/`high`).

2. **Handler** (`templates/<app>/src/index.ts`), in `commands`:
   ```ts
   'order.ship': defineCommand({
     input: z.object({ id: z.uuid(), version: z.int().positive() }),
     async handle(ctx, input) {
       const row = await updateVersioned(ctx.tx, 'ord_order', input.id, input.version, { status: 'shipped' });
       ctx.emit({ type: 'order.status_changed', aggregateType: 'order', aggregateId: input.id, data: { … } });
       return { id: input.id, version: row.version };
     },
   }),
   ```
   - Validate everything with Zod; throw `CommandError` / `invalid()` / `conflict()` / `notFound()`.
   - Writes that update existing rows use `updateVersioned` (409 on stale version).
   - Custom fields go through `ctx.validateCustom(entity, values, existing)`.
   - Respect field rules: reject writes to fields in `readonlyFields(ctx.decision)`.
   - Do not write the outbox or audit yourself — `executeCommand` does both.
   - Return `created: true` when a client-supplied id creates a new record (201).

3. **Catalog check.** The server refuses to start if a manifest command has no handler or a
   handler is undeclared. Run `pnpm test` (manifest validator tests) and start the server once.

4. **Tests.** Add a case to `apps/server/test/commands.int.test.ts` (or a new
   `*.int.test.ts`) covering: happy path + emitted event, permission denial for a weaker
   role, 409 on stale version, and idempotent replay if relevant.

5. **UI.** Gate buttons with `allowed(meta, '<command>')` and call `runCommand(app, command, input)`.
