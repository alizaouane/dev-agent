---
description: PM-eval → spec brainstorm → plan write → handoff. Lands spec + plan in the consumer repo and files a state:spec-ready issue for the dashboard.
argument-hint: "<pitch> | --from-issue <#> | (empty to pick from /proposals)"
allowed-tools: Read Write Edit Bash Glob Grep Skill
---

# /develop

End-to-end PM workflow: pitch → scoped spec → reviewable plan → ready-to-implement issue.

## Invocation modes

- `/develop "<pitch>"` — free-form pitch. Starts at Phase 1.
- `/develop --from-issue <#>` — seeded from an existing GitHub issue (e.g. a scout proposal).
- `/develop` — interactive: lists open `state:proposed` issues from the current repo, asks you to pick one or pitch fresh.
- `/develop --resume` — re-enters the most recent in-flight spec draft in `docs/superpowers/specs/`.

## Repo detection

1. If `cwd` contains `.dev-agent.yml`, treat `cwd` as the consumer repo (default).
2. Else if `--repo owner/name` is passed, clone or read remotely.
3. Else ask the user.

## Phase 1 — PM evaluation

Load context:

- `.dev-agent/pm.md` (frontmatter goals + free-form body)
- Current pipeline: `gh issue list --state open --label state:scoping,state:spec-ready,state:implementing,state:pr-review --json number,title,labels`
- Recent `SESSION_LOG.md` entries (top 10)

Then load the PM persona from `prompts/pm.md` (engine repo) and run the conversation in the terminal. The persona:

- Pushes back on goal misalignment
- Surfaces in-flight conflicts
- Estimates effort against past shipped work (`git log --oneline -20`)
- Emits `## Agreed scope` when aligned

**Exit Phase 1 when** the PM emits a `## Agreed scope` section. Pass that section as the seed to Phase 2.

## Phase 2 — Spec brainstorming

Invoke the `superpowers:brainstorming` skill. Seed the brainstorm with:

- The agreed scope from Phase 1
- The pitch / source issue
- The consumer repo context already loaded

The skill drives its own checklist (clarifying questions, propose 2-3 approaches, present design sections with explicit approval gates, write spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, commit).

**Exit Phase 2 when** the spec file is committed and the brainstorming skill's user-review gate passes.

## Phase 3 — Plan writing

The brainstorming skill's terminal state is "invoke writing-plans." Honor that — invoke `superpowers:writing-plans` with the just-written spec as input. The skill writes `docs/plans/YYYY-MM-DD-<topic>.md` (or `docs/superpowers/plans/...` per consumer convention).

**Exit Phase 3 when** the plan file is committed.

## Phase 4 — Handoff

Detect: spec path + plan path + feature title (from the spec's H1).

Then:

1. **Verify spec + plan are committed to the consumer's default branch** (or to the PR branch if `spec_plan_via_pr: true` in `.dev-agent.yml`).
2. **Build the issue body:**

   ```
   Spec: <spec-path-on-default-branch>
   Plan: <plan-path-on-default-branch>

   ## TL;DR

   <first paragraph of the spec, verbatim>

   ---

   Brainstormed and planned via `/develop` in Claude Code. Tap "Approve and start implementation" in the dashboard to dispatch the implement workflow.
   ```

3. **Create the issue:**

   ```bash
   gh issue create \
     --repo "$OWNER/$REPO" \
     --title "$FEATURE_TITLE" \
     --body "$ISSUE_BODY" \
     --label "state:spec-ready,kind:feature"
   ```

   If `--from-issue <#>` was used, copy the source issue's `kind:*` label instead of defaulting to `kind:feature`.

4. **Print the issue URL** and stop. The dashboard's existing repo watcher picks up the new issue.

## Failure modes

- No `.dev-agent.yml` in cwd and no `--repo` → ask user; bail if they don't provide one.
- `gh` not authenticated → print `gh auth login` instruction and exit.
- PM emits no `## Agreed scope` after 10 turns → save the conversation transcript to `/tmp/develop-pm-stuck-<timestamp>.md` and ask the user whether to continue or abort.
- Brainstorming skill exits without writing a spec → no Phase 3 / 4; user can `/develop --resume` later.
- Plan writing skill exits without writing a plan → no Phase 4; spec stays as an orphan draft until next resume.
- `gh issue create` fails (rate limit, perm) → print error + the would-be body so the user can file manually.

## Resumption

`/develop --resume`:

1. Find the most recent `.md` in `docs/superpowers/specs/` whose corresponding `docs/plans/<same-date>-<same-topic>.md` doesn't exist (Phase 2 done, Phase 3 not started), OR no `state:spec-ready` issue references the spec path (Phase 3 done, Phase 4 not started).
2. Resume at the appropriate phase.

## Notes for the operator

- This command auto-chains skills. Don't invoke `superpowers:brainstorming` or `superpowers:writing-plans` manually mid-`/develop` — let the orchestrator drive.
- Phase 1's PM persona is intentionally allowed to take many turns. Brainstorm is the rate-limiting step; don't rush it.
- The handoff issue at `state:spec-ready` waits for human approval in the dashboard. `/develop` does NOT dispatch the implement workflow itself.
