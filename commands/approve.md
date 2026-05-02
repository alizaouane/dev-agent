---
description: Advance an issue past one of the 3 dev-agent gates (spec-ready → implementing → ready-to-promote → promoting)
argument-hint: "<issue#> [--promote]"
allowed-tools: Read Bash Grep
---

# /approve

Advances a feature issue to the next state. This is the human-in-the-loop confirmation at one of the three gates.

## Gate transitions

| Current state | Action | Result |
|---|---|---|
| `state:spec-ready` | `/approve <issue#>` | → `state:implementing` (triggers `phase-implement.yml`) |
| `state:pr-review` | `/approve <issue#>` (after PR is merged manually) | → `state:staging-deployed` (triggers `phase-staging-deploy.yml`) |
| `state:ready-to-promote` | `/approve <issue#> --promote` | → `state:promoting` (triggers `phase-promote-to-prod.yml`) |

## Steps

1. Parse `<issue#>` and optional `--promote` flag.
2. Read current state label from the issue.
3. Validate the transition is legal (per the table). Bail with a clear error if not.
4. Apply label change via `gh issue edit`. The label-change webhook triggers the corresponding phase workflow.
5. Comment on the issue: "🛂 Approved at <gate-name> by <gh-user> at <ISO-timestamp>."

## Safety

- Rejects `--promote` without `<issue#>` to prevent accidental promotion.
- Rejects approval when state is one of `state:blocked`, `state:abandoned`, `state:rolled-back`, `state:done` — emits "issue not in a gateable state."
- Idempotent: re-running on an already-advanced issue is a no-op with a comment.

## Failure modes

- Bad transition → abort, no labels touched.
- `gh` auth missing → bail.

## Implementation note

Fully wired in 1b — labels are applied. The downstream workflows (`phase-implement.yml`, etc.) are stubbed in 1c, so the label flip will fire workflows that are stub-no-ops until 1c.
