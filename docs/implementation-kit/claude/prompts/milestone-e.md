# Kickoff prompt — Milestone E (phase 5: Assistant, Inbox, Channels, Bot Studio)

Paste into a Claude Code session opened at the repository root.

---

Run Milestone E of the Apps-on-Demand prototype using the `milestone` skill. The scope,
acceptance journey (J5) and risks are in `docs/implementation-kit/plan-phases-3-6.md`,
section 6. Read that section and section 2 (rules that carry over) first, and do the
carry-over items assigned to Milestone E in section 3.

Work on branch `proto/phase5` from the latest `main` and open one PR against `main`. Follow
every contract in `CLAUDE.md`: one Node.js container + one PostgreSQL database, new
infrastructure behind ports with one prototype adapter, external systems only as API
clients, synthetic data only, no secrets in the repo.

Before writing code, check section 8 ("Decisions needed") for any open decision that
affects this milestone. If one is still open, ask me instead of guessing.

## Done when
- Integration tests cover every contract this milestone adds, and the isolation test
  still populates every tenant table.
- The J5 e2e journey passes, with an axe check on every new screen.
- The placeholder screens this milestone replaces are gone from `PLANNED` in
  `apps/web/src/screens/admin.tsx`.
- The `contract-reviewer` agent has reviewed the diff and its confirmed findings are fixed.
- CI is green. Final report: PR link, done / not done, and deviations from the plan.
