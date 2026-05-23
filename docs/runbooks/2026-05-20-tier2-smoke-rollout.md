# Tier-2 smoke enforcement + canary rollout

**Date:** 2026-05-20
**Applies to:** Consumer repos using `dev-agent-tier2-smoke.yml` (Pillar 7)
**Status:** Canary phase — advisory, not yet a blocking check

---

## What tier2-smoke is

Tier-2 smoke is dev-agent's Playwright-level UI gate. It runs after a feature's staging deploy is confirmed, before the feature is eligible for promotion to production. The reusable engine workflow `phase-tier2-smoke.yml` has a Claude sub-agent author a Playwright probe from the spec's `## Acceptance criteria` UI bullets. That probe runs against the deployed staging URL using Playwright + Chromium in the GitHub Actions runner, and the `lib/cli/playwright-probe.ts` runner emits a JSON verdict of `pass`, `fail`, or `ambiguous`. The consumer wrapper `dev-agent-tier2-smoke.yml` triggers automatically on the `state:staging-deployed` label (for issues also carrying `kind:user-intent`). It resolves three inputs from issue context — the PR number, the Vercel preview URL, and the spec path — flips the issue to `state:tier2-smoke`, and calls the reusable. On a `pass` verdict the reusable removes `state:tier2-smoke` and applies `state:ready-to-promote`. On a `fail` verdict the reusable applies `tier2-failed` and exits non-zero, causing the workflow status check to go red — branch protection rules can gate merge on that check. An `ambiguous` verdict (spec has no UI-mapped criteria, or the probe runner crashed) applies `tier2-ambiguous` and is advisory in v1.

---

## Canary phase

**Do not add tier2-smoke to branch protection yet.** Install the wrapper on one repo first and watch at least five features move through the pipeline before making the check required. The purpose of the canary is to validate the three input-resolution steps — PR-number lookup, Vercel-URL extraction, and spec-path parsing — and to measure the gate's signal quality against real staging deployments.

The suggested canary repo is `caliente-booking-app`, which currently has the highest feature throughput in the environment and will produce observations quickly. For each feature that passes through the gate during the canary, record:

- The verdict applied (`pass`, `fail`, or `ambiguous`), visible in the issue comment posted by the workflow ("🤖 Phase: tier2-smoke / Verdict: …") and in the `tier2-smoke` job's "Live mode — post verdict comment + apply state transition" step output.
- The actual outcome of the deploy: was the code fine (a false-positive `fail`) or did the smoke catch a real UI regression (a true-positive `fail`)? For `pass` verdicts: did a bug reach production that the probe missed (false negative)?
- Whether the staging-URL resolution worked. The wrapper reads Vercel's PR comment posted by `vercel[bot]` (or `vercel`) and extracts the first URL matching `https://[a-z0-9]+(-[a-z0-9-]+)+\.vercel\.app`. If Vercel's comment format changes or the preview deploy is slow to post, this step will fail with a "skipped" advisory comment on the issue.
- Whether the spec-path resolution worked. The wrapper scans the issue body with `grep -oE 'docs/specs/[a-zA-Z0-9._/-]+\.md'` and takes the first match. Features that went through the dashboard's PM brainstorm flow already have a spec link in the issue body; hand-filed issues may not.

The target before moving to enforce phase is fewer than 1 in 10 verdicts being false positives. If the false-positive rate is higher, diagnose and fix the wrapper's input-resolution steps or the probe-author prompt before enabling on other repos — do not simply disable the gate, because a gate that operators reflexively bypass provides no safety value once it is required.

---

## Enabling on more repos

Once the canary data is acceptable, install the wrapper on the remaining consumer repos. From each repo's workspace page in the dev-agent dashboard, use the "Tier-2 smoke (staging probe)" install button in the verification gates card. The button copies `dev-agent-tier2-smoke.yml` into the repo's `.github/workflows/` directory via a PR, which you approve and merge. For new repos wired up to dev-agent after this point, the wrapper is part of the standard wire-up set and will be present from first use.

After install, make the smoke check required in branch protection when the canary data supports it. Navigate to the consumer repo's **Settings → Branches → Branch protection rules** and edit the rule covering the default branch. Enable **"Require status checks to pass before merging"** and add the smoke check to the required list.

**Which check name to require.** GitHub only shows a check in the branch-protection picker after it has run at least once on a PR in that repo. Do not guess the name from the YAML. Open a PR that has already triggered `dev-agent-tier2-smoke.yml`, navigate to its checks, find the `dev-agent · tier2-smoke / smoke-call` check, and copy the exact name as it appears. The displayed name is derived from the workflow's `name:` field and the job name together.

**What to require.** The `smoke-call` job (which runs the reusable) only starts when `tier2-smoke` (the resolve job) outputs `ready=true`. If any input is missing, the resolve job exits 0 with `ready=false`, and `smoke-call` is skipped. GitHub branch protection treats a skipped required check as passing — meaning an issue without a spec link or without a Vercel URL will not block merge. This is the intended advisory-skip behavior in v1. If you want to require a verdict even on missing-input cases, file a follow-up to change the missing-input exit path from `exit 0 / ready=false` to a blocking status.

---

## Failure recovery

When a smoke run emits a `fail` verdict, the issue lands with `tier2-failed` applied and the `smoke-call` check goes red. To advance the feature, choose one of the following paths:

**Re-run the smoke workflow.** Remove the `state:tier2-smoke` label from the issue and re-add `state:staging-deployed`. This re-fires the `issues.labeled` trigger in `dev-agent-tier2-smoke.yml` and starts a fresh smoke run. Alternatively, dispatch it directly: `gh workflow run dev-agent-tier2-smoke.yml --repo <owner>/<repo> -f issue_number=<N>`. Before re-running, address whatever caused the failure — either a real UI bug that needs a fix and a new staging deploy, or a flaky probe (in which case the issue may be in the probe-author prompt or in an ARIA selector that isn't stable across renders).

**Admin merge (preferred for a one-off false positive).** If you have reviewed the smoke result, are confident it is a false positive, and want to merge anyway, a repository administrator can use GitHub's admin-merge path — provided the branch protection rule does not have "Do not allow bypassing the above settings" enabled. Leave a PR comment stating the reason before merging so the rationale is captured in the PR timeline. This is the same escape hatch as for swarm-review.

**Temporarily un-require the check.** Remove `dev-agent · tier2-smoke / smoke-call` from the required-checks list (Settings → Branches → edit the rule), merge, then re-add it. This lifts the gate for every open PR while the check is un-required. Use this only when multiple PRs are blocked by a systemic issue (e.g., the probe-author prompt is producing consistently broken probes); prefer admin-merge for a single PR.

Neither path removes the `tier2-failed` label automatically. Remove it manually after the situation is resolved so the issue's label history stays clean.

---

## Vercel assumption

The wrapper sources the staging URL from Vercel's PR comment. It looks for a comment authored by `vercel[bot]` or `vercel` and extracts the first URL matching the pattern `https://[a-z0-9]+(-[a-z0-9-]+)+\.vercel\.app`. This is the URL Vercel's GitHub integration posts when a preview deployment is ready.

If the consumer repo uses a different deploy stack — fly.io, Render, Railway, a self-hosted preview environment — no Vercel comment will appear on the PR, and the wrapper will post a skipped advisory and exit without calling the reusable. To support a different stack, edit `dev-agent-tier2-smoke.yml` in the consumer repo and replace the `# --- staging_url ---` block in the `resolve` step with logic that derives the preview URL from your deploy stack's PR comment or deployment status API. The rest of the wrapper (PR-number resolution, spec-path extraction, label transitions, and the reusable call) is deploy-stack-agnostic and does not need to change.

---

## Spec-path requirement

The wrapper expects to find a reference matching `docs/specs/[a-zA-Z0-9._/-]+\.md` somewhere in the issue body. Features that were approved through the dashboard's PM brainstorm flow already have a spec link in the issue body — no manual action required. Hand-filed `kind:user-intent` issues without a spec link are skipped: the wrapper posts an explanatory comment ("Could not find a `docs/specs/*.md` reference in the issue body") and exits 0. The smoke gate does not fire, no verdict is applied, and if `smoke-call` is required in branch protection its skipped status is treated as passing — so the promote PR can still be merged past staging-deployed.

As of 2026-05-23, the resolve step strips fenced code blocks (`` ``` ... ``` ``) AND inline backtick segments (`` `...` ``) from the issue body before matching, so stale references inside code examples or backtick-quoted prose are ignored. Plain-text references outside code blocks still match in document order — if you reference both an old and a new spec in flowing text, the canonical link must appear first. A structured `Spec:` field convention on the issue template would eliminate even that last ambiguity but is not required for v1.

---

## Override gap (acknowledged)

A consumer-side `/smoke-override` comment command is not shipped in v1. The `/swarm-override` handler lives in `phase-pr-review.yml`, which runs only inside the dev-agent engine repository — it is not part of the workflow set that wire-up installs into consumer repos. Tier-2 smoke has the same gap: no consumer-side comment command exists to mark a `tier2-failed` result as overridden. The escape hatches in the Failure recovery section above are the v1 paths. A consumer-side override command is a planned follow-up.

---

## Summary of label semantics

| Label | Meaning | Blocks merge when required? |
|---|---|---|
| `state:tier2-smoke` | Smoke run is in flight — the wrapper applied this label after resolving inputs and before calling the reusable | No |
| `state:ready-to-promote` | Smoke passed; the reusable removed `state:tier2-smoke` and applied this label | No |
| `tier2-failed` | Smoke failed; the reusable applied this label and exited non-zero — the `smoke-call` check goes red | Yes (when the check is required in branch protection) |
| `tier2-ambiguous` | Probe produced no results (spec has no UI-mapped criteria, or the runner crashed); advisory in v1 — does not exit non-zero | No |
