---
name: orchestrator
description: Use to advance a dev-agent feature issue through its state machine — knows the canonical state transitions, gate semantics, and which workflow runs at each transition.
user-invocable: false
---

# orchestrator

Internal skill that encodes the dev-agent state machine. Slash commands and reusable workflows call into this skill to know "what is the legal next state?" and "what side effects fire on transition?"

## State machine (canonical)

```
state:proposed (kind:scout-proposal only)
  → user accept via /proposals
  → state:scoping
state:scoping
  → /develop runs spec brainstorm
  → state:spec-ready    ◄── GATE 1
state:spec-ready
  → /approve <n>
  → state:implementing  → fires phase-implement.yml
state:implementing
  → workflow opens PR
  → state:pr-review     ◄── GATE 2
state:pr-review
  → user merges PR + /approve <n>
  → state:staging-deployed → fires phase-staging-deploy.yml
state:staging-deployed
  → smoke passes (auto)
  → state:ready-to-promote ◄── GATE 3
state:ready-to-promote
  → /approve <n> --promote
  → state:promoting → fires phase-promote-to-prod.yml
state:promoting
  → prod smoke passes
  → state:done (issue closed)
```

Failure / off-ramp states (reachable from any `*ing` state):

- `state:blocked` — set by phase workflow on cap hit, drift violation, ambiguous failure.
- `state:abandoned` — set by `/abandon`.
- `state:rolled-back` — set by `phase-rollback.yml` on completion.

## Hotfix path

If `.dev-agent.yml.hotfix.enabled = true` and issue carries `kind:hotfix`:
- `/develop` skips spec gate (when `hotfix.skip_spec: true`), goes straight to `state:implementing`.
- Drift check still applies unless `hotfix.skip_drift_check: true`.

## Transition table (consumed programmatically)

| From | Trigger | To | Side effect |
|---|---|---|---|
| `state:proposed` | `/proposals` accept | `state:scoping` | comment on issue |
| `state:scoping` | `/develop` (auto) | `state:spec-ready` | spec written; telemetry comment |
| `state:spec-ready` | `/approve` | `state:implementing` | dispatch `phase-implement.yml` |
| `state:implementing` | workflow PR open (auto) | `state:pr-review` | PR opened; comment with PR link |
| `state:pr-review` | `/approve` (PR must be merged) | `state:staging-deployed` | dispatch `phase-staging-deploy.yml` |
| `state:staging-deployed` | smoke pass (auto) | `state:ready-to-promote` | telemetry comment |
| `state:ready-to-promote` | `/approve --promote` | `state:promoting` | dispatch `phase-promote-to-prod.yml` |
| `state:promoting` | prod smoke pass (auto) | `state:done` | issue closed; final telemetry |

## Files this skill cooperates with

- `lib/parse-config.ts` — reads `.dev-agent.yml`
- `lib/telemetry.ts` — formats per-phase comments
- `skills/notify/SKILL.md` — fan-out at every transition
- `skills/drift-check/SKILL.md` — pre-PR drift gate

## How callers use this skill

Slash commands and workflows do not directly include this file's content — they rely on the *registry* it documents. The actual transition enforcement is implemented in TypeScript (planned for Plan 1c — `lib/orchestrator.ts`) using the table above as a single source of truth. Until then, this SKILL.md serves as the canonical reference for human implementers and reviewers.
