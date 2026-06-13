---
name: start-feature
description: Use when starting any new work in a dev-agent-wired consumer repo (a repo with .dev-agent.yml). Triggers on pitching a new feature, reporting a bug, asking "what should I work on next", describing something to build, or saying "this is broken". Orchestrates PM evaluation → spec writing → plan writing → commits to default branch → files a GitHub issue at state:spec-ready that the dev-agent engine picks up. After this skill finishes, the user approves at three gates in the dashboard — no further Claude Code involvement needed for implementation.
user-invocable: true
---

# start-feature

End-to-end intake skill for the dev-agent loop. Take the user from "I have an idea or bug" to "the engine has a state:spec-ready issue with a spec + plan, ready to implement." Then the user lives in the dashboard for the three approval gates; you don't.

**Announce at start:** "Using `start-feature` to scope, spec, plan, and hand off to dev-agent."

## When to invoke

Activate when the user is in a dev-agent-wired consumer repo (has `.dev-agent.yml` at the root) **and** they:

- Pitch a new feature ("I want to add X", "let's build Y", "what if we…")
- Report a bug ("X is broken", "Y crashes", "this doesn't work when…")
- Ask for direction ("what should I work on", "what's next")
- Describe scope work ("this needs refactoring", "we should clean up Z")

**Do NOT activate** for:

- Generic coding help (writing a function, debugging a one-liner, explaining code)
- Direct file edits the user wants to commit themselves without going through the engine
- Questions about Claude Code itself, the dev-agent CLI, or workflow plumbing
- Work on a feature that's already in flight (a `state:implementing` / `state:pr-review` issue exists)

## Pre-flight (Phase 0)

Before any other work, resolve the target consumer repo and run sanity checks. **Bail loudly** on any failure — there's no point doing the rest if the handoff can't land.

### Repo resolution

The skill works against the consumer repo specified by one of these (in priority order):

1. **`--repo owner/name` in the user's invocation** (passed by the `/develop` slash command when copied from the dashboard's `/proposals` button, or typed explicitly). If the directory `~/.dev-agent/clones/<owner>-<name>` exists, `cd` into it and `git pull` to fast-forward. Otherwise `gh repo clone <owner>/<name> ~/.dev-agent/clones/<owner>-<name>` then `cd` into it.
2. **`cwd` containing `.dev-agent.yml`** — use cwd directly.
3. **Neither** — ask the user which repo to target (interactive). Bail if they don't provide one.

After repo resolution, the rest of Phase 0 runs **from inside the resolved repo's working tree**.

### Sanity checks

```bash
# Verify we're in a dev-agent-wired consumer repo
test -f .dev-agent.yml || { echo "ERROR: no .dev-agent.yml — this skill only runs in wired-up consumer repos. Run /dev-agent-init or wire up via the dashboard."; exit 1; }

# Verify gh is authenticated
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh CLI not authenticated. Run 'gh auth login' first."; exit 1; }

# Verify the user has at least WRITE permission on the repo. Phase 4
# creates an issue + (if needed) creates labels — both require write,
# not admin. viewerCanAdminister is admin-only and would reject normal
# collaborators with WRITE or MAINTAIN. viewerPermission returns the
# canonical role (ADMIN/MAINTAIN/WRITE/TRIAGE/READ/NONE).
PERM=$(gh repo view --json viewerPermission -q '.viewerPermission' 2>/dev/null || echo "")
case "$PERM" in
  ADMIN|MAINTAIN|WRITE) ;;
  *) echo "ERROR: you need WRITE, MAINTAIN, or ADMIN access on this repo (you have: ${PERM:-unknown}). Phase 4 (gh issue create + label create) would fail."; exit 1 ;;
esac
```

If any check fails, surface the error verbatim and stop. Do not proceed.

## TodoWrite enforcement (Phase 0.1)

**This is the mechanism that prevents Phase 4 from being skipped.** Immediately after pre-flight, create the checklist:

```
- [ ] Phase 1: PM evaluation → Agreed scope
- [ ] Phase 2: Spec written + committed
- [ ] Phase 3: Plan written + committed
- [ ] Phase 3.5: spec-review run; verdict ok or concerns
- [ ] Phase 4: GitHub issue filed at state:spec-ready
```

Use the TodoWrite tool. Mark each item `in_progress` when starting that phase, `completed` only when done. **Phase 4 stays `pending` until the issue URL is printed.** An incomplete todo is the visible signal that the skill is not finished — do not announce "done" or end the turn while any item is pending.

**Phase 3.5 skip exception:** if Phase 1's PM evaluation classified the work as trivial (one-liner, typo, copy fix), mark Phase 3.5 `completed` with note "skipped: trivial work" and proceed to Phase 4. Adversarial review of a 3-paragraph spec is overkill.

## Phase 1 — PM evaluation

Load the PM persona from `prompts/pm.md` in the dev-agent plugin (path: `${PLUGIN_DIR}/prompts/pm.md`). That document defines how the PM agent thinks. **Internalize its instructions** — you are now acting as the PM.

Load context from the consumer repo:

- `.dev-agent/pm.md` (goals + avoid + recent_decisions frontmatter + free-form body)
- Current pipeline: `gh issue list --state open --label state:scoping,state:spec-ready,state:implementing,state:pr-review --json number,title,labels --limit 30`
- Recent SESSION_LOG: `sed -n '1,200p' SESSION_LOG.md 2>/dev/null` (top entries, newest first)

Then run the PM conversation with the user's pitch as the seed:

- Check goal alignment (per `.dev-agent/pm.md` frontmatter goals)
- Surface conflicts with in-flight work (per current pipeline)
- Check the avoid list
- Estimate rough effort against past shipped work (`git log --oneline -20`)
- Decide kind (feature / bug / improvement) — needed for Phase 4's `kind:*` label
- Decide scope: one feature, or a multi-stage thing? If multi-stage, propose the first stage as standalone

**Exit Phase 1 when** you and the user converge on:

1. An "Agreed scope" — what specifically gets built in this iteration
2. A "kind" — `feature`, `bug`, or `improvement` (drives the issue label)
3. A short feature title — used as the issue title and the spec doc filename slug

Mark Phase 1 todo complete. Move to Phase 2.

## Phase 2 — Spec writing (inline brainstorming)

**Do NOT invoke `superpowers:brainstorming` as a separate skill.** That skill has its own terminal state ("invoke writing-plans") which would steal control. Inline the brainstorming pattern directly.

The brainstorming pattern:

1. **One question at a time.** Don't dump 5 questions at once. Ask, get an answer, internalize, ask the next.
2. **Multiple choice when possible.** Easier to answer than open-ended. Use the `AskUserQuestion` tool with concrete options when there's a fork.
3. **Propose 2-3 approaches before settling.** For non-trivial work, sketch alternatives with trade-offs and your recommendation.
4. **Present the design in sections, get approval per section.** Scale each section to its complexity (a sentence for trivial, 200-300 words for nuanced). Don't write the whole spec then ask for approval — chunks make corrections cheap.
5. **YAGNI ruthlessly.** Remove unnecessary features. The user's pitch is a seed, not a contract.

**Trivial work shortcut.** If during Phase 1 the PM determined this is a one-liner (typo, color tweak, copy fix), skip the design sections and write a 3-paragraph spec: "what changes, why, acceptance criteria." Do not force a multi-question brainstorm on trivial work.

**Spec document.** Write to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` where `<topic>` is a 2-4 word slug derived from the feature title.

**Use the canonical spec template** at `${PLUGIN_DIR}/templates/spec.template.md`. Read it once at the start of Phase 2 — its embedded HTML comments explain what each section needs and what the `spec-review` skill (Phase 3.5) will check for. Fill placeholders (`{{feature_title}}`, `{{YYYY-MM-DD}}`, `{{owner_name_or_email}}`) and replace each `<…>` block with real content. Keep all section headers — `spec-review` enforces their presence.

Two sections are new since the older inline format and matter most:

- **`## Acceptance Criteria`** — numbered (`AC-1`, `AC-2`, …), atomic, user-visible, testable. The plan's tasks reference these by number (e.g. `Task 1: Account creation (AC: 1, 2)`). The `spec-review` skill cross-checks every AC against a plan task.
- **`## Files to Touch`** — explicit Create / Modify / Tests paths. The implement agent honors `prompts/implement.md`'s "touch only files the spec declares" rule against this list. drift-check fires on any out-of-list modification.

**Commit the spec** to the default branch:

```bash
git add docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
git commit -m "docs(spec): <feature title>"
git push
```

If the consumer repo's `.dev-agent.yml` has `spec_plan_via_pr: true`, branch first (`git checkout -b dev-agent/spec-<topic>`) and open a PR via `gh pr create` instead of pushing to default. Otherwise direct-to-default is fine — these are docs, not code.

Mark Phase 2 todo complete. Move to Phase 3.

## Phase 3 — Plan writing (inline plan template)

**Do NOT invoke `superpowers:writing-plans` as a separate skill.** Same reason: its terminal state ("Execution Handoff: subagent-driven vs inline") would steal control and start executing locally instead of returning to Phase 4 for the issue handoff. Use the canonical plan template instead.

**Use the canonical plan template** at `${PLUGIN_DIR}/templates/plan.template.md`. Read it once at the start of Phase 3. Fill `{{feature_title}}` and replace each `<…>` block with real content. Keep the structure: header → Goal → Architecture → Tech Stack → `## File Structure` → numbered `## Task N: <name> (AC: …)` sections each with 5-step TDD subtasks.

**Mirror Files to Touch.** The plan's `## File Structure` section MUST list the same paths the spec's `## Files to Touch` section listed. The `spec-review` skill in Phase 3.5 cross-checks the two — mismatches are gate-failing.

**Reference ACs.** Every `## Task N:` header must carry an `(AC: 1, 3)` annotation pointing at the spec's ACs. `spec-review` requires every spec AC to appear in at least one plan task.

**Bite-sized step granularity.** Each step is one action (2-5 minutes). Write test → run → implement → run → commit = 5 steps per task. Mechanical and unambiguous.

**No placeholders.** Every step shows the actual code or command. Never write "implement the function" without showing what the function looks like. The engine's implementation agent reads this plan literally — vague steps produce vague code.

**Trivial work shortcut.** If Phase 1 determined this is a one-liner, write a single task with 3 steps (edit, test, commit) instead of forcing a multi-task plan.

**Plan document.** Write to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` (same date + topic slug as the spec). Same branch / direct-to-main rules as Phase 2.

```bash
git add docs/superpowers/plans/YYYY-MM-DD-<topic>.md
git commit -m "docs(plan): <feature title>"
git push
```

Mark Phase 3 todo complete. Move to Phase 3.5.

## Phase 3.5 — spec-review (adversarial fresh-context audit)

Before filing the handoff issue, run the `dev-agent:spec-review` skill against the just-written spec and plan. This is the gate that catches the class of bugs the spec author missed in Phase 2/3 — wheel reinvention, missing tests, files-to-touch paths that don't resolve, AC ↔ plan mismatches, scope creep.

**Skip if trivial.** If Phase 1 marked the work as trivial (one-liner / typo / copy fix), mark Phase 3.5 todo `completed` with note "skipped: trivial work" and proceed to Phase 4. Adversarial review of a 3-paragraph spec is overkill and the friction isn't worth it.

**Otherwise invoke spec-review:**

Use the `Skill` tool to invoke `dev-agent:spec-review`. Pass the absolute paths to the spec and plan you just wrote. The skill runs in a fresh-context audit pass and writes its verdict to `.dev-agent/spec-review.json` + `.dev-agent/spec-review-summary.md` in the consumer repo, then prints the verdict word (`ok` | `concerns` | `blocker`) on its final stdout line.

**Handle the verdict:**

- **`ok`** — silent pass. Proceed to Phase 4. Reference `.dev-agent/spec-review.json` in the issue body so the dashboard / approver can see the review was clean.
- **`concerns`** — print the summary from `.dev-agent/spec-review-summary.md` to the user. Ask: "Address the concerns now (return to Phase 2 or 3), or proceed and surface them in the issue body for the approver to consider?" Default to proceeding if no user input within the same turn.
- **`blocker`** — print the summary. Refuse to advance to Phase 4. Tell the user which sections of the spec or plan to fix. Mark Phase 3.5 todo `in_progress` (still). On the next attempt, re-run spec-review from the top — do NOT cache the previous verdict.

Mark Phase 3.5 todo `completed` only on `ok` or user-acknowledged `concerns`. Move to Phase 4.

## Phase 4 — Handoff (single bash invocation)

This is the gate that often gets dropped if the skill is interrupted. The TodoWrite list still has Phase 4 as `pending` — fix that now.

Construct the issue body:

```bash
SPEC_PATH=docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
PLAN_PATH=docs/superpowers/plans/YYYY-MM-DD-<topic>.md
TITLE="<feature title from Phase 1>"
KIND="feature"  # or "bug" or "improvement" — set per Phase 1's determination
TLDR="$(awk '/^## /{exit} NR>1 && NF' "$SPEC_PATH" | head -10)"

SPEC_REVIEW_BLOCK=""
if [ -f .dev-agent/spec-review-summary.md ]; then
  SPEC_REVIEW_BLOCK=$(cat <<EOF

## Spec review

$(cat .dev-agent/spec-review-summary.md)

EOF
)
fi

BODY=$(cat <<EOF
Spec: ${SPEC_PATH}
Plan: ${PLAN_PATH}

## TL;DR

${TLDR}
${SPEC_REVIEW_BLOCK}
---

Brainstormed and planned via the \`start-feature\` skill in Claude Code. Tap **Approve and start implementation** in the dashboard to dispatch the implement workflow.
EOF
)

gh issue create \
  --title "$TITLE" \
  --body "$BODY" \
  --label "state:spec-ready,kind:${KIND}"
```

**If `gh issue create` fails** because labels don't exist (some older wire-ups didn't pre-create them):

```bash
gh label create "state:spec-ready" --color 0e8a16 --description "Spec written; awaiting approval to implement" --force 2>/dev/null
gh label create "kind:${KIND}" --color 1d76db --description "<kind> work" --force 2>/dev/null
```

…then retry the `gh issue create`.

**Print the issue URL** at the end (gh emits this to stdout — capture and surface it):

```
Filed: https://github.com/<owner>/<repo>/issues/<number>

Next: approve in the dashboard. The engine will implement and open a PR.
```

Mark Phase 4 todo complete. **Now the skill is done.** No further work. The user goes to the dashboard.

## Failure modes

- **No `.dev-agent.yml`** → Phase 0 bails. Tell the user to run `/dev-agent-init` or wire up via the dashboard.
- **`gh` not authenticated** → Phase 0 bails. Tell the user `gh auth login`.
- **No write permission** → Phase 0 bails. The user is not a collaborator with write access.
- **PM emits no Agreed scope after 10 turns** → save the conversation context to `/tmp/start-feature-stuck-$(date +%s).md` and ask the user: continue or abort. Mark the Phase 1 todo `pending` (still in progress).
- **User exits mid-Phase 2 or 3** → spec or plan may be committed but Phase 4 didn't run. **The TodoWrite list still has the open item.** On next invocation, this skill should detect the orphan draft and offer to resume at the correct phase.
- **`gh issue create` fails** for reasons other than missing labels (rate limit, network, perm change since Phase 0) → print the would-be issue body so the user can file manually via the web UI, surface the gh error verbatim, leave Phase 4 todo `pending`.
- **Phase 2 or 3 commit fails** (pre-commit hooks, merge conflict, etc.) → surface the error, leave the corresponding todo `pending`. Do NOT skip ahead.
- **Phase 3.5 spec-review returns `blocker`** → print the summary, refuse to advance, leave Phase 3.5 todo `in_progress`. On re-attempt, fix the cited spec/plan sections then re-run spec-review from the top. Do NOT cache the prior verdict.
- **spec-review skill fails to invoke** (skill not installed, internal error) → emit a warning, log the error, mark Phase 3.5 todo `completed` with note "spec-review unavailable" and proceed to Phase 4. Do not block on tool failures — the dashboard's approve gate is still in place as a backstop.

## Resumption

If invoked when an orphan spec exists in `docs/superpowers/specs/` (committed but no `state:spec-ready` issue references it):

1. Find the most recent orphan: latest spec where neither `docs/plans/<same-date>-<topic>.md` nor `docs/superpowers/plans/<same-date>-<topic>.md` exists, OR exists but no `state:spec-ready` issue links to it.
2. Ask: "Found an orphan spec at `<path>` (`<title from H1>`). Resume from there, or start fresh?"
3. If resume: skip to the correct phase based on what's missing (plan absent → Phase 3, plan present but no issue → Phase 4).

## Notes for the operator

- **Stay inside this skill until Phase 4 completes.** The TodoWrite list is the enforcement. An incomplete todo means an incomplete handoff.
- **The PM persona text lives at `prompts/pm.md` in the dev-agent plugin.** Read it once at Phase 1 start. Don't re-read on every turn.
- **The engine — not this skill — implements the plan.** Once Phase 4 fires, the user lives in the dashboard. Do not offer to "also implement this for you locally" — that's a different runtime and a different control loop.
- **`spec_plan_via_pr` opt-in** is in `.dev-agent.yml` (optional). If set, Phases 2/3 commit to a branch and open a PR instead of pushing to default.
- **Manual override:** if the user explicitly asks to skip a phase ("just file the issue, I'll spec it later"), respect that but mark the todo `completed` with a note rather than `pending`. The user is in control.
