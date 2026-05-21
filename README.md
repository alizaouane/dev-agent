# dev-agent

Portable agentic feature development system. A Claude Code plugin + reusable GitHub workflows + per-repo config schema (`.dev-agent.yml`) that automates the end-to-end feature/improvement lifecycle, with the human as orchestrator only.

**Status:** Phase 0 (spec committed). Phase 1 (build) in progress.

## What it does

Drop intent → agent drafts spec → you approve → agent implements, opens PR → you approve PR → agent ships to staging → you approve prod promote → agent ships to prod. Three gates total. Multiple features in flight in parallel. Optional daily scout proposes new features from GitHub issues, prod logs, codebase audits, and competitive feeds.

## How it ships across projects

- **Plugin** (this repo) installs once via `claude plugin install`.
- **Reusable GitHub workflows** (also this repo, in `.github/workflows/`) are referenced by consumer repos via `uses: alizaouane/dev-agent/.github/workflows/phase-implement.yml@v1`.
- **Per-repo config** (`.dev-agent.yml` in each consumer) is the only place project-specific behavior lives — test/lint/build/deploy commands, blocked paths, cost caps, model routing, scout sources.

## Install

From a local checkout:

```bash
claude plugin install "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
```

From the published GitHub repo (after Phase 1d ships):

```bash
claude plugin install alizaouane/dev-agent
```

Then in any consumer repo:

```
/dev-agent-init
```

## Slash commands (reference)

| Command | Purpose |
|---|---|
| `/dev-agent-init` | One-time consumer-repo bootstrap |
| `/develop <intent\|url>` | Start a feature; runs spec brainstorm at Gate 1 |
| `/proposals` | List open scout-proposed features |
| `/status` | Tabular view of in-flight features |
| `/approve <issue#> [--promote]` | Advance past Gate 1 / 2 / 3 |
| `/abandon <issue#>` | Cancel an in-flight feature |
| `/rollback <issue#>` | Revert a shipped feature |
| `/digest` | Trigger scout out-of-cycle |

See `commands/<name>.md` for full per-command docs.

## Internal skills (reference)

| Skill | Purpose |
|---|---|
| `orchestrator` | State-machine reference + transition rules |
| `scout` | Source adapters + digest generator |
| `drift-check` | Diff-vs-spec scope creep detector |
| `notify` | 4-channel notification fan-out (push/email/issue/status-file) |

These are `user-invocable: false` — invoked by slash commands and reusable workflows, not by the user.

## Status: v0.3.0 (Real implement step)

`phase-implement.yml` now invokes [`anthropics/claude-code-action@v1`](https://github.com/anthropics/claude-code-action) instead of the stub-mode model invocation. The agent reads the linked spec, edits files, runs the consumer's test/typecheck commands, commits to a `feat/dev-agent-issue-<n>` branch, and the action auto-creates the PR. The phase workflow then transitions the issue to `state:pr-review`. **The system now actually ships code.**

To use live mode: pass `invocation_mode: live` (now the default) to `phase-implement.yml`. Stub mode (`invocation_mode: stub`) skips the agent — useful for wiring tests.

## Status: v0.2.0 (Dashboard v1)

Adds the web dashboard at [`dev-agent.qualiency.com`](https://dev-agent.qualiency.com) — inbox-driven UI, GitHub OAuth + allowlist, server actions wrapping the engine. Source: [`docs/specs/2026-05-03-dev-agent-dashboard-design.md`](docs/specs/2026-05-03-dev-agent-dashboard-design.md). Build: [`docs/plans/2026-05-03-dashboard-v1-plan.md`](docs/plans/2026-05-03-dashboard-v1-plan.md). Code under [`dashboard/`](dashboard/).

## Status: v0.1.0 (Phase 1 — engine)

Phase 1 ships the foundation, plugin surface, reusable workflows, and live Anthropic wiring against a synthetic test consumer at `examples/test-repo/`. See [`docs/runbooks/2026-05-03-phase-1d-drill.md`](docs/runbooks/2026-05-03-phase-1d-drill.md) for the lifecycle drill that validated the v0.1.0 milestone.

Consumer repos can pin to `@v1`:

```yaml
uses: alizaouane/dev-agent/.github/workflows/phase-implement.yml@v1
```

Phase 2 (Caliente integration) lands the real implementation logic — file edits, test runs, PR creation, merge-commit rollback. v0.1.0 covers everything up to and including the model-invocation boundary.

To run a workflow with live model invocation, configure `ANTHROPIC_API_KEY` as a repo secret and pass `invocation_mode: live`.

## Swarm-review

Swarm-review enforcement + canary rollout: see [docs/runbooks/2026-05-16-swarm-review-enforcement.md](docs/runbooks/2026-05-16-swarm-review-enforcement.md)

## Tier-2 smoke

Tier-2 smoke enforcement + canary rollout: see [docs/runbooks/2026-05-20-tier2-smoke-rollout.md](docs/runbooks/2026-05-20-tier2-smoke-rollout.md)

## Cost-watchdog

A nightly per-repo monthly-budget watchdog runs via `orch-sweep.yml`. Set `cost_caps.monthly_budget_usd` and `cost_caps.alert_threshold_pct` in `.dev-agent.yml` to enable. See [docs/runbooks/2026-05-20-cost-watchdog.md](docs/runbooks/2026-05-20-cost-watchdog.md).

## Phase 1c — workflows + test consumer

The repo now ships 6 reusable GitHub workflows that consumer repos invoke via `uses:`:

```yaml
# In a consumer repo:
jobs:
  implement:
    uses: alizaouane/dev-agent/.github/workflows/phase-implement.yml@v1
    with:
      issue_number: ${{ github.event.issue.number }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

In Phase 1c the workflows ship in **stub invocation mode** — the model invocation step returns deterministic canned output rather than calling Anthropic, so end-to-end wiring is testable without burning model tokens. Plan 1d flips the default to `live` after the lifecycle drill validates everything.

Override per call:

```yaml
with:
  invocation_mode: live  # only after Plan 1d
```

The synthetic test consumer at `examples/test-repo/` exercises every workflow via wrapper YAMLs that reference `./.github/workflows/phase-*.yml`.

## Design

See [docs/specs/2026-05-02-dev-agent-design.md](docs/specs/2026-05-02-dev-agent-design.md). Implementation plans for each sub-phase live in [docs/plans/](docs/plans/).

## License

Private (single-user) for now. Open-source release deferred to Phase 5+.
