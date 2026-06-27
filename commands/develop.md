---
description: Start new work (feature, bug, improvement) in a dev-agent-wired repo. Thin wrapper that invokes the `dev-agent:start-feature` skill — the skill auto-activates on most pitch intents, but `/develop` is here for explicit invocation when you want it.
argument-hint: "<pitch> | --from-issue <#> [--repo owner/name] [--quick]"
allowed-tools: Bash Read Skill
---

# /develop

Explicit-invocation wrapper. The real flow lives in the `dev-agent:start-feature` skill — see [skills/start-feature/SKILL.md](../skills/start-feature/SKILL.md).

## What this command does

1. **Parse `--repo owner/name`** (if present). This tells the skill to target a specific consumer repo regardless of `cwd` — required when the user pastes the command from the dashboard's cross-repo `/proposals` button, because issue numbers are repo-scoped and `cwd` may be the wrong repo.
2. **Parse `--quick`** (if present). This signals `start-feature` to route directly to `dev-agent:quick-dev` after Phase 1 PM evaluation, bypassing Phase 2 brainstorm, Phase 3 plan writing, and Phase 3.5 spec-review. Use for typos, copy fixes, one-liners. The PM still classifies effort first — if the scope reads like substantial work, quick-dev will warn before proceeding.
3. **If `--from-issue <#>`** was passed, load the issue body with `gh issue view <#> [--repo $REPO] --json title,body,labels` and use the title + body + `kind:*` label as the seed.
4. **Otherwise** pass the user's free-form pitch as the seed.
5. Invoke the `dev-agent:start-feature` skill via the Skill tool, passing the full arg set (pitch / `--from-issue` / `--repo` / `--quick`) as context. The skill's Phase 0 handles repo resolution (clones if needed, validates `.dev-agent.yml`, checks gh auth + write permission).

## Why this exists alongside the skill

The skill auto-activates on most intents ("I want to add X", "X is broken", "what should I work on"). The slash command is for cases where:

- You want to be explicit about which entry point fires (e.g., debugging the flow)
- You're handing off from a dashboard proposal that pasted `/develop --from-issue <#> --repo owner/name` to your clipboard
- The skill isn't auto-firing for whatever reason and you want a forcing function

Both paths converge on the same skill, so behavior is identical. Pick whichever you prefer.

## Argument forms

- `/develop "<pitch>"` — free-form pitch in the current repo. Phase 1 starts immediately. Repo = `cwd` if `.dev-agent.yml` is present, else the skill asks.
- `/develop --from-issue <#>` — seeded from an existing GitHub issue in the current repo.
- `/develop --from-issue <#> --repo owner/name` — same, but the issue lives in `owner/name`, not `cwd`. The skill will `gh repo clone` to `~/.dev-agent/clones/<owner>-<name>/` (or fast-forward an existing clone) and work from there. This is the form the dashboard's `/proposals` "Brainstorm in Claude Code" button generates.
- `/develop "<pitch>" --repo owner/name` — fresh pitch against a specific consumer repo (no source issue). Same clone-or-fast-forward behavior.
- `/develop "<pitch>" --quick` — fast path for trivial work (typos, copy fixes, one-liners). Phase 1 PM evaluation runs, then `dev-agent:quick-dev` writes a 3-paragraph spec and files the issue — no brainstorming, no separate plan, no spec-review. Can be combined with `--repo` or `--from-issue`.
- `/develop` — interactive; lists open `state:proposed` issues in the current repo and asks the user to pick one or pitch fresh.

## Failure modes

- Not in a dev-agent-wired repo and no `--repo` flag → skill's Phase 0 asks the user; bails if no answer
- `gh` not authenticated → skill's Phase 0 bails with `gh auth login` instruction
- Insufficient permission on the target repo (need WRITE/MAINTAIN/ADMIN) → skill's Phase 0 bails
- See `skills/start-feature/SKILL.md` "Failure modes" for the full list

## Notes

- The skill owns the four-phase orchestration (PM eval → spec → plan → handoff) AND repo resolution. The slash command is a thin wrapper, not a parallel implementation.
- Do NOT duplicate phase logic or repo-detection logic here. If you find yourself wanting to edit the orchestration, edit `skills/start-feature/SKILL.md`.
