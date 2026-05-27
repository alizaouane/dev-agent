---
description: Start new work (feature, bug, improvement) in a dev-agent-wired repo. Thin wrapper that invokes the `dev-agent:start-feature` skill — the skill auto-activates on most pitch intents, but `/develop` is here for explicit invocation when you want it.
argument-hint: "<pitch> | --from-issue <#>"
allowed-tools: Bash Read Skill
---

# /develop

Explicit-invocation wrapper. The real flow lives in the `dev-agent:start-feature` skill — see [skills/start-feature/SKILL.md](../skills/start-feature/SKILL.md).

## What this command does

1. If `--from-issue <#>` was passed, load the issue body with `gh issue view <#> --json title,body,labels` and use the title + body + `kind:*` label as the seed.
2. Otherwise pass the user's free-form pitch as the seed.
3. Invoke the `dev-agent:start-feature` skill via the Skill tool, passing the seed as context.

## Why this exists alongside the skill

The skill auto-activates on most intents ("I want to add X", "X is broken", "what should I work on"). The slash command is for cases where:

- You want to be explicit about which entry point fires (e.g., debugging the flow)
- You're handing off from a dashboard proposal that pasted `/develop --from-issue <#>` to your clipboard
- The skill isn't auto-firing for whatever reason and you want a forcing function

Both paths converge on the same skill, so behavior is identical. Pick whichever you prefer.

## Argument forms

- `/develop "<pitch>"` — free-form pitch, starts at Phase 1 (PM eval)
- `/develop --from-issue <#>` — seeded from an existing GitHub issue (e.g., a proposal you clicked through from the dashboard)
- `/develop` — interactive; lists open `state:proposed` issues and asks the user to pick one or pitch fresh

## Failure modes

- Not in a dev-agent-wired repo (no `.dev-agent.yml`) → skill's Phase 0 bails with a clear error
- `gh` not authenticated → same
- See `skills/start-feature/SKILL.md` "Failure modes" for the full list

## Notes

- The skill owns the four-phase orchestration (PM eval → spec → plan → handoff). The slash command is a thin wrapper, not a parallel implementation.
- Do NOT duplicate phase logic here. If you find yourself wanting to edit the orchestration, edit `skills/start-feature/SKILL.md`.
