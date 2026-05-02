# dev-agent — Portable Agentic Feature Development System

**Date:** 2026-05-02
**Owner:** ali.zaouane@hotmail.com
**Status:** Approved (brainstormed 2026-05-02). Phase 0 complete — repo bootstrapped at `/Users/alizaouane/Documents/Qualiency/dev-agent/`.
**Scope:** Strategic infrastructure (~8–10 weeks across 5 phases). Reusable across all Qualiency-owned projects.
**Working name:** `dev-agent`. Not yet trademarked / final — can be renamed before public release.

> Caliente Booking and Qualiency App repos are NOT touched in Phase 1. Caliente becomes the first real consumer in Phase 2; Qualiency App is a candidate 2nd consumer in Phase 4.

---

## Context

**Problem.** Today every feature requires the human to be the *operator* of the workflow — drafting specs, writing plans, branching, scaffolding, running tests, opening PRs, deploying staging, promoting to prod, updating docs. The Caliente repo has skills for individual phases (`movra-promote`, `movra-deploy-both`, `movra-pitfall-check`, `movra-new-edge-function`, `movra-new-migration`, `movra-protocol-router`) but no orchestration layer. Other Qualiency projects don't even have those primitives. Result: human time is consumed by mechanical busywork instead of judgment moments (intent capture, code review, prod risk decisions). Process violations are easy because no system enforces order (cf. recent staging-first PR gate post-mortem).

**Qualiency owns multiple software projects.** Building a Caliente-only orchestrator would solve 1 problem and leave N-1. Whatever we build needs to be reusable across all current and future Qualiency-owned repos with project-specific behavior expressed as configuration, not code.

**Intended outcome.** A portable agentic system, packaged as a Claude Code plugin + reusable GitHub workflows + per-repo config schema, where the human is *only* the orchestrator. They drop intent (or accept agent-proposed intent), review at three gates (spec, PR, prod promote), and otherwise let agents do the work. Multiple features can be in flight in parallel within a project, and the same system serves any Qualiency repo.

---

## Goals

- Automate end-to-end feature/improvement lifecycle for both single-PR features and multi-PR programs.
- **Portable**: install via `claude plugin install dev-agent` + `dev-agent init` in any repo. Per-repo config (`.dev-agent.yml`) handles all project-specific behavior.
- Compress human time per feature to: ~10–30 min on intent/spec brainstorm, ~10–15 min on PR review, ~5 min on prod promote.
- Parallel features within a repo + same system serves multiple Qualiency repos.
- Surface proactive opportunities (scout) without being noisy.
- Production-grade from day one: bounded autonomy, rollback at every phase, full cost/duration telemetry per feature.
- Versioned releases: consumer repos pin to `@v1`, `@v2`, etc.

## Non-Goals

- Replacing human judgment at the 3 gates.
- Automating production incident response (SRE-flavored, separate concern).
- Replacing existing skills — the plugin *chains* per-repo skills, doesn't duplicate them.
- Multi-repo orchestration of a *single* feature spanning multiple repos.
- Replacing `/start` and `/done` workflows for ad-hoc manual sessions in any consumer repo.
- Public open-source release in this design — could happen later, but initial scope is single-user (the user) + N Qualiency-owned projects.

## Constraints

- Honor each consumer repo's existing constraints (e.g., Caliente's staging-first PR gate, dual-Supabase deploy, `--no-verify-jwt`).
- The plugin must NEVER hardcode project-specific behavior. Everything that varies between projects lives in `.dev-agent.yml` or `agentic/skills/` overrides within the consumer repo.
- Spec-first discipline (per user feedback memory): no plan starts without a spec.
- Pre-commit gates and CI must remain enforceable in each consumer repo.
- The dev-agent repo lives at `/Users/alizaouane/Documents/Qualiency/dev-agent/` — sibling to the existing Qualiency App marketing site, **not** inside it. Distinct GitHub remote.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  PRODUCT REPO (single, versioned, reusable across N projects)         │
│                                                                      │
│  alizaouane/dev-agent                                                │
│  on disk: /Users/alizaouane/Documents/Qualiency/dev-agent/           │
│                                                                      │
│  Plugin (Claude Code-installable):                                   │
│  · 8 slash commands  (incl. /dev-agent-init)                         │
│  · 4 plugin skills   (orchestrator, scout, drift-check, notify)      │
│  · 7 prompt templates (per phase)                                    │
│  · `.dev-agent.yml` schema + defaults + label vocabulary             │
│                                                                      │
│  Reusable GitHub workflows (in this repo's `.github/workflows/`,     │
│  consumed by other repos via `uses: alizaouane/dev-agent/...@vN`):   │
│  · phase-implement.yml                                               │
│  · phase-staging-deploy.yml                                          │
│  · phase-promote-to-prod.yml                                         │
│  · phase-smoke-verify.yml (reusable workflow_call)                    │
│  · phase-rollback.yml                                                │
│  · orch-sweep.yml (cron */10 * * * *, polling fallback)              │
│                                                                      │
│  Synthetic test consumer:                                            │
│  · examples/test-repo/  — dev/test loop without Caliente             │
│                                                                      │
│  Versioning: `git tag v0.1.0`, `v0.2.0`, …                            │
└────────────────────────┬─────────────────────────────────────────────┘
                         │
       `claude plugin install` + `uses: …@vN`
                         │
                         ▼
   ┌────────────────────────────────────────────────────────────┐
   │  CONSUMER REPO (e.g., Caliente, Qualiency App, future …)    │
   │                                                            │
   │  · .dev-agent.yml      — config (test cmd, deploy skills,  │
   │     blocked paths, cost caps, scout sources, branch flow)  │
   │  · .github/workflows/dev-agent-*.yml  — 3-line wrappers    │
   │  · agentic/skills/      — project-specific skills           │
   │     (e.g., Caliente has movra-* here)                      │
   │  · agentic/prompts/    — optional prompt overrides          │
   │  · GitHub issues       — per-repo state machine             │
   └────────────────────────────────────────────────────────────┘
```

### Why this shape

1. **Claude Code plugin = the established cross-repo distribution unit.** User already uses `superpowers`, `feature-dev`, `code-review`, `frontend-design`, `huggingface-skills`, `supabase` plugins. `claude plugin install dev-agent` is muscle memory.
2. **Single-repo monorepo (plugin + workflows together)** = simpler for a single user. One tag bump = synchronized release. Splitting into two repos can come later if workflows need independent versioning.
3. **GitHub-issue-as-state-machine = won the agentic state-management battle** (Copilot Workspace, Sweep, Cursor). Per-repo issues = isolated state per project, no shared DB.
4. **`.dev-agent.yml` is the contract** between plugin and consumer. Everything project-specific is here.
5. **scheduled-tasks MCP for the scout = recurring background work** that doesn't require holding a terminal session.
6. **Lives in `Qualiency/` umbrella** because Qualiency owns all the user's projects — natural organizational home, sibling to App.

---

## The `.dev-agent.yml` config schema (the contract)

Every consumer repo has one of these. The plugin reads it; reusable workflows read it; nothing else needed.

```yaml
# .dev-agent.yml — schema v1
schema_version: 1

# Stack-shape descriptors — what commands does this project use?
commands:
  test: "npm run test"
  test_unit: "npm run test:unit"
  test_contract: "npm run test:contract"
  test_integration: "npm run test:integration"
  test_components: "npm run test:components"
  test_e2e: "npm run test:e2e"
  build: "npm run build"
  typecheck: "npm run typecheck"
  lint: "npm run lint"  # optional

# Branch / release flow
branches:
  default: main
  staging: staging              # null if no staging-first
  release_target: main          # PR target after staging green
  release_pr_required: true

# Per-phase skills to chain (in order). Plugin invokes these by name.
deploy_skills:
  staging:
    - movra-deploy-both
  prod:
    - movra-promote
audit_skills:
  pre_pr:
    - movra-pitfall-check
    - movra-protocol-router
scaffold_skills:
  edge_function: movra-new-edge-function
  migration: movra-new-migration

# Where the project's spec/plan/status artifacts live
artifacts:
  specs_dir: docs/superpowers/specs
  plans_dir: docs/superpowers/plans
  status_file: docs/superpowers/program-status.md
  runbooks_dir: docs/runbooks

# Diff scope guardrails (overrides plugin defaults)
guardrails:
  blocked_paths:
    - supabase/migrations/**
    - supabase/functions/_shared/authz.ts
    - supabase/functions/_shared/payment-method-resolver.ts
    - .github/workflows/promote-to-prod.yml
    - .claude/hooks/staging-first-pr-gate.sh
  require_explicit_unlock:
    - tests/integration/**
    - docs/runbooks/**
  max_files_changed: 30
  max_lines_changed: 800
  scope_creep_thresholds:
    files_outside_spec_scope: 0
    loc_outside_spec_scope: 50
  trivial_cleanup_categories:
    - formatting
    - import-sort
    - dead-code-removal
    - comment-fix

# Per-phase cost caps
cost_caps:
  spec_brainstorm: { tokens_in: 100000, tokens_out: 30000, dollars: 3 }
  implement:       { tokens_in: 200000, tokens_out: 100000, dollars: 5 }
  staging_deploy:  { tokens_in: 50000,  tokens_out: 20000, dollars: 1 }
  promote_to_prod: { tokens_in: 75000,  tokens_out: 30000, dollars: 1.5 }
  smoke_verify:    { tokens_in: 30000,  tokens_out: 10000, dollars: 0.5 }
  scout_digest:    { tokens_in: 100000, tokens_out: 20000, dollars: 0.5 }
  rollback:        { tokens_in: 50000,  tokens_out: 20000, dollars: 1 }

# Multi-model routing
models:
  scout: claude-haiku-4-5
  triage: claude-haiku-4-5
  smoke_analysis: claude-haiku-4-5
  drift_detection: claude-haiku-4-5
  notification: claude-haiku-4-5
  implementation: claude-sonnet-4-6
  staging_deploy: claude-sonnet-4-6
  promote_to_prod: claude-sonnet-4-6
  rollback: claude-sonnet-4-6
  spec_brainstorm: claude-opus-4-7
  ambiguous_failure: claude-opus-4-7

# Scout configuration (Phase 3 of plugin build)
scout:
  enabled: true
  cron: "0 9 * * *"
  sources:
    - github_issues
    - vercel_logs:
        project: "caliente-booking"
    - supabase_logs:
        project_ids: ["rjovfczyvtggmvkrtaoe"]
    - codebase_audit:
        pitfalls_path: CLAUDE.md
        max_age_days: 30
    - competitive:
        feeds: []  # list of URLs (RSS, etc.)
  suppression:
    track_rejections: true
    suppress_after_n_rejects: 3

# Notification fan-out
notifications:
  push:
    provider: ntfy.sh             # or pushover, slack-webhook
    topic: alizaouane-dev-agent
  email:
    via: resend
    secret_name: RESEND_API_KEY
    to: ali.zaouane@hotmail.com
  github_issue: true              # always on
  status_file: true               # always on

# Hotfix path (skips spec gate)
hotfix:
  enabled: true
  required_label: "kind:hotfix"
  skip_spec: true
  skip_drift_check: false
```

The plugin ships with `schema/defaults.yml` supplying values when `.dev-agent.yml` omits them. Per-repo overrides take precedence.

---

## Components

### A. The product repo: `alizaouane/dev-agent`

On disk: `/Users/alizaouane/Documents/Qualiency/dev-agent/`. Structure:

```
dev-agent/
├── .claude/
│   └── plugin.json                     # plugin manifest (name, version, schemas)
├── .github/
│   └── workflows/                       # reusable workflows + this repo's CI
│       ├── phase-implement.yml          # consumer-callable via uses: alizaouane/dev-agent/...@v1
│       ├── phase-staging-deploy.yml
│       ├── phase-promote-to-prod.yml
│       ├── phase-smoke-verify.yml
│       ├── phase-rollback.yml
│       ├── orch-sweep.yml
│       └── ci.yml                        # CI for the dev-agent repo itself (lint plugin files, schema validation, run examples/test-repo)
├── commands/                             # slash commands (markdown files)
│   ├── dev-agent-init.md                 # one-time setup in a fresh consumer repo
│   ├── develop.md
│   ├── proposals.md
│   ├── status.md
│   ├── approve.md
│   ├── abandon.md
│   ├── rollback.md
│   └── digest.md
├── skills/                               # plugin-internal skills
│   ├── orchestrator/SKILL.md             # core state-transition logic
│   ├── scout/SKILL.md                    # scout source adapters + digest
│   ├── drift-check/SKILL.md              # diff-vs-spec scope check
│   └── notify/SKILL.md                   # 4-channel fan-out
├── prompts/                              # default prompt templates per phase
│   ├── implement.md
│   ├── staging-deploy.md
│   ├── promote-to-prod.md
│   ├── smoke-verify.md
│   ├── rollback.md
│   ├── scout-digest.md
│   └── drift-check.md
├── schema/
│   ├── dev-agent.schema.yml              # JSON schema for .dev-agent.yml
│   ├── label-vocabulary.yml              # canonical state/kind/priority labels
│   └── defaults.yml                       # default config values
├── lib/                                   # helper scripts called by workflows
│   ├── notify.ts                          # 4-channel notification fan-out
│   ├── parse-config.ts                    # .dev-agent.yml parser + schema validation
│   └── telemetry.ts                       # per-phase cost/token logging
├── examples/
│   └── test-repo/                         # synthetic consumer for plugin dev/test
│       ├── .dev-agent.yml                 # mock config (test/build/deploy commands echo)
│       └── .github/workflows/             # wrappers calling parent repo workflows
├── docs/
│   └── specs/
│       └── 2026-05-02-dev-agent-design.md # this design (created in Step 0)
├── README.md                              # how to install + how to use + version compat matrix
├── package.json                           # TypeScript helper scripts; tsx-runnable
├── tsconfig.json
└── .gitignore
```

Consumer references (e.g., from Caliente's `.github/workflows/dev-agent-implement.yml`):

```yaml
name: dev-agent · phase-implement
on:
  issues:
    types: [labeled]
jobs:
  implement:
    if: github.event.label.name == 'state:implementing'
    uses: alizaouane/dev-agent/.github/workflows/phase-implement.yml@v1
    with:
      issue_number: ${{ github.event.issue.number }}
      config_path: .dev-agent.yml
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
      NTFY_TOPIC: ${{ secrets.NTFY_TOPIC }}
```

That's the entire integration. The reusable workflow handles the rest.

### B. Consumer repo: e.g., Caliente (Phase 2)

What gets added when a project onboards via `dev-agent-init`:

```
caliente-booking/
├── .dev-agent.yml                          # all per-repo config
├── .github/workflows/                      # 3-line wrappers
│   ├── dev-agent-implement.yml
│   ├── dev-agent-staging-deploy.yml
│   ├── dev-agent-promote-to-prod.yml
│   ├── dev-agent-smoke-verify.yml
│   ├── dev-agent-rollback.yml
│   └── dev-agent-orch-sweep.yml
├── agentic/                                 # optional project overrides
│   ├── prompts/                            # override default prompts (rare)
│   └── skills/                             # project-specific skills
│       └── movra-promote/                  # (already exists in Caliente)
└── …rest of project unchanged
```

### C. Slash commands (in plugin, callable from any consumer)

| Command | Behavior |
|---|---|
| `/dev-agent-init` | One-time bootstrap in a fresh consumer repo. Reads stack hints (package.json, supabase config, etc.), generates a starter `.dev-agent.yml`, creates 6 GH workflow wrappers, runs `gh label create` for state vocabulary, opens PR for review. |
| `/develop <intent\|issue-url\|empty>` | Creates GH issue (label `state:scoping`), runs spec brainstorm with Opus, writes spec per `artifacts.specs_dir`, links from issue, relabels `state:spec-ready`. |
| `/proposals` | Lists open `kind:scout-proposal` items. Triage actions advance them. |
| `/status` | Tabular view: title / state / age / cost / blockers. Reads issues filtered by state labels + the `status_file`. |
| `/approve <issue#> [--promote]` | Advances gate. Transitions: `spec-ready→implementing`, `pr-review→staging-deployed` (after PR merge), `ready-to-promote→promoting`. |
| `/abandon <issue#>` | Cleans up: closes PR, archives spec, relabels `state:abandoned`. |
| `/rollback <issue#>` | Triggers `phase-rollback.yml` workflow. |
| `/digest` | Triggers scout to run now. |

### D. Notification fan-out (`lib/notify.ts`)

Single function `notify(issue_num, gate_kind, payload)` invoked by phase workflows at gate transitions. Channels (configured via `notifications` in `.dev-agent.yml`):
- **Push**: ntfy.sh (default), Pushover, or Slack webhook (HTTP-based, callable from GH Actions)
- **Email**: Resend (consumer's existing key)
- **GitHub issue comment** (always on)
- **Status file** at `artifacts.status_file` (always on)

Note: Claude Code's built-in `PushNotification` tool is NOT used here because GH Actions can't invoke it — it remains available for in-session Claude Code use (e.g., `/status` or `/proposals` results).

---

## State machine

```
              USER /develop                 SCOUT proposes
                    │                          │
                    │                          ▼
                    │              ┌──────────────────────┐
                    │              │ state:proposed       │
                    │              │ kind:scout-proposal  │
                    │              └──────────┬───────────┘
                    │                         │ user accepts via /proposals
                    │                         ▼
                    └────────────►┌──────────────────────┐
                                  │ state:scoping        │
                                  └──────────┬───────────┘
                                             │ /develop runs spec brainstorm
                                             ▼
                                  ┌──────────────────────┐
                                  │ state:spec-ready     │ ◄── GATE 1
                                  └──────────┬───────────┘
                                             │ /approve
                                             ▼
                                  ┌──────────────────────┐
                                  │ state:implementing   │ ── phase-implement.yml
                                  └──────────┬───────────┘
                                             │ workflow opens PR
                                             ▼
                                  ┌──────────────────────┐
                                  │ state:pr-review      │ ◄── GATE 2
                                  └──────────┬───────────┘
                                             │ user merges PR + /approve
                                             ▼
                                  ┌──────────────────────┐
                                  │ state:staging-       │ ── phase-staging-deploy.yml
                                  │ deployed             │
                                  └──────────┬───────────┘
                                             │ smoke passes
                                             ▼
                                  ┌──────────────────────┐
                                  │ state:ready-to-      │ ◄── GATE 3
                                  │ promote              │
                                  └──────────┬───────────┘
                                             │ /approve --promote
                                             ▼
                                  ┌──────────────────────┐
                                  │ state:promoting      │ ── phase-promote-to-prod.yml
                                  └──────────┬───────────┘
                                             │ prod smoke passes
                                             ▼
                                  ┌──────────────────────┐
                                  │ state:done           │ (issue closed)
                                  └──────────────────────┘

  Hotfix path (consumer's `.dev-agent.yml.hotfix.enabled = true`):
  · `kind:hotfix` issue skips spec gate, goes straight to `state:implementing`

  Failure paths (reachable from any *ing state):
  · state:blocked      — escalation, diagnostic in issue comment
  · state:abandoned    — user-triggered via /abandon
  · state:rolled-back  — after /rollback completes
```

Canonical labels (created by `dev-agent-init` via `gh label create`):
- States: `state:proposed`, `state:scoping`, `state:spec-ready`, `state:implementing`, `state:pr-review`, `state:staging-deployed`, `state:ready-to-promote`, `state:promoting`, `state:done`, `state:blocked`, `state:abandoned`, `state:rolled-back`
- Kind: `kind:user-intent`, `kind:scout-proposal`, `kind:scout-digest`, `kind:hotfix`
- Priority: `priority:p0`, `priority:p1`, `priority:p2`, `priority:p3`

---

## Best-practice mechanisms (built into plugin / workflows)

### Multi-model routing

Plugin reads `models:` from `.dev-agent.yml` (with defaults from `schema/defaults.yml`). Each phase routine selects model accordingly.

| Role | Default model | Reason |
|---|---|---|
| Scout digest, triage, smoke analysis, drift detection, notification | `claude-haiku-4-5` | High volume, low judgment. ~$0.05/digest. |
| Implementation, staging-deploy, promote-to-prod, rollback | `claude-sonnet-4-6` | Standard coding work. |
| Spec brainstorming, ambiguous failure analysis | `claude-opus-4-7` | Hard reasoning at gates 1 + escalations. |

### Cost caps

Plugin reads `cost_caps:` from `.dev-agent.yml`. Each phase enforces input-tokens / output-tokens / dollar caps. On cap hit → abort + label `state:blocked` + comment.

Per-phase telemetry comment posted to issue:
```
🤖 Phase: implement
Model: claude-sonnet-4-6
Duration: 12m 34s
Tokens: 145k in / 67k out
Cost: $2.31
Attempts: 1
Status: success
Artifacts:
  - branch: feature/refund-button
  - PR: #142
  - tests: 12 added, 0 failing
  - drift-check: clean
```

### Diff scope guardrails

Plugin reads `guardrails:` from `.dev-agent.yml`. `phase-implement.yml` enforces before push: blocked paths, require_explicit_unlock paths, max_files_changed, max_lines_changed. Violation → abort + label `state:blocked`.

### Drift detection

Plugin runs `prompts/drift-check.md` (Sonnet) on diff vs spec after implementation. Compares scope. If `files_outside_spec_scope > 0` (excluding `trivial_cleanup_categories`) → abort + label `state:blocked` + comment.

### Rollback

`phase-rollback.yml`:
1. Find merge commit via PR linked from issue
2. `git revert -m 1 <merge-sha>` → push to `staging` branch (or default branch if no staging)
3. Open release PR for the revert
4. After merge: redeploy artifacts from prior commits via consumer's deploy skills
5. Run paired `_rollback.sql` migrations if any (best-practice: every new migration ships with one)
6. Run prod smoke
7. Label `state:rolled-back`, comment timeline

### Bounded auto-fix (failure handling)

- **Deterministic failures** (typecheck, lint, simple test red→green): up to 3 self-heal attempts.
- **Ambiguous failures** (smoke fail, OCC conflict, repeated test failure with shifting cause, pitfall trip with unclear root cause): immediate escalation, label `state:blocked`.
- **Time cap**: 30 min wall clock per phase. Cap → escalate.
- **Cost cap**: per `cost_caps:` config. Cap → abort + escalate.

---

## Implementation phasing

### Phase 1 (3–4 weeks): Build dev-agent repo against synthetic consumer

**Goal:** End-to-end orchestration works against `examples/test-repo/` (a tiny synthetic project with mocked test/build/deploy commands). NO real-world consumer yet.

**Build (in `/Users/alizaouane/Documents/Qualiency/dev-agent/`):**
- Repo scaffolding: `git init`, `gh repo create alizaouane/dev-agent`, `package.json`, `tsconfig.json`, `.gitignore`, `README.md`
- Plugin manifest (`.claude/plugin.json`)
- All 8 slash commands (`commands/*.md`)
- All 4 skills (`skills/orchestrator`, `skills/scout`, `skills/drift-check`, `skills/notify`)
- All 7 prompt templates (`prompts/*.md`)
- Schema files (`schema/dev-agent.schema.yml`, `label-vocabulary.yml`, `defaults.yml`)
- Helper scripts (`lib/notify.ts`, `parse-config.ts`, `telemetry.ts`)
- All 6 reusable GitHub workflows (`.github/workflows/phase-*.yml`, `orch-sweep.yml`)
- CI for the dev-agent repo itself (`.github/workflows/ci.yml` — lints, schema validation, runs examples/test-repo loop)
- Synthetic test consumer (`examples/test-repo/`)

**Validation:**
- Install plugin into `examples/test-repo/`
- Run `/dev-agent-init` → confirms config + workflows + labels created
- Run `/develop "test feature"` against test-repo → spec generated → `/approve` → phase-implement runs against mocked commands → green PR opened → cost telemetry comment posted
- Drift detection: synthetic test where prompt forces agent to touch out-of-scope files → drift catches it
- Cost cap: simulate runaway loop → cap triggers abort
- Rollback: `/rollback` against test PR → revert flow runs

**End state:** dev-agent repo is tagged `v0.1.0` and proven to work end-to-end against a clean-room consumer. No real-world repo (Caliente, Qualiency App) has been touched yet.

### Phase 2 (1–2 weeks): Install into Caliente as first real consumer

**Goal:** Caliente uses dev-agent for real feature work. Phase 1's abstractions get tested against real-world complexity.

**Build (in Caliente repo):**
- Run `/dev-agent-init` in Caliente → review and tune generated `.dev-agent.yml`
- Wire Caliente's `movra-*` skills into `deploy_skills` / `audit_skills` / `scaffold_skills` config sections
- Verify staging-first PR gate hook still fires (workflows respect, don't bypass it)
- Migrate the existing `docs/superpowers/specs/` and `docs/superpowers/program-status.md` paths into `.dev-agent.yml.artifacts:`
- Tune `guardrails.blocked_paths` to match Caliente specifics (auth, payment_method_resolver, migrations)
- Test with one small feature end-to-end

**Validation:**
- Ship 3 real Caliente features via dev-agent: one tiny (copy change), one medium (new edge function), one with migration
- Observe friction: missing config knobs, missing skills hooks, drift false positives
- File issues against dev-agent for fixes; release `v0.2.0` with patches in dev-agent repo
- Caliente updates its tag pin to `@v0.2`

**End state:** Caliente is shipping real features through dev-agent. dev-agent matures from `v0.1` to `v0.2+` based on real signal. Acceptance: 3+ features shipped without significant manual intervention between gates.

### Phase 3 (1–2 weeks): Scout

**Goal:** Daily scout proactively proposes features.

**Build (in dev-agent repo):**
- Scout scheduled-tasks routine (Haiku model) packaged as part of plugin
- Source adapters in `skills/scout/`: GH issues / Vercel logs / Supabase logs / codebase audit / competitive feeds
- Daily digest issue template + `kind:scout-digest` label handling
- Suppression learning: track rejections, suppress similar in future digests
- `/proposals` slash command finalized
- Release `v0.3.0`

**Validation:**
- Install scout in Caliente — runs daily for 2 weeks
- ≥3 candidate categories per digest, mix of bug fixes / tech debt / new features
- Suppression: 4th similar rejected proposal is suppressed
- ≥1 scout-proposed feature shipped end-to-end in those 2 weeks

### Phase 4 (1 week): Install into a 2nd Qualiency project

**Goal:** Real portability test. Identifies abstraction gaps Caliente couldn't reveal.

**Candidates for 2nd consumer (user picks):**
- Qualiency App itself (the marketing site at `Qualiency/App/`) — different stack (Next.js, no Supabase, no staging branch), tests that the abstractions actually work for non-Supabase projects
- A new Qualiency project (TBD)
- An open-source contribution — would test public-facing onboarding

**Build:**
- Pick the 2nd project
- Run `/dev-agent-init` → tune `.dev-agent.yml` for that project's stack
- Add any project-specific skills to `agentic/skills/` (likely none for a vanilla Next.js site)
- Ship 1–2 features end-to-end

**Validation:**
- Time from `dev-agent-init` to first green PR: target <1 day
- Per-repo customization confined to `.dev-agent.yml` + `agentic/skills/` (no plugin code edits required)
- File issues for any plugin gaps; release `v0.4.0`

### Phase 5 (ongoing): Hardening

- Versioning policy (semver, breaking-change protocol)
- README + onboarding docs in dev-agent repo
- Cost telemetry across-project rollup (single dashboard for all Qualiency repos — could live as a route in Qualiency App)
- Optional: open-source release

---

## Critical files

**New repo: `alizaouane/dev-agent`** at `/Users/alizaouane/Documents/Qualiency/dev-agent/`
- `.claude/plugin.json`
- `commands/{dev-agent-init,develop,proposals,status,approve,abandon,rollback,digest}.md`
- `skills/{orchestrator,scout,drift-check,notify}/SKILL.md`
- `prompts/{implement,staging-deploy,promote-to-prod,smoke-verify,rollback,scout-digest,drift-check}.md`
- `schema/{dev-agent.schema.yml,label-vocabulary.yml,defaults.yml}`
- `lib/{notify.ts,parse-config.ts,telemetry.ts}`
- `.github/workflows/{phase-implement,phase-staging-deploy,phase-promote-to-prod,phase-smoke-verify,phase-rollback,orch-sweep,ci}.yml`
- `examples/test-repo/` — synthetic consumer
- `docs/specs/2026-05-02-dev-agent-design.md` — this design (Step 0)
- `README.md`, `package.json`, `tsconfig.json`, `.gitignore`
- Tag `v0.1.0` after Phase 1 validation

**Modified in Caliente (Phase 2):**
- `.dev-agent.yml` (new file at repo root)
- `.github/workflows/dev-agent-*.yml` (6 thin wrappers)
- `agentic/` directory (project-specific overrides if any)
- `CLAUDE.md` — add "Agentic Feature Dev (dev-agent)" section
- Optional: enhance `.claude/skills/movra-new-migration/` to scaffold paired `_rollback.sql`

**Reused in Caliente (untouched):**
- All `movra-*` skills as deploy/audit/scaffold primitives
- `.claude/hooks/staging-first-pr-gate.sh`
- Existing `.github/workflows/{ci,smoke-test,promote-to-prod}.yml`
- `/start`, `/done`, `/spec`, `/wirecheck` slash commands

**Untouched in Phase 1:**
- Caliente repo
- Qualiency App repo (`/Users/alizaouane/Documents/Qualiency/App/`)

---

## Acceptance criteria

**Phase 1 (dev-agent repo in isolation):**
- [ ] `claude plugin install /Users/alizaouane/Documents/Qualiency/dev-agent/` succeeds
- [ ] `/dev-agent-init` in `examples/test-repo/` generates valid `.dev-agent.yml` + 6 workflow wrappers + labels
- [ ] `/develop` runs spec brainstorm + writes spec file + relabels `state:spec-ready`
- [ ] `/approve` triggers `phase-implement.yml` against test-repo
- [ ] Phase-implement opens green PR within cost cap; drift-check clean
- [ ] Cost telemetry comment includes all 6 fields (model, duration, tokens_in, tokens_out, cost_usd, attempts)
- [ ] Drift detection rejects synthetic scope-creep test
- [ ] Cost cap aborts simulated runaway loop
- [ ] Guardrails block touching synthetic blocked-path file
- [ ] `/abandon` cleans up properly
- [ ] `/rollback` against synthetic shipped feature reverts cleanly
- [ ] Repo tagged `v0.1.0`; consumers can reference `uses: alizaouane/dev-agent/.github/workflows/phase-implement.yml@v1`

**Phase 2 (Caliente as first consumer):**
- [ ] `/dev-agent-init` in Caliente generates correct config (staging-first respected, dual-Supabase deploy wired)
- [ ] 3 real Caliente features shipped via dev-agent: tiny / medium / migration-touching
- [ ] Staging-first PR gate hook continues firing; phase workflows respect it
- [ ] No edits to dev-agent code required; all customization via `.dev-agent.yml`
- [ ] All existing Caliente CI / `/start` / `/done` continue working

**Phase 3 (scout):**
- [ ] Scout runs daily at 9am, posts digest issue with ≥3 candidate categories
- [ ] Suppression: 4th similar rejected proposal suppressed
- [ ] ≥1 scout-proposed feature shipped end-to-end during a 2-week observation

**Phase 4 (2nd Qualiency project install):**
- [ ] Time from `dev-agent-init` to first green PR < 1 day
- [ ] Per-repo customization confined to `.dev-agent.yml` + `agentic/skills/`
- [ ] No plugin code edits required

---

## Open questions / risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Anthropic API cost across N projects** — phase workflows consume tokens, paid per-call. | Per-phase cost caps + Haiku for cheap roles + cross-project telemetry rollup in Phase 5. Anthropic monthly budget alarm. |
| 2 | **Webhook reliability** — GitHub webhooks ~99%. | `orch-sweep.yml` 10-min polling fallback catches misses. |
| 3 | **Abstraction gaps** — Phase 1 builds against synthetic consumer; real Caliente reveals gaps Phase 2 can't predict. | Phase 2 explicitly time-boxed (1–2 wks) to absorb gap fixes. dev-agent version bumps `v0.1→v0.2` based on real signal. |
| 4 | **Per-repo skill discovery** — plugin needs to find project-specific skills (movra-* in Caliente, different ones elsewhere). | `.dev-agent.yml.deploy_skills` etc. names skills; plugin loads them from `agentic/skills/` first, falls back to `.claude/skills/`, fails if not found. |
| 5 | **Migration rollback discipline** — best-practice rollback requires paired `_rollback.sql`. | `scaffold_skills.migration` config points at a project's migration scaffolder; consumers ensure it generates rollback files. Caliente: enhance `movra-new-migration`. |
| 6 | **Drift detection false positives** — flags legitimate cleanup. | `trivial_cleanup_categories` whitelist in `.dev-agent.yml` (configurable per project). |
| 7 | **Scout digest fatigue** | Suppression learning + per-project source filtering in `.dev-agent.yml.scout.sources`. |
| 8 | **Plugin development workflow** — testing dev-agent without breaking Caliente. | Phase 1 uses synthetic test-repo. Caliente pinned via tag (`@v0.1`); updates require explicit tag bump. Branch-based dev. |
| 9 | **Versioning collisions** — consumer pinned to `@v1` but `v2` has breaking change. | Semver discipline. Breaking changes only on major bumps. `schema_version` in `.dev-agent.yml` so plugin can detect mismatch. |
| 10 | **Hotfix path** — emergency fixes need to bypass spec gate but still apply guardrails. | `hotfix.enabled = true` + `kind:hotfix` label in `.dev-agent.yml` skips spec, applies relaxed drift thresholds. |
| 11 | **Cross-project state collisions** — features in different projects must not share state. | State is per-repo (GitHub issues are repo-scoped). Plugin's `/status` filters by `cwd`. |
| 12 | **Open-sourcing later** — if user wants to share/sell, single-user assumptions need to relax. | Architecture supports multi-user from day 1 (per-repo config, no shared infra). User-secrets-based auth. Defer auth/team features to Phase 5+. |
| 13 | **GitHub repo name** — `alizaouane/dev-agent` may collide with future open-sourcing or Qualiency branding. | Working name, can be renamed before public release. Alternative: `alizaouane/qualiency-dev-agent` (more brand-tied). User decides at Step 0. |

---

## Verification

**Phase 1:**
- Manual: full lifecycle in `examples/test-repo/` — `/develop test feature` → `/approve` → phase-implement → review PR → simulate merge → phase-staging-deploy (mocked) → `/approve --promote` → phase-promote (mocked) → `/rollback`. Each step produces correct artifacts and telemetry.
- Automated (in dev-agent repo's `.github/workflows/ci.yml`): unit tests for prompt template parsing, schema validation, label vocabulary; integration test that runs phase-implement against test-repo.

**Phase 2:**
- Manual: ship 3 real Caliente features. Time to first green PR <30 min for tiny features.
- Automated: contract test in Caliente (`tests/contract/dev-agent-integration-contract.test.ts`) asserts `.dev-agent.yml` exists, all 6 wrapper workflows reference correct version tag, label vocabulary matches plugin schema.

**Phase 3:**
- Manual: 2-week scout observation period; daily digest sanity-check; ship ≥1 scout-proposed feature.
- Automated: contract test that scout routine config exists in scheduled-tasks (queryable via `mcp__scheduled-tasks__list_scheduled_tasks`).

**Phase 4:**
- Manual: 2nd-project onboarding clock. Stop-watch from `dev-agent-init` to first green PR.
- Automated: integration test that `dev-agent-init` against a fresh repo produces valid config + labels + workflows.

---

## Implementation steps (summary — full per-phase plan generated by `writing-plans` skill after spec approval)

**Step 0: Bootstrap the dev-agent repo.**
1. Create `/Users/alizaouane/Documents/Qualiency/dev-agent/` directory
2. `git init`, add `README.md` (one-paragraph stub), `.gitignore`, `package.json`
3. Decide GitHub repo name (`alizaouane/dev-agent` recommended; alternative `alizaouane/qualiency-dev-agent`); `gh repo create` (private initially)
4. Create `docs/specs/2026-05-02-dev-agent-design.md` with the contents of this design
5. Initial commit on `main`; push to GitHub

**Step 1: Phase 1 — Plugin + workflows in isolation.**
- Invoke `superpowers:writing-plans` against the committed spec.
- Plan addresses Phase 1 acceptance criteria.
- All work happens inside the new dev-agent repo against `examples/test-repo/`.

**Step 2: Phase 2 — Install into Caliente.** Separate spec/plan/PR cycle once Phase 1 ships.

**Step 3: Phase 3 — Scout.** Separate spec/plan/PR cycle once Phase 2 ships.

**Step 4: Phase 4 — 2nd Qualiency project install.** Separate spec/plan/PR cycle once Phase 3 ships.

---

## Appendix: Why this is best practice (Q4 2025 / Q1 2026)

Patterns adopted from production-validated systems (Copilot Workspace, Cursor background agents, OpenHands, Sweep, Devin's lessons):

- **GitHub-native state** — issues + labels + PRs. No new DB.
- **Event-driven (webhooks) + polling fallback** — robust + low latency.
- **Multi-specialized agents** over mega-agent.
- **Spec-first** — skipping spec → wrong-problem PRs.
- **Multi-model routing** — Haiku/Sonnet/Opus by role saves 5–10× cost.
- **Per-phase cost caps + checkpointing** — stops runaway loops.
- **Diff scope guardrails** — caps blast radius.
- **Drift detection** — flags scope creep before PR opens.
- **Mandatory test gate** — non-negotiable.
- **Rollback at every phase** — failure recovery depends on this.
- **Bounded human-in-the-loop** — never zero gates; never every commit.
- **Full traceability** — cost/duration/tokens/model logged per phase.

Adopted from cross-cutting product/library design:
- **Plugin architecture** — Claude Code's plugin system is the cross-repo distribution unit.
- **Reusable GitHub workflows** — versioned, GitHub-native, no copy-paste.
- **Single-repo monorepo (plugin + workflows together)** — simpler for one user; one tag = synchronized release.
- **Per-repo config schema** — single contract between portable system and project-specific behavior.
- **Bootstrap with synthetic consumer** — validates the contract before real-world install.

Patterns deliberately rejected:
- Caliente-specific orchestrator that we extract later (would create two systems with two debt loads).
- Two separate repos for plugin vs workflows (overkill for one user; can split later if needed).
- Single-agent monoliths (context bloat).
- Polling without event-driven fallback.
- Rigid templates with no override.
- SaaS / hosted product as v1 (overkill for single-user; revisit at Phase 5+ if open-sourcing).
