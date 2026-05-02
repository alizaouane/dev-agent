---
description: Trigger scout to run now (out-of-cycle digest generation)
argument-hint: "(no args)"
allowed-tools: Read Bash
---

# /digest

Forces the scout to run immediately rather than waiting for its scheduled cron. Useful for testing or after a config change.

## Steps

1. Read `.dev-agent.yml`; check `scout.enabled` is `true`. Bail with a message otherwise.
2. Dispatch the scout workflow: `gh workflow run dev-agent-scout.yml` (the wrapper that calls the plugin's scout job).
3. Watch the run; report the digest issue URL when posted.

## Output

On success: prints the URL of the new digest issue (`kind:scout-digest`).

## Failure modes

- `scout.enabled: false` → bail.
- No scout workflow wired in consumer → tell user to run `/dev-agent-init`.

## Implementation note

Slash command live in 1b. The scout itself (source adapters, digest generation, suppression learning) is stubbed in `skills/scout/SKILL.md` and runs as a real workflow in Plan 1c.
