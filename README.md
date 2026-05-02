# dev-agent

Portable agentic feature development system. A Claude Code plugin + reusable GitHub workflows + per-repo config schema (`.dev-agent.yml`) that automates the end-to-end feature/improvement lifecycle, with the human as orchestrator only.

**Status:** Phase 0 (spec committed). Phase 1 (build) in progress.

## What it does

Drop intent → agent drafts spec → you approve → agent implements, opens PR → you approve PR → agent ships to staging → you approve prod promote → agent ships to prod. Three gates total. Multiple features in flight in parallel. Optional daily scout proposes new features from GitHub issues, prod logs, codebase audits, and competitive feeds.

## How it ships across projects

- **Plugin** (this repo) installs once via `claude plugin install`.
- **Reusable GitHub workflows** (also this repo, in `.github/workflows/`) are referenced by consumer repos via `uses: alizaouane/dev-agent/.github/workflows/phase-implement.yml@v1`.
- **Per-repo config** (`.dev-agent.yml` in each consumer) is the only place project-specific behavior lives — test/lint/build/deploy commands, blocked paths, cost caps, model routing, scout sources.

## Install (placeholder — Phase 1 will finalize)

```bash
claude plugin install /Users/alizaouane/Documents/Qualiency/dev-agent
```

Then, in any consumer repo:

```
/dev-agent-init
```

## Design

See [docs/specs/2026-05-02-dev-agent-design.md](docs/specs/2026-05-02-dev-agent-design.md).

## License

Private (single-user) for now. Open-source release deferred to Phase 5+.
