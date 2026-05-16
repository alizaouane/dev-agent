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

Track these in a simple table (a shared doc, a GitHub project, or a labeled issue in the dev-agent repo — whatever your team will actually update). The minimum sample size before moving to enforce phase is 20 PRs; more is better, especially if those PRs span a range of change sizes and types. To keep the canary representative, the 20+ PRs must span at least two distinct change sizes — for example, some small patch-level PRs alongside some medium multi-file PRs — so the gate is not graduated on a sample composed entirely of trivial chore commits.

During the canary, a `swarm-review:fail` result does not block merge. If the gate fires on a PR you want to merge anyway, you can merge it normally and record it as a false positive (if the code was actually fine) or a true positive with an accepted risk (if the gate was right and you're shipping anyway). Both outcomes are useful data.

---

## Enforce phase

Once the false-positive rate is acceptable — the target is fewer than 1 in 10 PRs flagged wrongly — make the verification gate required.

`dev-agent-verification.yml` runs three jobs on each dev-agent PR: `evidence` (the deterministic scanners — gitleaks, Semgrep, npm audit — which fail closed on HIGH-severity findings), `swarm-review` (the three LLM reviewers), and `verification-gate` (an aggregate job).

**Require the `verification-gate` check — and only that one.** `swarm-review` declares `needs: evidence` with an `if:` that has no status function, so GitHub applies an implicit `success()`: if `evidence` fails, `swarm-review` is *skipped*, and GitHub branch protection treats a skipped required check as passing. Requiring `swarm-review` directly would therefore let a PR with a HIGH-severity scan failure merge. The `verification-gate` job closes this: it runs with `always()` and fails unless **both** `evidence` and `swarm-review` succeeded, so it cannot be bypassed by a skip. Require `verification-gate` and the whole gate is enforced with a single check.

In the consumer repo, navigate to: **Settings → Branches → Branch protection rules → edit (or add) the rule covering the default branch** (usually `main` or `master`). Enable **"Require status checks to pass before merging"** and add the `verification-gate` check to the required list.

**Important:** GitHub only shows a check in the branch-protection status-check picker after it has run at least once on a PR in that repo. Do not guess the check name from the YAML — open a PR that has already run `dev-agent-verification.yml`, navigate to its checks, find the `verification-gate` check, and copy the exact name as it appears. The displayed name is derived from the workflow's `name:` field and the job name together, so it may appear as something like `dev-agent · verification gates / verification-gate`.

After enabling the required check, a PR with a failed `evidence` scan or a `swarm-fail` verdict will be blocked from merging via the GitHub UI and API until the gate is satisfied — the checks pass on a re-run, or a maintainer advances the PR (see Override below).

---

## Override

**In v1, consumer repos do not have a `/swarm-override` comment command.** The `/swarm-override` handler lives in `phase-pr-review.yml`, which runs only inside the dev-agent engine repository — it is not part of the workflow set that wire-up installs into consumer repos. A consumer-side override command is a planned follow-up.

Until it ships, to advance a consumer-repo PR past a failed verification check — a genuine false positive, or an accepted risk — a repository administrator has two options:

1. **Admin merge (preferred for a single PR).** If the branch protection rule does not have **"Do not allow bypassing the above settings"** enabled, a repo admin can merge the PR through GitHub's admin-merge path despite the red check. The merge is recorded in the PR timeline, which is the auditable record of the bypass. Leave a PR comment stating the reason before merging so the rationale is captured alongside it.
2. **Temporarily un-require the check.** Remove the check from the required list (Settings → Branches → edit the rule), merge, then re-add it. This has a wider blast radius — it lifts the gate for *every* open PR while the check is un-required — so prefer admin merge for a one-off.

Neither path clears a `swarm-review:outage` or `swarm-review:error` label. Those mean the gate produced no verdict at all (an infrastructure failure, not a code judgment) — re-run `dev-agent-verification.yml` once the underlying issue is resolved rather than overriding.

Override authority is already scoped: only repo admins can admin-merge or edit branch protection. No additional actor-allowlist configuration is needed for the v1 consumer override paths.

---

## Kill switch

The current v1 workflow (`phase-swarm-review.yml`) does not implement a kill switch. If the gate is blocking all merges due to a reviewer infrastructure outage (e.g., the Anthropic API is unavailable), the options available in v1 are:

1. **Temporarily remove the required check** from branch protection (Settings → Branches → edit the rule → uncheck the `verification-gate` check from the required list). Re-add it once the outage is resolved.
2. **Admin-merge individual blocked PRs** while the outage persists — see the Override section above.
3. **Re-run the failed workflow** once the underlying issue (missing `ANTHROPIC_API_KEY` secret, claude-code-action outage, network egress block) is resolved — the gate is designed to fail-closed on all-reviewer outage, so the re-run will either produce a real verdict or surface the outage error more clearly in the workflow logs. For a *transient* outage (e.g. the Anthropic API briefly unavailable), prefer simply re-running the workflow rather than removing the required status checks: the gate fails closed precisely so that normal service recovery restores the verdict automatically, and removing the checks creates a window where the gate provides no protection at all.

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

The `swarm-overridden` label is applied by the `/swarm-override` command, which runs only in the dev-agent engine repo — it does not appear in consumer repos in v1 (see Override).
