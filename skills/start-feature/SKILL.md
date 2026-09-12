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
- Name an already-sharded story they want to move into implementation (a path
  under `docs/stories/`, or "start work on story 4.2") — see
  [The story door](#the-story-door-an-already-sharded-story) below; this is a
  narrower entry than the rest of this list and skips straight past PM
  evaluation

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
- [ ] Phase 3.5: review → correct loop until the verdict is clean
- [ ] Phase 3.6: user approval recorded (.approval.json committed)
- [ ] Phase 4: GitHub issue filed at state:spec-ready
```

Use the TodoWrite tool. Mark each item `in_progress` when starting that phase, `completed` only when done. **Phase 4 stays `pending` until the issue URL is printed.** An incomplete todo is the visible signal that the skill is not finished — do not announce "done" or end the turn while any item is pending.

**Phase 3.5 skip exception:** if Phase 1's PM evaluation classified the work as trivial (one-liner, typo, copy fix), mark Phase 3.5 `completed` with note "skipped: trivial work" and go to **Phase 3.6**. Adversarial review of a 3-paragraph spec is overkill.

**Phase 3.6 has no skip exception.** Trivial work still needs an approval on record — trivial `bug` and `improvement` work reaches quick-dev, which records one, but a trivial `feature` stays on this flow, and skipping 3.6 there would file an issue the dashboard cannot start. Skip the review, never the approval.

**Quick-dev fast path (replaces the whole list).** If the user passed `--quick` OR if Phase 1's PM evaluation classifies the work as trivial AND `kind` is `bug` or `improvement`, REPLACE the 5-phase checklist above with:

```
- [ ] Phase 1: PM evaluation → Agreed scope + trivial classification
- [ ] Phase 1.5: hand off to dev-agent:quick-dev (spec + issue filed in one shot)
```

Phases 2, 3, 3.5, 3.6, and 4 are all rolled into quick-dev's flow. See `## Phase 1.5 — quick-dev fast path` below for the routing logic.

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

**Optional elicit pass on the Agreed scope.** Before marking Phase 1 complete, offer one round of `dev-agent:elicit` against the Agreed scope text. The PM agent's first-draft scope often hides assumptions about what's "in" vs "out". Invoke via the `Skill` tool with `section_name="Agreed scope"` and `section_content=<the scope text>`. The skill loops on its menu until the user types `x` and returns the enhanced scope. Replace the draft scope with the returned value. **Skip if trivial** (one-liner, typo, copy fix). Skip if the user declines.

Mark Phase 1 todo complete. Decide the path:

- **If `--quick` was passed OR the PM classified trivial AND kind is `bug` or `improvement`** → go to Phase 1.5 (quick-dev).
- **Otherwise** → go to Phase 2 (full spec brainstorm).

## Phase 1.5 — quick-dev fast path (conditional)

Only executes when triggered from Phase 1's path decision. Skipped on the full flow.

Invoke `dev-agent:quick-dev` via the `Skill` tool, passing:

- `agreed_scope` — the PM's distilled scope text
- `kind` — the issue label kind (`bug` / `improvement`; `feature` should NOT auto-route to quick-dev — feature work needs a real spec)
- `feature_title` — the short title from Phase 1
- `consumer_root` — the resolved consumer repo working tree
- `forced_quick` — `true` if `--quick` was passed, `false` if PM auto-routed

Quick-dev fills the `templates/quick-spec.template.md`, commits it, files the `state:spec-ready` + `quick-dev` labeled issue (no `Plan:` line — the implement agent derives its own task list), and returns the issue URL. See [skills/quick-dev/SKILL.md](../quick-dev/SKILL.md) for the full contract.

When quick-dev returns, mark Phase 1.5 todo `completed` and surface the issue URL to the user. **The workflow is done.** Phases 2, 3, 3.5, 3.6, and 4 are not run on this path.

If quick-dev bails (e.g. `forced_quick=true` but the user declines its "looks substantial" warning), return to the full flow: replace the 2-item TodoWrite list with the 5-phase list, and proceed to Phase 2 normally.

## The story door (an already-sharded story)

Everything from Phase 1 through Phase 4 assumes the work starts from a pitch
or a bug report with no document yet. That's most invocations — but not the
one where the user names a story that `/shard` (the PO persona, upstream)
already wrote from an approved program spec. For that shape of work, this
door skips Phase 2's brainstorm entirely, and skips Phase 3's plan-writing too
— the story is already the plan, and re-deriving one from it would be busywork
against a document that exists and was already reviewed once, upstream. What's
left to check is narrower: does this story faithfully carry the slice of the
spec it claims to, not whether the spec itself is sound.

**Trigger.** The user names an already-sharded story directly: a path under
`docs/stories/`, "start work on story 4.2", or `--story <path>` passed to
`/develop`. If no such story exists yet, this isn't the story door — that's a
normal Phase 1 pitch, and running `/shard` is a separate upstream step this
skill does not perform.

When triggered, run Phase 0 pre-flight exactly as above (a story issue still
needs `.dev-agent.yml`, `gh` auth, and write access), then **replace** the
Phase 0.1 checklist with:

```
- [ ] Phase S.1: Read the story, confirm its source spec's approval, run the derivation review → clean verdict
- [ ] Phase S.2: User approval recorded (approve-story)
- [ ] Phase S.3: GitHub issue filed at state:spec-ready
```

### Phase S.1 — Read the story, confirm the spec beneath it, review the derivation

**First, check whether this story is already approved.** A session that
recorded the approval and committed it but died before filing the issue, and a
story a human approved in an earlier session, both land here. `approve-story`
refuses to re-record an approval whose hash already matches, so running Phase
S.2 blind on either of those is a dead end with no way forward.

```bash
STORY_PATH=docs/stories/epic-N-name/N.M-slug.md \
"${PLUGIN_DIR}/node_modules/.bin/tsx" "${PLUGIN_DIR}/lib/cli/verify-approval.ts"
```

Exit 0 means the story carries a valid approval that still matches its current
text — the same decision the dashboard will make when it dispatches. Tell the
user the story is already approved and go **straight to Phase S.3**; do not
review it again and do not ask for an approval that already exists. Exit 1
means there is no usable approval yet, which is the normal case — continue
below. Exit 2 is a usage error; fix the invocation rather than proceeding.

Read the story file. Pull its `Source spec:` line — the same line
`sourceSpecOf` in `lib/cli/approve-story.ts` reads. A story derived from an
unapproved spec is not approvable, so check this **before** spending a review
round on it.

Checking that a `.approval.json` sits next to the spec is **not** that check. A
record can exist and still be unusable: malformed, carrying a `concerns` or
`blocker` verdict, naming a different spec, naming a plan that has since moved,
or gone stale because the spec was edited after it was approved.
`buildStoryApproval` runs the real dispatch gate against all of it and refuses
on any of those — after the derivation review has run and after the user has
been asked to approve. Run the same decision here instead:

```bash
SOURCE_SPEC=<the path from the story's `Source spec:` line>
SPEC_APPROVAL="${SOURCE_SPEC%.md}.approval.json"

if [ ! -f "$SPEC_APPROVAL" ]; then
  echo "ERROR: no approval recorded for $SOURCE_SPEC. The spec this story was sharded from must be approved first."
  exit 1
fi

# The plan the spec was approved WITH, read off the record rather than guessed
# from the filename convention — the gate hashes exactly the pair that was
# approved, and a plan that has moved must refuse rather than be treated as
# "no plan".
PLAN_PATH=$(jq -r '.plan_path // empty' "$SPEC_APPROVAL")

SPEC_PATH="$SOURCE_SPEC" PLAN_PATH="$PLAN_PATH" \
  "${PLUGIN_DIR}/node_modules/.bin/tsx" "${PLUGIN_DIR}/lib/cli/verify-approval.ts"
```

Exit 0 and continue. On a non-zero exit, **stop** and tell the user which gate
is open, quoting the message the command printed — it names the specific
failure. Either the spec this story was sharded from was never approved, its
approval no longer covers its current text, or the story cites the wrong spec.
Reviewing a derivation that has nothing underneath it to derive from wastes a
round and ends in a refusal the user cannot act on.

With that confirmed, invoke `dev-agent:spec-review`'s derivation-review mode
against the story — **not** the full adversarial spec-review Phase 3.5 runs.
The question here is deliberately lighter: does this story faithfully carry
its slice of the already-approved spec, not whether the spec's design is
sound (that question was already settled and paid for at the spec's own
approval). Loop review → correct → re-review exactly as Phase 3.5 does,
tracking the round count, until the verdict is `ok`. The same round cap and
the same "a `concerns` verdict is not a pass" rule from Phase 3.5 apply here.

Mark Phase S.1 complete only on `ok`.

### Phase S.2 — User approval (the one decision that is the user's)

Same discipline as Phase 3.6, aimed at the story instead of the spec+plan
pair. Show the user, in the chat: the story's title and path, its
`Source spec:` line, and how many derivation-review rounds it took. Then ask,
plainly: **"Approve this story so the dashboard can start work on it?"**

**Wait for an explicit answer.** There is no default. Silence is not
approval. If the user asks for changes, make them, return to Phase S.1, and
run the derivation review again from round one.

When the user approves, record it from the consumer repo root. (Phase S.1's
first check has already established there is no valid approval at the story's
current hash, so this cannot collide with one.)

```bash
STORY_PATH=docs/stories/epic-N-name/N.M-slug.md \
REVIEW_VERDICT=ok \
REVIEW_ROUNDS=<rounds it took> \
"${PLUGIN_DIR}/node_modules/.bin/tsx" "${PLUGIN_DIR}/lib/cli/approve-story.ts"
```

`approve-story` re-reads the story's `Source spec:` line itself and refuses
if that spec's own approval is missing, stale, or names a plan that moved —
the check in Phase S.1 saves a wasted review round, it is not the only guard.
On success it stamps the story's `Status:` header to `Approved` and writes
`<story path with .md swapped for .approval.json>` in the same invocation.
Commit and push both:

```bash
git add docs/stories/epic-N-name/N.M-slug.md docs/stories/epic-N-name/N.M-slug.approval.json
git commit -m "docs(story): record approval for <story title>"
git push
```

**Never run `approve-story` on the user's behalf.** Not to unblock yourself,
not because the derivation review was clean and approval looks like a
formality, not because the user approved a different story earlier in the
session. `approved_by` records a human's identity against work they
authorized — the same reason Phase 3.6 carries this rule for `approve-spec`;
writing it without them would make every gate downstream meaningless.

Mark Phase S.2 complete. Move to Phase S.3.

### Phase S.3 — Handoff (file the issue)

```bash
# Canonicalised first, the same way `canonicalStoryPath` does for every reader
# of a story reference. `approve-story` records the path without a leading
# `./`, so filing one with it produces an issue the gate refuses for ever on a
# path mismatch — and makes the duplicate lookup below miss an existing issue
# written the other way.
STORY_PATH=$(printf '%s' "docs/stories/epic-N-name/N.M-slug.md" | sed -E 's#^(\./)+##')
SOURCE_SPEC=docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
TITLE="<story title, from its # Story N.M — Name heading>"
KIND="feature"  # or "bug" or "improvement" — whatever kind the story itself is
EPIC="$(basename "$(dirname "$STORY_PATH")" | sed -E 's/^epic-([0-9]+)-.*/\1/')"

# Guard: EPIC must be numeric. The sed pattern leaves non-matching input
# unchanged, so docs/stories/misc-fixes/ silently produces EPIC=misc-fixes
# instead of failing. That malformed label is invisible until something
# (slice 4's grouping by epic) depends on it. Stop and ask.
if [[ ! "$EPIC" =~ ^[0-9]+$ ]]; then
  echo "ERROR: Could not derive epic number from story directory. The story must be in docs/stories/epic-N-<name>/ (e.g., epic-8-agent-reliability/). Enter the epic number manually and try again."
  exit 1
fi

# Guard: has this story already been filed? The spec door's open-pipeline
# lookup lives in Phase 1, which this door skips, so re-entering it would
# file a second issue for the same story — and implement concurrency and
# branch names are keyed by issue number, so both could dispatch independent
# agents against one approved story.
#
# Matched by exact line after trimming, which is what both readers of a
# `Story:` reference accept. Listed and filtered locally rather than handed
# to GitHub's search index, which is eventually consistent and would report a
# just-filed issue as absent.
LIMIT=500
ISSUES=$(gh issue list --state all --limit "$LIMIT" --json number,url,state,body)

# A listing that hit the limit is a short listing, not an empty one. Filing a
# duplicate off the back of one is a search that could not see something
# reporting the something is not there. Stop instead.
if [ "$(jq 'length' <<<"$ISSUES")" -ge "$LIMIT" ]; then
  echo "ERROR: the issue list was truncated at $LIMIT, so an existing issue for this story may not be visible. Check by hand before filing: gh issue list --search \"Story: ${STORY_PATH}\" --state all"
  exit 1
fi

# Quoted regions come out first, the same two halves `stripQuotedRegions`
# strips: fenced blocks that actually close, then inline backtick spans
# across the joined body. This lookup is a FOURTH reader of a `Story:` line
# after the dashboard parser, the workflow grep and the gate, and all three
# of those strip. Without it an issue that merely quotes the target line in
# an example matches as that story's own issue, and the real one is never
# filed. An unpaired fence opener is left alone, as it is there.
#
# The path is then pulled OUT of each candidate line and canonicalised
# before comparison, rather than the line being matched verbatim: an issue
# filed as `Story: ./docs/...` names the same story as one filed without the
# prefix, and a comparison that cannot see that files the duplicate this
# guard exists to prevent.
EXISTING=$(jq -c --arg want "$STORY_PATH" '
  def strip_quoted:
    (split("\n") | map(sub("\r$"; ""))) as $lines
    | [range(0; $lines | length) | select($lines[.] | test("^ {0,3}(```|~~~)"))] as $f
    | (($f | length) - (($f | length) % 2)) as $paired
    | ([range(0; $paired; 2) as $i | range($f[$i]; $f[$i + 1] + 1)] | map(tostring)) as $drop
    | [range(0; $lines | length) | select(([tostring] | inside($drop)) | not) | $lines[.]]
    | join("\n")
    | gsub("`[^`]*`"; "");
  map(select((((.body // "") | strip_quoted | split("\n"))
       | map(sub("^[ \t]+"; "") | sub("[ \t]+$"; ""))
       | map(select(test("^Story:[ \t]*[^ \t]+\\.md$")))
       | map(capture("^Story:[ \t]*(?<p>[^ \t]+\\.md)$").p | sub("^(\\./)+"; ""))
     ) | index($want)))
  | .[0] // empty' <<<"$ISSUES")

if [ -n "$EXISTING" ]; then
  echo "This story is already filed as $(jq -r '.url' <<<"$EXISTING") ($(jq -r '.state' <<<"$EXISTING"))."
  echo "Open: go to the dashboard and tap Start work on it. Closed: the story has already been through the pipeline — ask the user before filing anything new."
  exit 0
fi

TLDR="<a few lines summarizing what the story ships>"
APPROVAL_PATH="${STORY_PATH%.md}.approval.json"

BODY=$(cat <<EOF
Story: ${STORY_PATH}

## TL;DR

${TLDR}

---

Sharded from \`${SOURCE_SPEC}\` and approved via the \`start-feature\` skill in Claude Code. Tap **Start work** in the dashboard to dispatch the implement workflow. The dashboard verifies the approval at \`${APPROVAL_PATH}\` still matches the story before it dispatches anything.
EOF
)

gh issue create \
  --title "$TITLE" \
  --body "$BODY" \
  --label "state:spec-ready,kind:${KIND},epic:${EPIC}"
```

Note: no `Plan:` line — a story is its own plan, so there is nothing separate
to point at.

Note also that the `Story:` line is deliberately **not** backticked, for the
same reason `Spec:` isn't in Phase 4's body: the dashboard's parser
(`/^\s*Story:\s*(\S+\.md)\s*$/m`) and the workflow's grep are both
end-anchored, and both strip or reject quoted regions. A backticked path is
invisible to either — the issue would file cleanly and then refuse at the
dispatch gate with "no Story: line", which reads like a bug in the gate
rather than in the issue body it actually is. Every other path in this body
may be backticked; this one may not.

**If `gh issue create` fails** because labels don't exist:

```bash
gh label create "state:spec-ready" --color 0e8a16 --description "Spec written; awaiting approval to implement" --force 2>/dev/null
gh label create "kind:${KIND}" --color 1d76db --description "<kind> work" --force 2>/dev/null
gh label create "epic:${EPIC}" --color 5319e7 --description "Epic ${EPIC}" --force 2>/dev/null
```

…then retry the `gh issue create`.

**Print the issue URL**, same shape as Phase 4:

```
Filed: https://github.com/<owner>/<repo>/issues/<number>

Next: approve in the dashboard. The engine will implement and open a PR.
```

Mark Phase S.3 complete. **Now the skill is done.** No further work. The user
goes to the dashboard.

## Phase 2 — Spec writing (inline brainstorming)

**Do NOT invoke `superpowers:brainstorming` as a separate skill.** That skill has its own terminal state ("invoke writing-plans") which would steal control. Inline the brainstorming pattern directly.

The brainstorming pattern:

1. **One question at a time.** Don't dump 5 questions at once. Ask, get an answer, internalize, ask the next.
2. **Multiple choice when possible.** Easier to answer than open-ended. Use the `AskUserQuestion` tool with concrete options when there's a fork.
3. **Propose 2-3 approaches before settling.** For non-trivial work, sketch alternatives with trade-offs and your recommendation.
4. **Present the design in sections, get approval per section.** Scale each section to its complexity (a sentence for trivial, 200-300 words for nuanced). Don't write the whole spec then ask for approval — chunks make corrections cheap.
5. **YAGNI ruthlessly.** Remove unnecessary features. The user's pitch is a seed, not a contract.
6. **Optional elicit pass per major section.** After drafting `## Context`, `## Acceptance Criteria`, `## Architecture`, or `## Edge cases`, offer up to one round of `dev-agent:elicit` on that section (user may decline). Invoke via the `Skill` tool with `section_name=<the H2 header>` and `section_content=<the just-drafted text>`. The skill loops on its menu and returns the enhanced section text on the user's `x`. Replace the draft with the returned value. The skill cannot advance Phase 2 on its own — when it returns, you're back here writing the next section.

**Trivial work shortcut.** If during Phase 1 the PM determined this is a one-liner (typo, color tweak, copy fix), skip the design sections and write a 3-paragraph spec: "what changes, why, acceptance criteria." Do not force a multi-question brainstorm or any elicit pass on trivial work.

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

## Phase 3.5 — Review and correct, until the review is clean

The user does not read specs. An independent reviewer does, and the spec is
corrected and re-reviewed until that reviewer has nothing blocking left to say.
Only then is there something worth approving. This phase is that loop.

**Clear stale artifacts first**, before branching on any verdict. After this the
files exist only if the current run produced them, so Phase 4 cannot pick up
review text from a previous `/develop` run in this clone:

```bash
rm -f .dev-agent/spec-review.json .dev-agent/spec-review-summary.md
```

**Skip if trivial.** If Phase 1 marked the work trivial (one-liner, typo, copy
fix), mark Phase 3.5 `completed` with note "skipped: trivial work" and go to
Phase 3.6. The review is what gets skipped; the approval is not. On that path
Phase 3.6 records `REVIEW_ROUNDS=1` and says plainly to the user that no
independent review ran.

### The loop

Track the round number; it goes into the approval record.

1. Invoke `dev-agent:spec-review` via the `Skill` tool, passing absolute paths
   to the spec and plan. It runs a fresh-context audit, writes
   `.dev-agent/spec-review.json` and `.dev-agent/spec-review-summary.md`, and
   prints the verdict word on its final stdout line.
2. Read the verdict:
   - **`ok`** — the loop is done. Go to Phase 3.6.
   - **`concerns` or `blocker`** — **correct the spec and plan yourself.** Do
     not ask the user which findings to address, and do not carry findings
     forward into the issue body for someone else to weigh. Read each finding,
     edit the affected sections of the spec or plan, commit the correction, and
     go back to step 1 for another round. Re-run the review from scratch every
     round — never reuse the previous verdict.
3. Repeat until the verdict is `ok`.

**On a finding you believe is wrong:** say so in one sentence, in the spec
itself, in the section the reviewer flagged. A finding you disagree with still
has to be answered in the document, because the document is what the next
reviewer and the implement agent read. An unanswered finding is a finding.

**Round cap.** If four rounds pass without reaching `ok`, stop looping. Print
the outstanding findings and tell the user plainly that the spec is not
converging and why. Leave Phase 3.5 `in_progress`. Do not file an issue, and do
not record an approval — a spec the reviewer keeps rejecting is exactly the case
this gate exists for. Four rounds means either the scope is wrong (return to
Phase 1) or the reviewer has found something real that needs a decision only the
user can make.

**A `concerns` verdict is not a pass.** Earlier versions of this skill let
`concerns` through by default when the user did not answer within the turn.
That inverted the point: it made the quiet path the one where unreviewed
concerns reach the implement agent. Correct them instead.

Mark Phase 3.5 `completed` only on `ok`. Move to Phase 3.6.

## Phase 3.6 — User approval (the one decision that is the user's)

The review is clean. Now, and only now, ask the user.

Show them, in the chat:

- The feature title and the agreed scope from Phase 1.
- The spec and plan paths.
- How many review rounds it took, and one line on what the reviewer caught and
  you corrected. This is the substance of the ask — the user is approving that
  the review happened and concluded cleanly, not re-reading the spec.

Then ask, plainly: **"Approve this spec so the dashboard can start work on it?"**

**Wait for an explicit answer.** There is no default. Silence is not approval,
and neither is "sounds good, carry on" said about something else earlier in the
session. If the user asks for changes, make them, return to Phase 3.5, and run
the review again from round one.

**When the user approves**, record it from the consumer repo root:

```bash
SPEC_PATH=docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md \
PLAN_PATH=docs/superpowers/plans/YYYY-MM-DD-<topic>.md \
REVIEW_VERDICT=ok \
REVIEW_ROUNDS=<rounds it took> \
"${PLUGIN_DIR}/node_modules/.bin/tsx" "${PLUGIN_DIR}/lib/cli/approve-spec.ts"
```

`npx` is deliberately not used here: on a cache miss it resolves `tsx` from the
network at approval time, which is the wrong moment to pull an unpinned package.
The plugin ships its own pinned binary. If `${PLUGIN_DIR}/node_modules/.bin/tsx`
is missing, run `npm ci` in `${PLUGIN_DIR}` once rather than
reaching for `npx`.

This writes `<spec path with .md swapped for .approval.json>` next to the spec:
the verdict, the round count, the approver's git identity, the timestamp, and a
sha256 over the spec and plan contents together. Commit and push it on the same
branch as the spec and plan:

```bash
git add docs/superpowers/specs/YYYY-MM-DD-<topic>-design.approval.json
git commit -m "docs(spec): record approval for <feature title>"
git push
```

**The hash is the point.** The dashboard recomputes it before it will start
anything. Edit the spec or the plan after this and the approval stops matching,
the Start work button goes dead, and the fix is to re-run Phase 3.5 and 3.6
rather than to argue with the button. That is deliberate: an approval that
survives an edit is an approval of text nobody read.

**Never run `approve-spec` on the user's behalf.** Not to unblock yourself, not
because the review was clean and approval looks like a formality, not because
the user approved a different spec earlier in the session. `APPROVED_BY` records
a human's identity against work they authorized; writing it without them is the
single thing in this skill that would make every gate downstream meaningless.

Mark Phase 3.6 `completed`. Move to Phase 4.

## Phase 4 — Handoff (single bash invocation)

This is the gate that often gets dropped if the skill is interrupted. The TodoWrite list still has Phase 4 as `pending` — fix that now.

Construct the issue body:

```bash
SPEC_PATH=docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
PLAN_PATH=docs/superpowers/plans/YYYY-MM-DD-<topic>.md
TITLE="<feature title from Phase 1>"
KIND="feature"  # or "bug" or "improvement" — set per Phase 1's determination
TLDR="$(awk '/^## /{exit} NR>1 && NF' "$SPEC_PATH" | head -10)"

APPROVAL_PATH="${SPEC_PATH%.md}.approval.json"

SPEC_REVIEW_BLOCK=""
if [ -f .dev-agent/spec-review-summary.md ]; then
  SPEC_REVIEW_BLOCK=$(cat <<EOF

## Spec review

$(cat .dev-agent/spec-review-summary.md)

_Machine-readable verdict: \`.dev-agent/spec-review.json\`. Approval: \`${APPROVAL_PATH}\`, checked by the dashboard before it will start work._

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

Brainstormed, planned, independently reviewed and approved via the \`start-feature\` skill in Claude Code. Tap **Start work** in the dashboard to dispatch the implement workflow. The dashboard verifies the approval at \`${APPROVAL_PATH}\` still matches the spec and plan before it dispatches anything.
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
