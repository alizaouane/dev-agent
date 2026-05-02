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

## Design

See [docs/specs/2026-05-02-dev-agent-design.md](docs/specs/2026-05-02-dev-agent-design.md). Implementation plans for each sub-phase live in [docs/plans/](docs/plans/).

## License

Private (single-user) for now. Open-source release deferred to Phase 5+.
