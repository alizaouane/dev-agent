# Swarm-review enforcement + canary rollout

**Date:** 2026-05-16
**Applies to:** Consumer repos using `dev-agent-verification.yml` (Pillar 2)
**Status:** Canary phase — advisory, not yet a blocking check

---

## What swarm-review is

Swarm-review is dev-agent's independent code-review gate. It runs three specialized reviewers — `spec-compliance`, `regression-guard`, and `security-scout` — as read-only inference passes over the same frozen evidence bundle for every PR. The evidence bundle is assembled by `phase-evidence-collector.yml` and consists of the PR diff plus normalized output from the deterministic scanners: gitleaks (secret detection), Semgrep (static analysis), npm audit (dependency vulnerabilities), and an AST diff. All three reviewers receive exactly the same inputs and do not coordinate with each other; they do not write code or modify any files.

After all three reviewers emit their structured JSON verdicts, `lib/swarm-review.ts` (invoked via `lib/cli/swarm-aggregate.ts`) combines them deterministically using a weighted-vote algorithm. The aggregated result is posted as a single PR comment and applied as a GitHub label (`swarm-review:pass`, `swarm-review:concern`, or `swarm-review:fail`). When the aggregate verdict is `swarm-fail`, the workflow exits non-zero, which causes the GitHub check to go red — branch protection rules can then be configured to treat that red check as a merge blocker.

The gate runs automatically on every PR whose head branch matches `feat/dev-agent-issue-*` and originates from the same repository (not a fork). The trigger is `dev-agent-verification.yml`, which must be present in the consumer repo's `.github/workflows/` directory. You can install it from the dev-agent dashboard's repo workspace page under the "Verification gates" card, or it ships automatically when a new repo is wired up to dev-agent.

---

## Canary phase

**Do not add swarm-review to branch protection yet.** Run it in advisory mode for at least 20 dev-agent PRs before making the check required. The purpose of the canary is to measure the gate's signal quality — a gate that fires on false positives and trains people to reflexively override it provides no safety value once it becomes blocking.

For each PR that runs the gate during the canary, record:

- The `swarm-review:*` label applied (visible in the PR's label history and in the workflow run's "Apply verdict label" step output).
- The actual merged outcome: did the code contain a real defect? Did a bug ship that the gate missed?
- Classification:
  - **False positive** — the gate labeled `swarm-review:fail` or `swarm-review:concern` but the code was actually fine (no bug, no spec violation, no real security issue).
  - **False negative** — the gate labeled `swarm-review:pass` but a real bug or regression shipped anyway.
  - **True positive** — the gate flagged a real issue that was subsequently confirmed and fixed.
  - **True negative** — the gate passed clean code.

Track these in a simple table (a shared doc, a GitHub project, or a labeled issue in the dev-agent repo — whatever your team will actually update). The minimum sample size before moving to enforce phase is 20 PRs; more is better, especially if those PRs span a range of change sizes and types.

During the canary, a `swarm-review:fail` result does not block merge. If the gate fires on a PR you want to merge anyway, you can merge it normally and record it as a false positive (if the code was actually fine) or a true positive with an accepted risk (if the gate was right and you're shipping anyway). Both outcomes are useful data.

---

## Enforce phase

Once the false-positive rate is acceptable — the target is fewer than 1 in 10 PRs flagged wrongly — make swarm-review a required check.

In the consumer repo, navigate to: **Settings → Branches → Branch protection rules → edit (or add) the rule covering the default branch** (usually `main` or `master`).

Enable **"Require status checks to pass before merging"** and then add swarm-review to the required list. The exact name that appears in the autocomplete field is derived from how GitHub observed the check. The job name in `dev-agent-verification.yml` is `swarm-review`, but GitHub constructs the displayed status-check name from the workflow file name and job name together — it may appear as something like `dev-agent · verification gates / swarm-review` depending on the workflow's `name:` field and your GitHub version.

**Important:** GitHub only shows a check in the branch-protection status-check picker after it has run at least once on a PR in that repo. Do not guess the check name from the YAML — open a PR that has already run the gate, navigate to its checks, find the swarm-review check in the list, and copy the exact name as it appears. Paste that exact string into the branch-protection required-checks field.

After enabling the required check, the next PR that receives a `swarm-fail` verdict will be blocked from merging via the GitHub UI and API until the gate is satisfied (the check passes on a re-run, or the verdict is overridden — see below).

---

## Override

When a `swarm-fail` verdict is wrong (false positive) or a maintainer decides to accept the risk and advance the PR anyway, a maintainer comments on the PR:

```
/swarm-override <one-line reason>
```

This is handled by the `swarm-override` job in `phase-pr-review.yml`. The job:

1. Verifies the PR's head branch matches `feat/dev-agent-issue-*` (non-dev-agent PRs are ignored).
2. Strips the `/swarm-override` prefix and captures everything that follows (up to 500 characters) as the reason.
3. Removes the `swarm-review:fail` and `swarm-review:concern` labels.
4. Applies `swarm-overridden` and `swarm-review:pass` labels.
5. Posts an audit comment to the PR recording the actor's GitHub login, the reason, and a UTC timestamp.

The audit comment posted to the PR is the canonical record in v1. GitHub's comment history is permanent and immutable, making it the auditable trail for the bypass. The `events.jsonl` append that will mirror these overrides to the repo's event log is deferred to v1.1.

Any GitHub user who is not `claude[bot]` or `dev-agent[bot]` can trigger the override command. If you want to restrict override authority to specific maintainers, you must add an explicit actor-allowlist check to the `swarm-override` job's `if:` condition before enabling the required check — otherwise any commenter on the PR can bypass the gate.

---

## Kill switch

The current v1 workflow (`phase-swarm-review.yml`) does not implement a kill switch. If the gate is blocking all merges due to a reviewer infrastructure outage (e.g., the Anthropic API is unavailable), the options available in v1 are:

1. **Temporarily remove the required check** from branch protection (Settings → Branches → edit the rule → uncheck swarm-review from the required list). Re-add it once the outage is resolved.
2. **Use `/swarm-override`** on individual blocked PRs while the outage persists.
3. **Re-run the failed workflow** once the underlying issue (missing `ANTHROPIC_API_KEY` secret, claude-code-action outage, network egress block) is resolved — the gate is designed to fail-closed on all-reviewer outage, so the re-run will either produce a real verdict or surface the outage error more clearly in the workflow logs.

A `DEV_AGENT_GATE_KILL_SWITCH` Actions secret with comma-separated gate names (e.g. `acm,swarm,tier2`) is planned for a future release to provide a single-step bypass during incidents. It is not present in v1.

---

## Summary of label semantics

| Label | Meaning | Blocks merge when required? |
|---|---|---|
| `swarm-review:pass` | All reviewers passed or concerns were minor | No |
| `swarm-review:concern` | At least one reviewer flagged a concern; no hard fail | No |
| `swarm-review:fail` | At least one reviewer issued a hard fail; workflow exits non-zero | Yes (when check is required) |
| `swarm-review:outage` | All three reviewers produced no output; gate treats as hard fail | Yes (when check is required) |
| `swarm-review:error` | The aggregator crashed before producing a verdict | Yes (when check is required) |
| `swarm-overridden` | A maintainer ran `/swarm-override`; `swarm-review:pass` also applied | No |
