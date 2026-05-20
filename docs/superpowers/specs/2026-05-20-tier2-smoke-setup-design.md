# tier2-smoke Setup — Design

**Date:** 2026-05-20
**Status:** Approved — ready for implementation plan
**Scope:** Wire the (already-built) `phase-tier2-smoke.yml` engine workflow into dev-agent's pipeline so the **Smoke (Pillar 7)** verification gate actually runs on consumer features. Engine is done; this spec defines the trigger model, the consumer wrapper, the orchestrator entry, and the distribution path.

---

## Context

`phase-tier2-smoke.yml` is a complete reusable engine workflow: a Claude sub-agent authors a Playwright probe from the spec's acceptance criteria, runs it against the staging URL, emits a `verdict` JSON + an issue comment + label/state transitions. It accepts `issue_number`, `pr_number`, `staging_url`, `spec_path`, `invocation_mode`, `stub_mode` and the `ANTHROPIC_API_KEY` secret.

The orchestrator declares `state:tier2-smoke` between `staging-deployed` and `ready-to-promote` with exit transitions (`tier2-pass`, `tier2-fail`, `human-override`), but **no entry transition** — nothing currently routes a feature into smoke. There is no consumer-side wrapper that calls the reusable workflow, and no `dev-agent-tier2-smoke.yml` template in `examples/web-app-template/.github/workflows/`. The dashboard's `configuredPillars` already checks for that template file, so as soon as it ships and is installed on a repo, the Verification posture panel will flip Smoke to ✓ automatically — no dashboard change needed.

## Goals

1. Every dev-agent feature that successfully reaches `state:staging-deployed` automatically enters `state:tier2-smoke` and runs the smoke probe.
2. The smoke verdict is blocking from day one — a `tier2-fail` routes to `state:blocked` and stops promote-to-prod (per the existing orchestrator design).
3. Setup ships through the same distribution machinery as the verification workflow rollout (PR #88): a wire-up template entry + the one-click backfill installer (PR #86) so it lands on fresh wire-ups and is one click for existing repos.
4. The blast radius of a flaky probe is bounded by a documented per-repo canary: enable on one repo first, watch ~5 features, then enable on the rest.

## Non-Goals

- A consumer-side `/smoke-override` command. Same gap as `/swarm-override`; the v1 escape hatches are workflow re-run, admin-merge, or temporarily un-requiring the check (documented in the runbook).
- Capturing or replaying Playwright artifacts in the dashboard — the engine workflow already uploads them; the dashboard's existing run-status surface is enough for v1.
- A "manual run smoke now" button. The orchestrator design is automatic-after-staging-deploy; a manual trigger duplicates the dispatch path and adds confusion.

---

## Trigger model

**Auto-run after staging deploy, driven by the existing `state:staging-deployed` label.** No engine change required — the consumer wrapper subscribes to a label the engine already adds.

Flow:

1. `phase-staging-deploy.yml` succeeds (Tier-1 smoke included) → already flips the issue from `state:pr-review` to `state:staging-deployed` and posts a telemetry comment carrying the staging URL.
2. The consumer-side `dev-agent-tier2-smoke.yml` triggers on `issues.labeled` where the added label is `state:staging-deployed` and the issue carries `kind:user-intent` (the dev-agent feature marker).
3. The wrapper runs a small `run:` step to:
   - Flip the issue state: remove `state:staging-deployed`, add `state:tier2-smoke` (so the dashboard reflects "smoke in flight" rather than "staging deployed, idle").
   - Resolve three inputs from the issue context:
     - `pr_number`: resolved from the implement-phase telemetry comment, which already carries a `PR: #N` line (verified in `phase-implement.yml`); fallback `gh pr list --head "feat/dev-agent-issue-${issue}" --json number --jq '.[0].number'`.
     - `staging_url`: derived from Vercel's preview-deployment PR comment. The wrapper runs `gh pr view "$PR" --json comments --jq '.comments[] | select(.author.login == "vercel[bot]") | .body'` and extracts the first `https://*.vercel.app` URL it finds (most recent comment wins). This matches dev-agent's default deploy stack (`.dev-agent.yml`'s `deploy_skills.staging` defaults to `vercel-deploy-preview`). If a consumer customizes their deploy skill off Vercel, they must customize this lookup too — documented in the runbook.
     - `spec_path`: the spec link from the issue body; if absent, `spec_path` is left empty and the reusable emits `verdict: skipped`.
   - If any required input is missing (no Vercel comment, no PR found), the wrapper posts a single issue comment explaining what was missing and exits — does NOT fall through to the reusable with empty inputs, which would 422 on the typed `required: true` `staging_url`.
4. The wrapper calls `alizaouane/dev-agent/.github/workflows/phase-tier2-smoke.yml@v1` with those inputs + `invocation_mode: live` and forwards the `ANTHROPIC_API_KEY` secret.
5. The reusable workflow handles the rest (probe authoring, run, verdict comment, exit transition to `state:ready-to-promote` on pass or `state:blocked` on fail).

**Why subscribe to `state:staging-deployed` and not a new `state:tier2-smoke` label set by the engine.** The engine staging-deploy can't unconditionally add `state:tier2-smoke` — that would break repos that don't have the wrapper installed (they'd land in a state with no workflow listening). Subscribing to the existing `state:staging-deployed` label means repos without the wrapper see no change in behavior, and repos with the wrapper installed pick up the next step automatically. No engine code needs to know whether smoke is wired.

**Security guard.** The wrapper's `if:` filters to:
- `github.event.label.name == 'state:staging-deployed'` (specific label), AND
- `contains(github.event.issue.labels.*.name, 'kind:user-intent')` (dev-agent feature only).

This means a re-add of `state:staging-deployed` by a maintainer (e.g., to retry a smoke) intentionally re-fires the wrapper. Adds by unrelated automation on non-feature issues are ignored.

## Consumer wrapper — `dev-agent-tier2-smoke.yml`

Lives at `examples/web-app-template/.github/workflows/dev-agent-tier2-smoke.yml`. Triggers:

```yaml
on:
  issues:
    types: [labeled]
```

Plus a `workflow_dispatch` for manual re-runs (operator path).

Permissions:

```yaml
permissions:
  contents: read
  issues: write
  id-token: write
```

(Mirrors the `dev-agent-verification.yml` permissions block — same reason: a reusable workflow can never elevate above the caller, and `phase-tier2-smoke.yml` needs `issues: write` to post the verdict comment and flip the state label.)

Job:

```yaml
jobs:
  tier2-smoke:
    if: |
      github.event_name == 'workflow_dispatch' ||
      (github.event.label.name == 'state:staging-deployed' &&
       contains(github.event.issue.labels.*.name, 'kind:user-intent'))
    runs-on: ubuntu-latest
    steps:
      - name: Resolve smoke inputs from issue context
        id: resolve
        env: { GH_TOKEN: ${{ github.token }}, ISSUE: ${{ github.event.issue.number || inputs.issue_number }} }
        run: |
          # 1. staging_url from the latest staging-deploy telemetry comment.
          # 2. pr_number from the implement telemetry comment.
          # 3. spec_path from the issue body's spec link.
          # See runbook for exact regexes — all untrusted text routes through env vars, never interpolated into bash.
          …
      - uses: alizaouane/dev-agent/.github/workflows/phase-tier2-smoke.yml@v1
        with:
          issue_number: ${{ steps.resolve.outputs.issue_number }}
          pr_number:    ${{ steps.resolve.outputs.pr_number }}
          staging_url:  ${{ steps.resolve.outputs.staging_url }}
          spec_path:    ${{ steps.resolve.outputs.spec_path }}
          invocation_mode: live
        secrets:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

(The implementation plan will fill out the exact resolve-step bash. Untrusted GitHub event values flow through `env:` blocks, never interpolated into `run:` — matching the security convention from the verification workflow.)

## Engine change

**None.** `phase-staging-deploy.yml` already adds `state:staging-deployed` on success, which is exactly the label the wrapper subscribes to. Keeping the engine untouched means repos without the smoke wrapper installed see no behavior change.

## Orchestrator update

In `lib/orchestrator.ts`, add the entry transition so the state model documents the new edge:

```typescript
{
  from: 'state:staging-deployed',
  trigger: 'workflow-tier2-fire',
  to: 'state:tier2-smoke',
  fires: 'dev-agent-tier2-smoke.yml',
},
```

`workflow-tier2-fire` is a new `TransitionTrigger` value alongside `workflow-pr-open`. The transition is *fired by the consumer wrapper* (when it processes the `state:staging-deployed` label-added event). The existing `tier2-pass` / `tier2-fail` / `human-override` exit transitions remain unchanged.

## Distribution

Mirrors the verification workflow rollout (PR #88) and the scout one-click installer (PR #86):

1. **Embed in wire-up.** Add `TEMPLATE_TIER2_SMOKE_WORKFLOW_YML` to `dashboard/lib/wire-up-template.ts` (the embedded copy, escaped for the TS template literal — `${{ → \${{` and backticks escaped). Add the file to `WIRE_UP_FILES` so fresh wire-ups ship it.
2. **Backfill installer.** Add a `tier2-smoke` entry to `INSTALLABLE_WORKFLOWS`:
   ```typescript
   'tier2-smoke': {
     path: '.github/workflows/dev-agent-tier2-smoke.yml',
     content: TEMPLATE_TIER2_SMOKE_WORKFLOW_YML,
     label: 'Tier-2 smoke',
   },
   ```
   The existing `installWorkflow` server action + `InstallWorkflowPanel` UI cover the one-click install for already-wired repos.
3. **Drift test.** Extend `tests/unit/wire-up-template-drift.test.ts` with an `it()` block asserting the on-disk file matches the embedded constant.
4. **Repo workspace surface.** The Verification gates card on `app/repos/[name]/page.tsx` already renders an `InstallWorkflowPanel` for missing scout workflows. Add a parallel "Tier-2 smoke" panel that probes for the file and shows install/installed states. (Alternative: extend the existing Verification-gates card to cover smoke too. The plan will pick the cleanest UI shape; spec-level, both are acceptable.)

## Dashboard

No `configuredPillars` change — it already checks the right file (`dev-agent-tier2-smoke.yml`). Once the wrapper is installed on a repo, `smoke_p7` flips to ✓ automatically, and the Smoke pillar status will surface in the Verification posture rollup via the existing smoke extractor (`lib/verification/extractors/smoke.ts`).

## Failure recovery

When a smoke run fails and the issue lands in `state:blocked`, v1 escape hatches (matching the swarm-review runbook):

- **Re-run.** Remove `state:tier2-smoke` and re-add `state:staging-deployed` — that's the label the wrapper's `issues.labeled` trigger fires on (re-adding `state:tier2-smoke` would *not* re-fire the wrapper). Or dispatch directly: `gh workflow run dev-agent-tier2-smoke.yml -f issue_number=<N>`.
- **Admin-merge.** If the verdict is wrong and the operator accepts the risk, admin-merge the promote PR (provided branch protection allows admin bypass).
- **Temporarily un-require the check.** Remove `dev-agent · phase-tier2-smoke` from the required checks list, merge, re-add.

A consumer `/smoke-override` command is **explicitly deferred** to a future PR — same gap as `/swarm-override`, same admin-merge stopgap.

## Rollout — canary

Even though we're shipping blocking day-one, the runbook will prescribe a per-repo canary:

1. Install on one repo (suggested: `caliente-booking-app` — has the largest SESSION_LOG and the most actual feature throughput).
2. Watch the next ~5 features. Track false positives (gate said fail, deploy was fine) vs true positives (gate caught a real regression).
3. If false-positive rate is acceptable (target < 1 in 10), install on the remaining wired repos.

This bounds the blast radius — a flaky Playwright probe pattern, if it exists, is caught on the first repo before it blocks every dev-agent feature.

## Files to touch

| File | Change |
|---|---|
| `examples/web-app-template/.github/workflows/dev-agent-tier2-smoke.yml` | new — consumer wrapper |
| `dashboard/lib/wire-up-template.ts` | embed `TEMPLATE_TIER2_SMOKE_WORKFLOW_YML`; add to `WIRE_UP_FILES` + `INSTALLABLE_WORKFLOWS` |
| `tests/unit/wire-up-template-drift.test.ts` | drift `it()` for the new template |
| `lib/orchestrator.ts` | new entry transition + `workflow-tier2-fire` trigger value |
| `dashboard/app/repos/[name]/page.tsx` | optional — surface Tier-2 smoke install state on the workspace page (the install panel covers existing repos; the plan picks the exact UI placement) |
| `docs/runbooks/2026-05-20-tier2-smoke-rollout.md` | new — canary procedure, override paths, kill switches |

## Testing

- **Drift test** — embedded template matches on-disk.
- **Orchestrator transition test** — the new entry transition resolves and `fires` correctly.
- **Wrapper YAML validity** — `python3 -c "import yaml; yaml.safe_load(open(...))"` in CI (already a pattern from prior workflow tests).
- **Manual end-to-end on the canary repo** — dispatch staging-deploy on a real feature, confirm `state:tier2-smoke` is applied, the wrapper fires, the probe runs, and a verdict surfaces.

## Out of scope (call-outs for the implementation plan)

- The exact `if:` guard against fork PRs: if staging deploy can fire for fork PRs (unlikely given the existing same-repo guard pattern), the smoke wrapper inherits that guard via the issue context — verify during implementation.
- Vercel comment format may change. The wrapper's URL regex (`https://[a-z0-9.-]+\.vercel\.app`) is tolerant of trailing path/query/anchors but assumes the URL appears on its own or is bounded by non-URL whitespace. If Vercel changes their comment format, the wrapper logs a clear "couldn't find Vercel URL" and skips — easier to spot than silently smoke-testing the wrong URL.
