---
description: One-time bootstrap of dev-agent in a fresh consumer repo (creates .dev-agent.yml, 6 GH workflow wrappers, and canonical state labels)
argument-hint: "(no args)"
allowed-tools: Read Write Bash Glob Grep
---

# /dev-agent-init

Bootstraps the current repo as a dev-agent consumer.

## What this does

1. **Detects stack** by reading `package.json`, `supabase/config.toml`, `next.config.*`, `tsconfig.json`, etc., to infer reasonable defaults for `commands.test`, `commands.build`, `commands.typecheck`, and the staging-vs-no-staging branch model.
2. **Generates `.dev-agent.yml`** at the repo root, merging the inferred values over `schema/defaults.yml` (loaded from the installed plugin). Preserves any existing `.dev-agent.yml` — never overwrites.
3. **Drops 6 thin GitHub workflow wrappers** under `.github/workflows/dev-agent-*.yml`. Each is a 3–5 line `uses: alizaouane/dev-agent/.github/workflows/phase-<X>.yml@v1` reference with the issue number / config path passed through.
4. **Creates the canonical label vocabulary** via `gh label create` — 12 state labels, 4 kind labels, 4 priority labels (per `schema/label-vocabulary.yml`).
5. **Opens a PR titled "chore: dev-agent onboarding"** for human review of the generated config + wrappers before merge.

## Steps

1. Confirm we are at a git repo root: `git rev-parse --show-toplevel`. Bail if not, or if not on a clean working tree.
2. Refuse if `.dev-agent.yml` already exists, unless invoked with `--force` (suggest the user run `/develop` instead).
3. Read stack hints; build a starter config in memory.
4. Write `.dev-agent.yml` and the 6 wrappers.
5. Run `gh label create` for each canonical label (idempotent: skip on `already exists`).
6. Open the onboarding PR via `gh pr create`.

## What this does NOT do

- Does not install the plugin (the user does that with `claude plugin install`).
- Does not bypass the human review gate — the generated PR is the gate.
- Does not modify any source code or existing workflows.

## Failure modes

- Working tree dirty → abort with a message; tell the user to commit/stash first.
- `gh` CLI missing or not authenticated → abort with the install/auth command.
- Existing `.dev-agent.yml` without `--force` → abort, suggest `/develop` for the next feature.

## Implementation note

This command implementation is an MD-only entry point in Plan 1b. The actual stack-detection + config-templating logic is invoked via a follow-up TypeScript helper (planned in 1c) and the per-stack templates ship there. Until 1c lands, running this command emits a "stub: not yet wired" message and exits with code 0.
