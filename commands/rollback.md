---
description: Trigger phase-rollback workflow against a shipped feature (reverts merge, redeploys, runs paired _rollback.sql)
argument-hint: "<issue#>"
allowed-tools: Read Bash
---

# /rollback

Reverts a shipped feature. Hooks into the consumer's `phase-rollback.yml` workflow.

## What the workflow does (handled in Plan 1c)

1. Find merge commit via PR linked from the issue.
2. `git revert -m 1 <merge-sha>` → push to staging branch (or default if no staging).
3. Open a release PR for the revert.
4. After merge: redeploy artifacts via consumer's deploy skills.
5. Run paired `_rollback.sql` migrations if any.
6. Run prod smoke.
7. Relabel `state:rolled-back`, comment timeline.

## Steps (in this slash command)

1. Validate `<issue#>` exists and is in `state:done` or `state:promoting` or `state:staging-deployed`. Reject otherwise.
2. Confirm via prompt: "Rollback issue #<n> ('<title>')? This will revert the merge commit and redeploy. [y/N]"
3. On confirmation, dispatch the workflow: `gh workflow run phase-rollback.yml -f issue_number=<n>`.
4. Comment on issue: "🔁 Rollback initiated by <gh-user> at <ISO-timestamp>."
5. Watch the run via `gh run watch` until terminal status; report.

## Failure modes

- Issue not in a rollback-eligible state → reject with the eligible list.
- No `phase-rollback.yml` workflow registered in this repo (consumer hasn't onboarded properly) → tell the user to run `/dev-agent-init`.
- Workflow dispatch fails → surface the `gh` error.

## Implementation note

Slash command structure live in 1b. The dispatched workflow `phase-rollback.yml` is stubbed in 1c. Triggering it before 1c will fail with a clear "workflow not found" message — that's acceptable because consumers cannot meaningfully use rollback before workflows ship.
