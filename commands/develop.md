---
description: Start a new feature — creates GH issue, runs spec brainstorm with Opus, writes spec file, relabels state:spec-ready
argument-hint: "<intent> | <issue-url> | (empty to pick from /proposals)"
allowed-tools: Read Write Bash Glob Grep
---

# /develop

Kicks off a new feature in the dev-agent state machine.

## Argument forms

- `/develop "<intent>"` — free-form intent. Creates a fresh GH issue.
- `/develop <issue-url>` — re-uses an existing issue (must currently carry `state:proposed` or `state:scoping`).
- `/develop` — opens an interactive picker over open `kind:scout-proposal` issues (delegates to `/proposals`).

## What this does

1. **Creates or adopts the issue** with the right kind/state labels.
2. **Loads `.dev-agent.yml`** to determine `artifacts.specs_dir`, `cost_caps.spec_brainstorm`, and `models.spec_brainstorm` (default: `claude-opus-4-7`).
3. **Runs the spec brainstorm phase** — invokes the `superpowers:brainstorming` skill against the intent, then `superpowers:writing-specs` to produce the spec file at `<specs_dir>/<YYYY-MM-DD>-<slug>.md`.
4. **Posts a telemetry comment** on the issue (model, duration, tokens, cost; format defined by `lib/telemetry.ts`).
5. **Transitions the issue** to `state:spec-ready` and links to the spec file from the issue body.

This is **Gate 1**. The user reviews the spec, then runs `/approve <issue#>` to advance to `state:implementing`.

## Steps

1. Parse argument; resolve to an issue number (creating one if needed).
2. Load `.dev-agent.yml`; resolve spec_dir, model, cost cap.
3. Invoke `superpowers:brainstorming` against the intent (passes through user reviewer chat).
4. Once aligned, invoke `superpowers:writing-specs` to write the spec.
5. Comment telemetry; relabel; close-loop.

## Cost cap behavior

If the brainstorm phase hits `cost_caps.spec_brainstorm` (tokens or dollars), abort with `state:blocked` and a comment summarizing what's been captured so far. User can resume with `/develop <issue-url>`.

## Failure modes

- No `.dev-agent.yml` → tell user to run `/dev-agent-init`.
- `gh` not authenticated → bail with the auth command.
- Brainstorm cost cap hit → label `state:blocked`, post comment, exit non-zero.

## Implementation note

The brainstorm + writing-specs invocations are stubbed in 1b — the command writes a placeholder spec and applies `state:spec-ready` without actually invoking the model. The real model invocation wires up in 1c when the workflow side is built. The slash command structure, argument parsing, label transitions, and `gh` interactions are all live in 1b.
