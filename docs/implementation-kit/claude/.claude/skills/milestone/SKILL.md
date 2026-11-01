---
name: milestone
description: Run a prototype milestone end to end — branch, scope check, build, tests, PR and report. Use when starting or finishing a milestone (B, C, …) of the Apps-on-Demand plan.
---

# Run a milestone

1. **Start clean.** `git fetch origin main && git checkout -b proto/<milestone> origin/main`.
   If the previous milestone's PR is not merged yet, branch from its branch and say so in the PR.
2. **Scope.** Restate the milestone's scope as a checklist (task list). Build only what is
   listed; anything else goes in "not done / next".
3. **Contracts first.** For each new table, command, event, port or consumer, follow the
   matching skill (`new-tenant-table`, `new-app-command`, `new-app-template`) and the
   contracts in `CLAUDE.md`. New infrastructure goes behind a port with one prototype
   adapter; external services are API clients only.
4. **Tests as you go.** Integration tests for every contract-bearing change; extend the e2e
   suite with the milestone's acceptance journey and an `expectAccessible` call per new screen.
5. **Verify** with the `verify` skill before every push.
6. **Ask for a review** from the `contract-reviewer` agent on the full diff against `main`
   and fix what it confirms.
7. **PR** against `main`, titled `Milestone <X>: …`. Body: what it does, tests, and a
   "Deviations / decisions" section. End with the attribution line from `CLAUDE.md`.
   Watch CI until green.
8. **Report:** PR link, done, not done, deviations from the spec.
