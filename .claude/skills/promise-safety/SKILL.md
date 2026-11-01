---
name: promise-safety
description: Promise and graceful-error safety for this codebase. Use whenever writing or editing TypeScript/JavaScript that creates promises, uses .then/.catch/.finally, fire-and-forget calls, setTimeout/setInterval callbacks, event listeners with async handlers, retry/refresh helpers, worker loops, graceful shutdown (main.ts), SSE routes, cleanup in finally blocks, or React event handlers. Prevents unhandled rejections (which kill the whole server process) and silently swallowed errors.
---

# Promise and graceful-error safety

Node treats a rejected promise with no handler as `unhandledRejection` and **exits the
process**. Here one process runs the API, the event bus, the Hub deliverer, the workflow
runner and the pg-boss workers, so one unhandled rejection takes all of them down.
AI-written `.finally()` chains and fire-and-forget calls are a common cause.

This is enforced by lint, not just by review (`eslint.config.js`, type-aware):
- `@typescript-eslint/no-floating-promises` checks server, shared, templates and e2e code
  with `ignoreVoid: false`: `void p` does **not** count as handling there.
- In the web app, `void` marks a deliberate fire-and-forget, such as a navigation or a
  cache invalidation (`ignoreVoid: true`).
- `@typescript-eslint/no-misused-promises` checks every place a promise-returning
  function is passed where a void callback is expected (`setTimeout`, `process.on`,
  props). JSX attributes are exempt, because React Aria's `onPress`/`onSubmit` accept
  async handlers.

`pnpm lint` fails on any of these. Never silence them with `void`,
`// eslint-disable` or an empty `.catch`. Fix the handling instead.

## Forbidden

```ts
// `.finally()` returns a NEW promise. Callers who catch `promise` do not catch that
// second promise: if cleanup rejects, Node emits unhandledRejection even though the
// original `.catch()` ran.
promise.finally(() => refresh());
promise.finally(cleanup);
app.close().then(…).catch(…).finally(() => process.exit(0));

// Fire-and-forget with no handler.
refresh();
void queueSomething();                              // server: still unhandled

// An async function handed to a void callback: its rejection has no owner.
setTimeout(loop, ms);                               // loop is async
process.on('SIGTERM', shutdown);                    // shutdown is async
setTimeout(() => loop().catch(log), ms);            // the arrow still returns a promise

// Swallowing.
promise.catch(() => {});
promise.catch(() => undefined);
```

Do not attach `.finally()` unless you also handle **the promise `.finally()` returns**.

## Required patterns

**Prefer `async`/`await`.** One `try/catch/finally` then owns the same promise:

```ts
async function run() {
  try {
    return await doWork();
  } catch (e) {
    p.log.error({ err: String(e) }, 'doWork failed');
    throw e;
  } finally {
    // Cleanup must not fail the caller: log its failure, never swallow it.
    await cleanup().catch((e: unknown) => p.log.warn({ err: String(e) }, 'cleanup failed'));
  }
}
```

**Promise chains:** attach fulfillment and rejection handling on the **same** chain, and
return or catch that chain:

```ts
function withCleanup<T>(promise: Promise<T>): Promise<T> {
  return promise.then(
    (value) => Promise.resolve(cleanup()).then(() => value),
    (error) =>
      Promise.resolve(cleanup()).then(
        () => Promise.reject(error),
        (cleanupError) => {
          log.warn({ err: String(cleanupError) }, 'cleanup failed after rejection');
          return Promise.reject(error);
        },
      ),
  );
}
withCleanup(refresh()).catch((e) => log.error({ err: String(e) }, 'refresh failed'));
```

**If `.finally()` is unavoidable**, handle what it returns:

```ts
return promise.finally(() => cleanup()).catch((e) => {
  log.error({ err: String(e) }, 'operation or cleanup failed');
  throw e;
});
```

## Fire-and-forget (server, workers, tests)

Never start a promise and ignore it. Attach rejection handling:

```ts
refresh().catch((e) => p.log.error({ err: String(e) }, 'refresh failed'));
```

**Timer and listener callbacks** use a block body, so nothing returns a promise to the
caller:

```ts
// worker loops: HubDeliverer, WorkflowRunner, PgEventBus, the index builder
private readonly loopFailed = (e: unknown) => this.p.log.error({ err: String(e) }, 'hub loop failed');
…
this.timer = setTimeout(() => {
  loop().catch(this.loopFailed);
}, interval);
loop().catch(this.loopFailed);
```

**Cleanup that must not fail the operation** is logged, never swallowed. Example:
`createDelivery({ log })` in `adapters/delivery.ts` logs a failing Redis/SFTP close or
response cancel, and the delivery still succeeds.

## Errors are reported, not hidden

- **Server:** log with the platform `Logger` (`p.log.error` / `p.log.warn`, structured:
  `{ err: String(e), …ids }`). Adapters without `p` take a `log` callback.
- **SSE / streaming routes** send an `event: error` and end the stream. Never map a
  failure to "not found": a DB error is not a missing record (see
  `/api/provisioning/runs/:id/stream`).
- **Web:** a failed user action is shown to the user (an `Alert`; see `VoidSaleButton`
  in `screens/pos.tsx`). Advisory background work (live validation) may keep the last
  result, but logs with `console.warn` and a comment saying why.
- An empty `.catch(() => {})` / `.catch(() => undefined)` is never allowed. Only a
  deliberate fallback value with a comment (`.catch(() => null) // optional: …`) passes
  review, and only when the caller treats `null` correctly.

## Graceful shutdown (`apps/server/src/main.ts`)

- One `async function shutdown(signal)` with one `try/catch`: close the HTTP server, stop
  the platform (workers, event bus, jobs, pool) and OpenTelemetry, then
  `process.exit(0)`. On failure, log it and `process.exit(1)`.
- A `stopping` flag makes a second signal a no-op.
- Register handlers with a block body and a final safety net:
  `process.on(signal, () => { shutdown(signal).catch(() => process.exit(1)); })`.
- Never chain `.finally(() => process.exit(…))` onto a chain that already has `.catch()`.
- Do not add `process.on('unhandledRejection')` handlers as a substitute for handling
  promises. Fix the missing handler instead.

## Checklist before finishing JS/TS edits

- `pnpm lint` passes (`no-floating-promises`, `no-misused-promises`).
- There is no `.finally()` whose returned promise is unused.
- Every background promise has a `.catch` that logs, or is awaited inside `try/catch`.
- Timer and listener callbacks have block bodies and never return a promise.
- Shutdown, refresh and retry helpers share one handled promise with their callers.
- Cleanup errors are logged and do not create a second unhandled rejection.
- No empty `.catch`. User-facing failures are shown, not dropped.
