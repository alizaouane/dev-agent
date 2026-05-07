# Canary Rollout — Industry-Grade Verification Architecture (v1)

This runbook covers the staged enable of Pillars 1, 2, 5, 6, 7 (the
verification gates added by `feat/industry-grade-verification`) on real
consumer repos. Each step is reversible via the kill-switch / label
removal mechanisms described inline.

The plan: ship in **stub mode + advisory** first (no real impact on
shipping), then graduate to **live mode + advisory** (real verdicts
surface but don't block), then graduate to **live + enforcing** (real
gates).

## Stage 0 — Branch + tests (already done)

The 14 commits on `feat/industry-grade-verification` add:

| Pillar | Mode in v1 | Files |
|---|---|---|
| 1 (ACM) | Live in stub mode | `lib/acm.ts`, `lib/cli/acm-{verify,extract,stub-build}.ts`, `phase-acm.yml`, `phase-implement.yml` integration |
| 2 (Swarm Review) | Stub mode + advisory | `lib/swarm-review.ts`, `lib/findings-store.ts`, `lib/cli/swarm-{aggregate,stub}.ts`, `phase-{evidence-collector,swarm-review}.yml` |
| 4 (Apply discipline) | Lib only (TS-compiler-based AST) | `lib/apply.ts` |
| 5 (Sandbox) | Harden-Runner audit-mode on every workflow | `phase-*.yml` |
| 6 (Self-review) | Live, advisory | `prompts/implement.md`, `prompts/self-review.md`, `phase-implement.yml` integration |
| 7 (Tier-2 smoke) | Stub mode + advisory | `phase-tier2-smoke.yml` |
| 10 (Operational) | Invariants + unstick CLI | `tests/unit/orchestrator-invariants.test.ts`, `lib/cli/orch-unstick.ts` |

State machine entry rows for the 3 new states (`acm-building`,
`swarm-reviewing`, `tier2-smoke`) are NOT yet wired — Stage 1 below.

## Stage 1 — Test repo dry run (stub mode, advisory)

**Goal**: prove the wiring on a sandbox repo before any real consumer feels the change.

1. Pick a low-stakes repo for the canary (`examples/test-repo` if it exists, otherwise a fresh sandbox).
2. Add to its `.dev-agent.yml`:
   ```yaml
   audit_skills:
     pre_pr: []
     acm:
       required: true
       test_pattern: "tests/acm/**"
       mutation_score_threshold: 60
       flaky_runs: 5
       max_iterations: 3
     swarm:
       reviewers: ['spec-compliance', 'regression-guard', 'security-scout']
       reviewer_weights:
         spec-compliance: 1.0
         regression-guard: 1.0
         security-scout: 1.5
       timeout_minutes: 15
       fail_open: true   # advisory in stage 1
       kill_switch_env: DEV_AGENT_GATE_KILL_SWITCH
   models:
     # ... existing models
     acm: claude-sonnet-4-6
     acm_test_agent: claude-sonnet-4-6
     swarm_review: claude-haiku-4-5
     meta_reviewer: claude-sonnet-4-6
     self_review: claude-haiku-4-5
     tier2_smoke: claude-sonnet-4-6
   ```
3. Add wrapper workflows under `.github/workflows/` that call
   `phase-acm.yml`, `phase-evidence-collector.yml`, `phase-swarm-review.yml`,
   `phase-tier2-smoke.yml` from `alizaouane/dev-agent@v1`. All in
   `invocation_mode: stub` to start.
4. File a test issue with a spec under `docs/specs/` containing a
   `## Acceptance criteria` block.
5. `/approve` the issue. Expected sequence:
   - `state:spec-ready` → `state:acm-building` (manual labeling — entry
     row not yet wired in v1; orch-unstick CLI handles this for now)
   - phase-acm runs in stub mode → `state:implementing` (via acm-pass)
   - phase-implement runs (with ACM pre-flight detecting the manifest)
   - PR opens
   - phase-swarm-review runs in stub mode → `swarm-review:pass` label
   - phase-tier2-smoke runs in stub mode (manual trigger for now)
6. Verify: every transition lands the expected label, every comment
   includes the expected verdict, no PR is blocked.

**Rollback**: remove the wrapper workflows; `audit_skills.acm.required:
false` and `audit_skills.swarm` deletion. Existing flows resume.

## Stage 2 — Wire entry rows + flip ACM to live (50 issues, stub elsewhere)

After Stage 1 has executed cleanly on ~5 sandbox issues:

1. In `lib/orchestrator.ts`, replace the existing
   `state:spec-ready /approve → state:implementing` row with
   `state:spec-ready /approve → state:acm-building`. Replace
   `state:implementing workflow-pr-open → state:pr-review` with
   `state:implementing workflow-pr-open → state:swarm-reviewing`.
   Replace `state:staging-deployed smoke-pass-staging →
   state:ready-to-promote` with `state:staging-deployed
   smoke-pass-staging → state:tier2-smoke`. The pending-canary
   reachability invariant test in
   `tests/unit/orchestrator-invariants.test.ts` will fail until you
   remove the `PENDING_CANARY_STATES` exception — that's the canary
   barrier; flipping it is the explicit canary commit.
2. In the canary repo's `.dev-agent.yml`, set
   `audit_skills.acm.invocation_mode: live`. Run for 50 clean issues.
3. Track precision: how many ACM verdicts (pass / fail / blocked) match
   the operator's manual judgment? Target ≥ 90%. If lower, hold here
   and tune `prompts/acm.md` + `prompts/acm-test-agent.md`.

**Rollback**: revert the orchestrator commit. Issues mid-flight in the
new states get unstuck via `lib/cli/orch-unstick.ts` (`TARGET_STATE=
state:blocked` for the ACM ones; `state:pr-review` for the swarm ones).

## Stage 3 — Flip swarm + tier-2 to live mode (still advisory)

After Stage 2 has executed cleanly on 50 issues:

1. Flip `phase-swarm-review.yml` invocation_mode to `live` per consumer
   (in their wrapper). Step 12b's claude-code-action wiring is required
   — that lands separately.
2. Same for `phase-tier2-smoke.yml`.
3. Keep `audit_skills.swarm.fail_open: true` (advisory).
4. Run for 30 issues. Track:
   - swarm verdict precision (target ≥ 65% per Augment's published
     baseline)
   - tier-2 verdict precision (the Potemkin-catching rate — track
     against operator-reported false-negatives)
   - per-finding confidence scores
   - `/swarm-override` usage rate (high rate = noisy reviewers; tune)

**Rollback**: flip back to stub mode in the wrappers; live verdicts
stop firing.

## Stage 4 — Flip to enforcing

After Stage 3 has executed cleanly on 30 issues with acceptable
precision:

1. Flip `audit_skills.swarm.fail_open: false` in default config
   (`examples/web-app-template/.dev-agent.yml`).
2. The PR-merge gate now blocks on `swarm-review:fail`. The escape
   hatch is `/swarm-override <reason>` (handled by phase-pr-review.yml's
   sibling job). Authorized actors: anyone with write access to the
   consumer repo (GitHub's permission model), excluding the bots.
3. Same flip for tier-2 smoke gate (state:tier2-smoke → state:blocked
   on tier2-fail becomes hard).
4. Monitor `/swarm-override` rate weekly. Goal: < 10% of swarm-fail
   verdicts get overridden — higher means the reviewers are too noisy
   for the gate to be trusted.

**Rollback**: flip `fail_open: true` per consumer. Override-pending
PRs that already received `swarm-overridden` keep their override; new
PRs go back to advisory.

## Kill switches

In any stage, the universal kill switch is the env var
`DEV_AGENT_GATE_KILL_SWITCH` set as a repo secret. Honored values:
- `acm` — bypass phase-acm (skips state:acm-building)
- `swarm` — bypass phase-swarm-review (skips state:swarm-reviewing)
- `tier2` — bypass phase-tier2-smoke (skips state:tier2-smoke)
- Comma-combinations: `acm,swarm,tier2` (full bypass)

Wiring of the kill switch into the phase workflows is shipped with the
respective phases (the workflow `if:` conditions check the env). Phase
workflows that don't yet honor the env will be updated alongside step
12b's live-mode flip.

## Audit + monitoring

- Every gate verdict (`acm-pass/fail`, `swarm-pass/concern/fail`,
  `tier2-pass/fail`) lands as a labeled issue/PR comment. GitHub's
  comment history is the v1 audit trail.
- Every `/swarm-override` posts a structured comment with actor +
  reason + timestamp (see phase-pr-review.yml's `swarm-override` job).
- v1.1 will mirror these into `lib/events.ts`'s JSONL log alongside
  cost-watchdog wiring (deferred from step 15).

## Cost ceiling

Per-issue rough cost (live mode, full pipeline):
- ACM (Sonnet, 30 turns × ~$0.02/turn): ~$0.60
- self-review (Haiku, 1 call): ~$0.10
- evidence-collector (deterministic, runtime only): $0
- swarm 3× Haiku in parallel: ~$0.30
- meta-reviewer (Sonnet, only if pass+fail mix): ~$0.05
- tier-2 (Sonnet, Playwright probe): ~$0.40

Total: ~$1.50 per feature.

Repo-level monthly budget: set `cost_caps.monthly_budget_usd` in
`.dev-agent.yml` (default $200). v1.1's cost-watchdog will alert at 75%
and hard-stop new phase invocations at 100%.
