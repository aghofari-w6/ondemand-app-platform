# Claude starter pack

Everything Claude Code needs to keep building the Apps-on-Demand prototype the way
Milestone A was built: project memory, guardrails, task skills, a contract reviewer and
kickoff prompts for the next milestones.

## Contents

| Path | What it is |
| --- | --- |
| `CLAUDE.md` | Project memory: commands, layout, the contracts that must not break, UI and git conventions. |
| `.claude/settings.json` | Pre-approved check commands, denied reads of `.env` and force-pushes, and the migration guard hook. |
| `.claude/hooks/guard-migrations.mjs` | Blocks edits to migration files already on `main` (add a new migration instead). |
| `.claude/skills/new-tenant-table/` | Checklist for any table holding tenant data: RLS, purge, isolation-test coverage. |
| `.claude/skills/new-app-command/` | Manifest entry, permission, `may_emit`, handler, tests, UI gating. |
| `.claude/skills/new-app-template/` | Scaffolding a fifth app: package, manifest, registry, channels, lint rule, UI. |
| `.claude/skills/milestone/` | Branch → scope checklist → build → verify → review → PR → report. |
| `.claude/skills/verify/` | Runs exactly what CI runs (`/verify`). |
| `.claude/agents/contract-reviewer.md` | Read-only subagent that reviews a diff against the contracts. |
| `prompts/milestone-b.md` | Kickoff for Milestone B (phase 2) — done. |
| `prompts/milestone-c.md` … `milestone-f.md` | Kickoffs for phases 3–6, pointing at `../plan-phases-3-6.md`. |
| `prompts/next-milestone-template.md` | Fill-in template for anything beyond the plan. |

## Install

The kit lives here so it can be reviewed before it changes how Claude behaves in the repo.
To activate it, copy it to the repository root (run from the root):

```bash
cp docs/implementation-kit/claude/CLAUDE.md . && cp -r docs/implementation-kit/claude/.claude .
```

Claude Code then loads `CLAUDE.md` automatically, offers the skills (also as
`/verify`, `/milestone`, …), can delegate to the `contract-reviewer` agent, and runs the
migration guard on every edit. The hook needs Node.js on the machine running Claude Code.

## Use

- **Start a milestone:** open Claude Code at the repo root and paste the next
  `prompts/milestone-<x>.md` (the plan for phases 3–6 is `../plan-phases-3-6.md`).
- **Before pushing:** ask for `/verify`, then "have the contract-reviewer agent review the diff".
- **Adding things:** mention the task ("add a tenant table for …", "add a command to POS …")
  and Claude picks the matching skill.

## Keeping it current

When a milestone changes a contract, a command or the layout, update `CLAUDE.md` (here, and
the copy at the root if installed) in the same PR.
