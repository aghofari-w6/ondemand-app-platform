# Kickoff prompt — Milestone B (phase 2)

Paste into a Claude Code session opened at the repository root (with this kit installed).

---

Run Milestone B of the Apps-on-Demand prototype using the `milestone` skill. Milestone A
(week 0 + phase 1) is on `main` (or in PR `proto/week0-phase1` if not merged yet). Work on
branch `proto/phase2` and open one PR against `main`. Follow every contract in `CLAUDE.md`:
one Node.js container + one PostgreSQL database, new infrastructure behind ports, external
systems only as API clients, synthetic data only, no secrets in the repo.

## Scope

**Data studio**
- Draft / publish / rollback over versioned metadata, with an impact summary before publishing.
- Field access per role (extends field rules in `authorize()`).
- Backfill jobs (pg-boss) and `CREATE INDEX CONCURRENTLY` for new indexed fields.
- PII flag on fields + AES-256-GCM field encryption through the Vault port.
- Custom entities with formulas, rollups and rules — formulas and rules use the safe
  expression language (`packages/shared/src/expr`).
- Form, list and board layouts.
- Plan limits on custom entities/fields (from `config/platform.yaml`).
- Per-tenant OpenAPI document at `/v1/openapi.json`.

**Link index** between records across apps (no FKs between apps).

**Integration Hub**
- Webhooks with HMAC signatures; retries with exponential backoff + jitter; circuit breaker;
  delivery log; DLQ with single and bulk replay that keeps the original event IDs.
- REST push.
- Kafka, Redis Streams, SFTP and cloud queues via client libraries to **tenant-owned** endpoints.
- Two-way sync with an external-ID map and conflict rules.
- Custom connector specs with code steps run in `isolated-vm` (Sandbox port).
- Private-address / SSRF check at save time and at send time.
- Write-only encrypted credentials (Vault port).
- Schema version pinning for subscribed events.
- API keys (hashed, scoped), OAuth client credentials, delegated tokens.
- Public `/v1` API.

## Done when
- Integration tests cover: HMAC signing and verification, retry/backoff/circuit breaker,
  DLQ replay keeping event IDs, SSRF blocking (save and send), encrypted credentials never
  returned, API key scopes, field encryption round-trip, draft/publish/rollback, and the
  isolation test still covers every new tenant table.
- An e2e journey for phase 2 with axe checks on the new screens.
- CI green; final report with PR link, done / not done, and deviations from this scope.
