---
name: spec-review
description: Fresh-context adversarial review of a finished spec + plan before the implement agent runs. Hunts for missing acceptance criteria, vague implementation, files-to-touch paths that don't resolve, scope creep, wheel reinvention, wrong-library usage, and other disaster classes the original spec author may have missed. Use as a sub-skill invoked from `dev-agent:start-feature` Phase 3.5 (after plan written, before issue filed), or stand-alone against a committed spec+plan pair.
user-invocable: false
---

# spec-review

Adversarial reviewer for dev-agent specs and plans. Runs in a **fresh context** — does not trust the original spec author. Inspired by BMAD's `bmad-create-story` checklist pattern, adapted for dev-agent's spec + plan + pillar architecture.

**Announce at start:** "Using `spec-review` to audit the spec + plan before handoff."

## When to invoke

Invoked from `dev-agent:start-feature` Phase 3.5 (between plan-written and issue-filed). Also invokable stand-alone for retroactive review of an existing committed spec+plan pair, e.g. via `dispatchFromSpec` pre-flight.

**Do NOT invoke for:**
- Trivial work (Phase 1 PM eval marked the work as a one-liner / typo / copy fix). For trivial work the spec is a few paragraphs and adversarial review is overkill.
- Specs that have already been reviewed and passed in a prior Phase 3.5 run within the same `start-feature` session (idempotency — don't re-review what just passed).

## Inputs (spec mode)

The invoking skill must provide:

- `spec_path` — absolute path to the spec file (must exist; format per `templates/spec.template.md` in the dev-agent plugin)
- `plan_path` — absolute path to the plan file (must exist; format per `templates/plan.template.md`)
- `consumer_root` — the consumer repo root (used to resolve relative paths in "Files to Touch")

## Derivation-review mode

Invoked from `dev-agent:start-feature` Phase S.1, against a story that was
sharded out of an already-approved spec. A different question from the spec
mode above, and a deliberately lighter one: the spec's design was settled and
paid for at its own approval, so this asks only whether the story faithfully
carries its slice of it.

### Inputs

- `story_path` — repo-relative path to the story file
- `source_spec_path` — repo-relative path to the spec it was sharded from,
  taken from the story's own `Source spec:` line
- `consumer_root` — the consumer repo root

There is no plan. A story is the unit of work; the plan was written at the
spec, and asking a story for one would emit a blocker on every story. Skip
Step 4 below entirely — there are no plan tasks to cross-check against.

### Process

1. Read the story and the source spec in full, in that order, with fresh
   context.
2. Load `{skill-root}/derivation-checklist.md` and run every check in it.
3. Cross-check the story's Files to Touch against the default branch, using
   Step 3's git tree lookups. The same fail-closed rule applies: if the default
   ref cannot be resolved, emit `blocker` rather than downgrading unexecuted
   validation to a concern.
4. Emit a verdict by the same rule the spec mode uses: any `fail` is a
   `blocker`, any `concern` with no `fail` is `concerns`, otherwise `ok`.

**Design content in the story that is absent from the source spec is a
blocker.** Not a note, not a `concern`. The user approves a verdict rather than
reading the document, so a finding that only appears in prose is not a gate at
all. `buildStoryApproval` refuses any verdict that is not `ok`, which makes the
verdict word the entire mechanism. The remedy is to amend the spec, re-approve
it, and approve the story against the amended spec.

### Output

Write `.dev-agent/derivation-review.json` in the consumer repo — the same shape
the spec mode writes, minus the plan and the acceptance-criteria-to-task
cross-check:

```json
{
  "verdict": "ok",
  "story_path": "<path>",
  "source_spec_path": "<path>",
  "checks": [
    { "id": "D1.1", "verdict": "pass", "note": "<one sentence>" }
  ],
  "files_to_touch": {
    "modify_missing": [],
    "test_dirs_missing": []
  },
  "summary": "<markdown — 3-10 lines>"
}
```

Mirror `summary` into `.dev-agent/derivation-review-summary.md`, as the spec
mode does. Print the verdict word on the final line of stdout; Phase S.1 reads
that line and loops until it is `ok`.

## Process

### Step 1: Fresh-context load

Treat this invocation as if you have **never seen** the spec or plan before. Discard any assumptions from the parent session.

Read three things in order, in full:

1. `{{spec_path}}` — the spec
2. `{{plan_path}}` — the plan
3. The consumer's `.dev-agent.yml` — to learn which pillars are configured for this repo (affects "Testing strategy" validation)

### Step 2: Run the checklist

Load `{skill-root}/checklist.md` and execute every check in it in order. Don't skip checks because "the spec looks fine" — that's exactly the bias this skill exists to defeat.

For each check, record:
- `id` — check identifier from checklist.md
- `verdict` — `pass` | `concern` | `fail`
- `note` — one sentence; cite the spec/plan section where the issue is

### Step 3: Cross-check Files to Touch against the default branch tree

For each path in the spec's `## Files to Touch` section:

- **Create** entries: confirm the path does NOT already exist on the default branch (if it does, the spec should say "Modify" instead, or the create will clobber)
- **Modify** entries: confirm the path DOES exist on the default branch
- **Tests** entries: confirm the parent directory exists on the default branch (test files may or may not exist; the directory must)

**Use git tree lookups, not filesystem checks.** The implement agent runs on a fresh checkout of the default branch — a dirty working tree or non-default checkout in `consumer_root` would otherwise let a bad spec sneak past.

```bash
# Resolve the default branch ref once
git fetch --quiet origin 2>/dev/null || true
DEFAULT_REF=$(git symbolic-ref --quiet refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')
DEFAULT_REF=${DEFAULT_REF:-origin/main}  # fallback if origin/HEAD is unset

# Existence check (use this for Create-collision and Modify-resolves):
git cat-file -e "$DEFAULT_REF:$path" 2>/dev/null && echo exists || echo missing

# Directory check (for Tests parent dirs):
git ls-tree -d --name-only "$DEFAULT_REF" "$path" 2>/dev/null
```

Mismatches are gate-failing. If `$DEFAULT_REF` cannot be resolved at all (no origin remote, unfetched, etc.), treat that as a validation-cannot-run condition — see Failure modes.

### Step 4: Cross-check AC ↔ plan tasks

Parse `## Acceptance Criteria` from the spec. Parse `## Task N:` headers from the plan, including their `(AC: N, M)` annotations.

- Every spec AC must be referenced by at least one plan task's `(AC: …)` annotation
- Every plan task must reference at least one AC (no orphan tasks)
- ACs referenced in plan tasks must exist in the spec

Gaps are gate-failing.

### Step 5: Emit verdict

Compute overall verdict:

- **`ok`** — all checks pass, all cross-checks resolve, no concerns
- **`concerns`** — checks pass but ≥1 `concern`-level finding worth surfacing; implementation can proceed but the user should see the findings
- **`blocker`** — any check failed, any cross-check failed, or any `fail`-level finding

Write to `.dev-agent/spec-review.json` in the consumer repo:

```json
{
  "verdict": "ok" | "concerns" | "blocker",
  "spec_path": "<path>",
  "plan_path": "<path>",
  "checks": [
    { "id": "<check-id>", "verdict": "pass" | "concern" | "fail", "note": "<one sentence>" }
  ],
  "files_to_touch": {
    "create_conflicts": ["<paths that already exist>"],
    "modify_missing": ["<paths that don't exist on default branch>"],
    "test_dirs_missing": ["<paths with missing parent directories>"]
  },
  "ac_plan_gaps": {
    "ac_without_task": ["AC-N", "..."],
    "task_without_ac": ["Task M: <name>", "..."],
    "task_refs_unknown_ac": ["Task M references AC-N which doesn't exist"]
  },
  "summary": "<markdown — 3-10 lines, ready to surface in the issue body or dashboard>"
}
```

Mirror `summary` (markdown) into `.dev-agent/spec-review-summary.md` so the parent skill can include it verbatim in the handoff issue body.

### Step 6: Return to the parent skill

Print the verdict word (`ok` | `concerns` | `blocker`) on the final line of stdout. The parent (`start-feature` Phase 3.5) reads that line and decides whether to proceed.

## Behaviour by verdict (for the parent skill's reference)

| Verdict | start-feature Phase 3.5 behaviour |
|---|---|
| `ok` | Proceed silently to Phase 4 (file issue). Reference `.dev-agent/spec-review.json` in the issue body. |
| `concerns` | Print the `summary` block to the user. Ask: "proceed anyway, or address concerns first?" Default: proceed if the user doesn't respond within the same turn. |
| `blocker` | Print the `summary`. Refuse to advance to Phase 4. Tell the user which sections of the spec or plan to fix. Re-run spec-review on next attempt. |

## Failure modes

- **Spec or plan path doesn't exist** → emit `verdict: blocker`, summary "Required input missing: \<path\>".
- **Spec format unparseable** (e.g. missing `## Acceptance Criteria` header) → emit `verdict: blocker`, summary explaining which sections are missing.
- **`.dev-agent.yml` missing** → degrade gracefully — skip the pillar-aware checks (category G) but run everything else. Note in the summary that pillar coverage couldn't be verified.
- **Default-branch ref unresolvable** (no `origin` remote, fetch failed, `origin/HEAD` and `origin/main` both missing) → fail closed. Emit `verdict: blocker`, summary "Files-to-Touch validation could not run: \<error\>". An unverified gate is not the same as a passed gate; downgrading to `concern` here would let invalid Create/Modify lists reach the implement agent.
- **`Bash` calls error** during a check that cannot be retried (working tree busy, perm denied on a path that should exist) → fail closed for the affected check class. Emit `verdict: blocker`, summary stating which check class could not execute and including the original error. Don't degrade unexecuted validation to `concern`.

## Discipline

- Read every file in full. The spec is short; partial reading misses the issues this skill exists to catch.
- Cite the exact spec/plan section in every `note`. Reviewers should be able to jump straight to the problem.
- Stay terse. The dashboard surfaces `summary` directly — long-winded reviews waste user attention.
- Do NOT propose fixes. Identify the issue, cite the location, let the parent skill or the user decide what to do.
