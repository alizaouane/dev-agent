# Swarm-review enforcement + canary rollout

**Date:** 2026-05-16
**Applies to:** Consumer repos using `dev-agent-verification.yml` (Pillar 2)
**Status:** Canary phase — advisory, not yet a blocking check
**Consumer override:** Available since 2026-05-22 via wire-up.

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

Consumer repos receive a `/swarm-override` comment handler via wire-up. To advance a consumer-repo PR past a failed verification check — a genuine false positive, or an accepted risk — a reviewer comments on the PR:

```text
/swarm-override <one-line reason>
```

The override workflow (`.github/workflows/dev-agent-swarm-override.yml`) validates that the PR's head branch matches `feat/dev-agent-issue-*` and the comment author isn't a bot, then:

1. Removes `swarm-review:fail` and `swarm-review:concern` labels.
2. Adds `swarm-overridden` and `swarm-review:pass`.
3. Posts an audit comment with a hidden `<!-- dev-agent:event:b64 <base64> -->` anchor that records the actor, reason, timestamp, and run id in the same JSON shape the engine-repo handler uses (see "Audit trail for /swarm-override (engine + consumer)" below).

**v1 behavior — what the override does and does not do.** It flips labels and records the audit anchor. It does *not* mechanically produce a passing `verification-gate` check; the v1 verification gate runs on `pull_request` events, not `issue_comment`, so its check status reflects the swarm-review verdict at the last code push. Treat the override as the audited rationale; the actual unblock path is one of:

1. **Admin merge (preferred for a single PR).** If the branch-protection rule does not have **"Do not allow bypassing the above settings"** enabled, a repo admin can merge the PR through GitHub's admin-merge path. The PR timeline and the `/swarm-override` audit anchor together form the bypass record.
2. **Temporarily un-require the check.** Remove the check from the required list (Settings → Branches → edit the rule), merge, then re-add it. Wider blast radius — use only for outage scenarios.

**Authorization.** Override authority is restricted to repo `OWNER`, `MEMBER`, or `COLLABORATOR` (via GitHub's `author_association` on the comment). Drive-by commenters on public repos cannot trigger an override. Bot accounts are also excluded (`claude[bot]`, `dev-agent[bot]`, `github-actions[bot]`). Per-repo fine-grained actor allowlists are v1.1 work — the built-in association check is the v1 floor and the audit anchor records the exact login that invoked the override.

**Outage labels.** `swarm-review:outage` and `swarm-review:error` are not cleared by `/swarm-override` — they mean the gate produced no verdict at all (infrastructure failure, not a code judgment). Re-run `dev-agent-verification.yml` once the underlying issue is resolved, rather than overriding.

### Audit trail for /swarm-override (engine + consumer)

Both the engine-repo handler (`.github/workflows/phase-pr-review.yml`, swarm-override sibling job) and the consumer-repo handler (`.github/workflows/dev-agent-swarm-override.yml`, installed via wire-up) emit the same hidden machine-parseable anchor in their audit comment:

```html
<!-- dev-agent:event:b64 <base64> -->
```

The `<base64>` payload decodes to a single-line JSON object mirroring `lib/events.ts`'s `override.applied` event shape:

```json
{
  "ts": "<ISO-8601 UTC timestamp>",
  "run_id": "<github.run_id>",
  "issue": <PR number>,
  "phase": "phase-pr-review" | "dev-agent-swarm-override",
  "event": "override.applied",
  "payload": {
    "override_type": "swarm-override",
    "actor": "<github login of the commenter>",
    "reason": "<free-form tail of the /swarm-override comment, truncated to 500 chars>"
  }
}
```

The payload is base64-encoded because `reason` is user-supplied — a reason containing the literal string `-->` would otherwise close the HTML comment early and break the anchor.

The only difference between the engine-repo and consumer-repo anchors is the `phase` field: engine emits `"phase-pr-review"` (the engine workflow filename), consumer emits `"dev-agent-swarm-override"` (the consumer workflow filename). A future scraper that walks both repos can distinguish them by that field while parsing the rest of the payload identically.

### Audit trail for `/swarm-override` in the engine repo

When `/swarm-override` is used inside the dev-agent engine repo's own PRs (the `phase-pr-review.yml` handler), the audit comment now embeds a hidden machine-parseable event anchor of the form `<!-- dev-agent:event:b64 <base64> -->`. The payload is base64-encoded JSON because `reason` is user-supplied and could otherwise contain `-->`, which would close the HTML comment early and truncate the anchor — base64 output is alphabet-only so a comment terminator can never appear inside it. The decoded JSON matches `lib/events.ts`'s `override.applied` shape — `ts`, `run_id`, `issue` (PR number), `phase: 'phase-pr-review'`, and a `payload` carrying `override_type`, `actor`, and `reason`. Future tooling reconstructs `.dev-agent/events/<pr>.jsonl` by scraping these anchors, `base64 -d`-ing the payload, and JSON-parsing the result — no commit-back step needed from the workflow. Admin-merge and un-require bypasses are recorded in the PR timeline (not the anchor) since they happen outside the override handler.

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

The `swarm-overridden` label is applied by the `/swarm-override` command. It is available in both the dev-agent engine repo (`phase-pr-review.yml`) and in consumer repos that have received the wire-up workflow set (`dev-agent-swarm-override.yml`). See Override above.
