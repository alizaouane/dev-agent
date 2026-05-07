# Enabling the verification gates on a consumer repo

The verification architecture (ACM, swarm-review, tier-2 smoke) ships
disabled by default — new code is in `main` but no consumer runs the
new gates until you opt that consumer in. This runbook covers the
opt-in steps.

## What's already on every consumer (from the moment `v1` advances)

These changes apply to every consumer pinning `@v1` as soon as the tag
is moved forward:

- **Harden-Runner audit-mode** on every phase workflow — logs egress to
  the workflow run's Security tab. Doesn't block anything.
- **ACM pre-flight + post-agent gate** in `phase-implement.yml` — only
  fires when `.dev-agent/acm-manifest.json` exists on the feature
  branch. Consumers without ACM config never have the manifest, so
  the gate stays inactive (`gate_active=false`).
- **Self-review verification** — handles absent `.dev-agent/self-review.json`
  silently. The implement-agent's prompt (`prompts/implement.md`) now
  asks the agent to write the file, but if it doesn't, the workflow
  exits cleanly without a comment.
- **Salvage step** — gates PR-open on `ACM_VERDICT == 'fail'`. The
  verdict defaults to `skipped` when the ACM gate never ran, so the
  salvage path is unchanged for consumers without ACM.

So advancing `v1` is safe for any existing consumer — they keep
working exactly as before.

## Opting a consumer into the new gates

### 1. Add the verification config to `.dev-agent.yml`

```yaml
audit_skills:
  pre_pr: []                # existing — keep your existing entries
  acm:
    required: true
    test_pattern: "tests/acm/**"
    mutation_score_threshold: 60   # v1.1 once Stryker/mutmut wire in
    flaky_runs: 5                  # v1.1 once flaky filter wires in
    max_iterations: 3
  swarm:
    reviewers:
      - spec-compliance
      - regression-guard
      - security-scout
    reviewer_weights:
      spec-compliance: 1.0
      regression-guard: 1.0
      security-scout: 1.5
    timeout_minutes: 15
    kill_switch_env: DEV_AGENT_GATE_KILL_SWITCH
  evidence_collector:
    scanners:
      - gitleaks
      - semgrep
      - npm-audit
  tier2_smoke:
    enabled: true
    timeout_minutes: 15

cost_caps:
  # ... existing caps stay the same; add:
  acm:               { tokens_in: 30000, tokens_out: 8000, dollars: 0.75 }
  swarm_review:      { tokens_in: 60000, tokens_out: 9000, dollars: 0.30 }
  evidence_collector:{ tokens_in: 0,     tokens_out: 0,    dollars: 0    }
  tier2_smoke:       { tokens_in: 30000, tokens_out: 6000, dollars: 0.40 }
  self_review:       { tokens_in: 15000, tokens_out: 3000, dollars: 0.10 }
  index_refresh:     { tokens_in: 0,     tokens_out: 0,    dollars: 0    }

models:
  # ... existing models stay the same; add (pin to dated snapshots
  # in production):
  acm: claude-sonnet-4-6
  acm_test_agent: claude-sonnet-4-6
  swarm_review: claude-haiku-4-5
  meta_reviewer: claude-sonnet-4-6
  self_review: claude-haiku-4-5
  tier2_smoke: claude-sonnet-4-6
```

### 2. Add wrapper workflows that call the new phases

Create the four new wrappers in `.github/workflows/`:

```yaml
# .github/workflows/dev-agent-acm.yml
name: dev-agent · acm
on:
  workflow_dispatch:
    inputs:
      issue_number:
        required: true
        type: number
jobs:
  acm:
    uses: alizaouane/dev-agent/.github/workflows/phase-acm.yml@v1
    with:
      issue_number: ${{ inputs.issue_number }}
      config_path: .dev-agent.yml
      invocation_mode: stub      # live mode lands in step 6b
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Similar wrappers for `phase-evidence-collector.yml`, `phase-swarm-review.yml`,
and `phase-tier2-smoke.yml`. See `examples/web-app-template/.github/workflows/`
for the existing wrapper shapes — model the new ones the same way.

### 3. State-machine entry rows

In v1, the state machine still routes `/approve` directly to
`state:implementing` (so consumers without ACM keep working). To make
the ACM gate actually fire on this consumer, you have two options:

- **Manual** — when you `/approve` an issue, also run the
  workflow_dispatch trigger on `dev-agent-acm.yml`. The ACM gate runs,
  commits the manifest, and advances state. The implement phase then
  picks up where the manifest left off.
- **Automatic** — once the live-mode wiring lands (step 6b in the v1.1
  backlog), the orchestrator's transition table flips
  `state:spec-ready /approve → state:acm-building` and the workflow
  fires automatically.

Until step 6b, manual dispatch is the only path. This is by design —
v1 ships the gates in stub mode, which only verifies wiring (real test
generation requires the live-mode commits).

## Kill switch

Set the repo secret `DEV_AGENT_GATE_KILL_SWITCH` to disable specific
gates without removing the config:

- `acm` — bypass ACM
- `swarm` — bypass swarm-review
- `tier2` — bypass tier-2 smoke
- Comma-combinations: `acm,swarm,tier2`

Wiring of the env into each phase workflow lands alongside step 12b's
live-mode flip; v1 stub-mode workflows ignore it because there's
nothing destructive to bypass yet.

## Cost ceiling (live mode, v1.1)

Per-feature rough cost when all gates are running in live mode:

- ACM (Sonnet, ~30 turns): $0.50–1.00
- self-review (Haiku, 1 call): $0.10
- evidence-collector (deterministic): runtime only
- swarm 3× Haiku in parallel: $0.30
- meta-reviewer (Sonnet, only on pass+fail mix): $0.05
- tier-2 (Sonnet, Playwright probe): $0.40

Total: ~$1.50 per feature.

Repo-level monthly budget: set `cost_caps.monthly_budget_usd` (default
$200). The cost-watchdog CLI that enforces this lands in v1.1
alongside the events.jsonl wiring.

## Reverting

If a gate misbehaves on this consumer:

1. **Quickest** — set `DEV_AGENT_GATE_KILL_SWITCH=acm,swarm,tier2` repo
   secret. Gates skip on next run (once wiring lands per above).
2. **Cleaner** — remove the `audit_skills.acm/swarm/...` blocks from
   `.dev-agent.yml`. Gates never fire because the config that activates
   them is gone.
3. **Hardest** — pin this consumer's wrapper back to a `@v1`-tagged
   commit before the verification gates landed. Other consumers stay
   on the new code.

The v1 design ensures the new gates are entirely additive: removing
the config is sufficient to deactivate them.
