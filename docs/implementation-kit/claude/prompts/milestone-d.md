# Kickoff prompt — Milestone D (phase 4: Dashboards, Reports, Data governance)

Paste into a Claude Code session opened at the repository root.

---

Run Milestone D of the Apps-on-Demand prototype using the `milestone` skill. The scope,
acceptance journey (J4) and risks are in `docs/implementation-kit/plan-phases-3-6.md`,
section 5. Read that section and section 2 (rules that carry over) first, and do the
carry-over items assigned to Milestone D in section 3.

Work on branch `proto/phase4` from the latest `main` and open one PR against `main`. Follow
every contract in `CLAUDE.md`: one Node.js container + one PostgreSQL database, new
infrastructure behind ports with one prototype adapter, external systems only as API
clients, synthetic data only, no secrets in the repo.

Before writing code, check section 8 ("Decisions needed") for any open decision that
affects this milestone. If one is still open, ask me instead of guessing.

## Done when
- Integration tests cover every contract this milestone adds, and the isolation test
  still populates every tenant table.
- The J4 e2e journey passes, with an axe check on every new screen.
- The placeholder screens this milestone replaces are gone from `PLANNED` in
  `apps/web/src/screens/admin.tsx`.
- The `contract-reviewer` agent has reviewed the diff and its confirmed findings are fixed.
- CI is green. Final report: PR link, done / not done, and deviations from the plan.
