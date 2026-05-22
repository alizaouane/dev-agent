# Consumer-side `/swarm-override` — Design

**Date:** 2026-05-22
**Status:** Approved — ready for implementation plan
**Scope:** Ship a `/swarm-override` comment handler to consumer repos via wire-up. Mirrors the engine-repo handler in `phase-pr-review.yml`.

---

## Context

The engine repo (`dev-agent` itself) has a `/swarm-override` comment handler at [phase-pr-review.yml:113](.github/workflows/phase-pr-review.yml#L113). Consumer repos don't — they run swarm-review via `dev-agent-verification.yml` but have no way to apply the override locally.

The existing enforcement runbook explicitly notes this gap:

> **In v1, consumer repos do not have a `/swarm-override` comment command.** The `/swarm-override` handler lives in `phase-pr-review.yml`, which runs only inside the dev-agent engine repository — it is not part of the workflow set that wire-up installs into consumer repos. A consumer-side override command is a planned follow-up.

This spec ships that follow-up.

## Goal

When a human reviewer on a consumer repo's `feat/dev-agent-issue-*` PR comments `/swarm-override <reason>`, a workflow in that consumer repo:

1. Verifies the head branch matches `feat/dev-agent-issue-*` and the comment author isn't a bot (`claude[bot]`, `dev-agent[bot]`, `github-actions[bot]`).
2. Removes `swarm-review:fail` and `swarm-review:concern` labels; adds `swarm-overridden` and `swarm-review:pass`.
3. Posts an audit comment with the same hidden machine-parseable anchor pattern shipped to the engine in PR #96: `<!-- dev-agent:event:b64 <base64-encoded JSON> -->`. The decoded JSON matches `lib/events.ts`'s `override.applied` shape (`ts`, `run_id`, `issue`, `phase`, `payload.{override_type, actor, reason}`).

Ships via the same wire-up + INSTALLABLE_WORKFLOWS pattern that distributed `dev-agent-verification.yml` (PR #88) and `dev-agent-tier2-smoke.yml` (PR #94).

## Non-goals

- **Mechanical unblock of branch-protection required checks.** The override flips labels and emits an audit anchor; whether that *unblocks* the PR depends on what the branch-protection rule actually requires. v1 enforcement is still "advisory" in the engine repo too (per the existing runbook). Wiring the override to also produce a passing `verification-gate` check status is v1.1 work and not in scope here — same as it is in the engine repo today.
- **Consumer-side authorization rules.** Override authority is scoped through `swarm-overridden`-allowed actors in v1.1; for now, anyone who can comment on the PR (and isn't a bot) can override. Matches the engine-repo behavior.
- **A new orchestrator state transition.** Override changes labels and posts a comment; it doesn't transition through a dev-agent state — same as the engine.

## Behavior

### Trigger

```yaml
on:
  issue_comment:
    types: [created]
```

Job-level `if:` gate:

- `github.event.issue.pull_request != null` — the comment is on a PR.
- `startsWith(github.event.comment.body, '/swarm-override')` — prefix-match so a casual mention in a longer comment doesn't fire.
- Comment author is not `claude[bot]`, `dev-agent[bot]`, or `github-actions[bot]` (additional bot exclusion vs. the engine — consumer repos commonly have other bot tooling like Vercel and CodeRabbit, but those don't author `/swarm-override` legitimately; the head-branch regex below catches anything that slips through).

### Step 1 — resolve PR + extract reason

Validates `gh pr view <PR> --jq '.headRefName' =~ ^feat/dev-agent-issue-[0-9]+$`. If not, skip (output `skip=true`). Extracts `reason` from the comment body after the literal `/swarm-override` prefix, max 500 chars, defaulting to `"(no reason given)"` if empty. Reason flows through `env:` only, never through `${{ }}` interpolation in `run:`.

### Step 2 — apply override + post audit comment with event anchor

Idempotent label flip (each `gh pr edit ... || true`). Then build the audit-event JSON with `jq -nc --arg reason "$REASON" ...` (safe escaping). Base64-encode the JSON via `base64 -w0` and embed in the audit comment under `<!-- dev-agent:event:b64 <base64> -->` — same anchor format as the engine repo's PR #96.

The `phase` field in the JSON is `dev-agent-swarm-override` (the consumer workflow file name), distinguishing it from the engine repo's `phase-pr-review` audits when scrapers walk both.

### Permissions

```yaml
permissions:
  issues: write          # label edits + comment posting
  pull-requests: write   # label edits via gh pr edit
  pull-requests: read    # gh pr view to resolve head ref
```

(Single `pull-requests: write` covers both reads and writes.)

### Harden-runner

Step 0 is `step-security/harden-runner@v2` with `egress-policy: audit`, matching every other dev-agent workflow shipped to consumers (Pillar 5).

## Distribution

Same pattern as `dev-agent-tier2-smoke.yml` (PR #94):

1. The workflow file lives at `examples/web-app-template/.github/workflows/dev-agent-swarm-override.yml`. Fresh wire-ups receive it via `WIRE_UP_FILES`.
2. An embedded copy lives in `dashboard/lib/wire-up-template.ts` as `TEMPLATE_SWARM_OVERRIDE_WORKFLOW_YML`, kept in sync via the drift test. The drift test uses the existing harness.
3. `INSTALLABLE_WORKFLOWS['swarm-override']` is added so already-wired repos can backfill via the dashboard installer (one-click).

## Files to touch

| File | Change |
|---|---|
| `examples/web-app-template/.github/workflows/dev-agent-swarm-override.yml` | new — consumer workflow |
| `tests/unit/web-app-template.test.ts` | add structural test for the new workflow |
| `dashboard/lib/wire-up-template.ts` | new `TEMPLATE_SWARM_OVERRIDE_WORKFLOW_YML` constant, add to `WIRE_UP_FILES`, add to `INSTALLABLE_WORKFLOWS` |
| `tests/unit/wire-up-template-drift.test.ts` | add drift test for the new template |
| `dashboard/__tests__/lib/actions.test.ts` | extend installer test + bump `wireUpRepo` file count from 9 → 10 |
| `docs/runbooks/2026-05-16-swarm-review-enforcement.md` | replace the "planned follow-up" wording with "now available" + usage notes |

No schema changes. No orchestrator changes. No engine-workflow changes.

## Testing

1. **Workflow structural test** (`web-app-template.test.ts`): asserts the file exists, declares the right `on:` triggers, the job-level `if:` matches the expected predicates, permissions include `pull-requests: write`, the second-job pattern (`harden-runner` first, then resolve, then apply), and the audit step uses `jq -nc` + `base64 -w0` + the `:b64` anchor.
2. **Drift test** (`wire-up-template-drift.test.ts`): asserts the embedded template matches the on-disk consumer workflow (canonical-content equality after escape decoding).
3. **Installer test** (`dashboard/__tests__/lib/actions.test.ts`): asserts `installWorkflow('swarm-override')` writes the right file with the right content; bumps `wireUpRepo`'s `createOrUpdateFileContents.toHaveBeenCalledTimes(9)` → `10` everywhere it's asserted.

No live-GitHub test. Behavior validation happens at the unit level since the GH-API surface is well-trodden via the engine handler.

## Failure modes

- **Comment author is in a different bot list (e.g., `renovate[bot]`).** The head-branch regex (`feat/dev-agent-issue-*`) catches anything that isn't a dev-agent PR. The bot exclusion is belt-and-suspenders.
- **Override applied with the gate already passing.** Idempotent labels (`|| true`); no harm.
- **Re-trigger on the same comment.** GitHub deduplicates by `comment.id`; `issue_comment.created` only fires once per comment. Re-comment with the same body fires again — re-runs are idempotent.
- **`-->` inside `reason`.** Solved by base64 encoding — same fix as PR #96 for the engine.
- **Pre-#96 engine still on `<!-- dev-agent:event {json} -->` format** (no base64): The consumer ships with the base64 form from day one, so future scrapers must accept BOTH the engine's pre-#96 anchor and the post-#96 `:b64` anchor. Easy regex-or: `<!-- dev-agent:event(?::b64)? (.+?) -->`.

## Rollout

The override is shipped via `INSTALLABLE_WORKFLOWS` so each canary repo (`caliente-booking-app`, `whatsapp-console`, `social-media-content`) can backfill via the dashboard's one-click install. New wire-ups receive it automatically.

No branch-protection or orchestrator changes are needed to start collecting audit anchors. The "make the override mechanically unblock the verification-gate check" work is v1.1 and out of scope here — same state as the engine repo today.

## Out of scope

- Mechanical unblock of `verification-gate` (v1.1 work, parallel between engine and consumer).
- Per-repo actor allowlists for override authority (v1.1).
- Anchor-scraper CLI that materializes `.dev-agent/events/*.jsonl` (separate spec — the data shape is consistent across PR #96 and this PR, so a single scraper covers both).
- Dashboard surfacing of override events (depends on the scraper CLI).
