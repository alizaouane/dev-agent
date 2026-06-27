---
name: quick-dev
description: Fast path for trivial work — typos, copy fixes, one-line patches, single-icon swaps. Bypasses Phase 2 brainstorming, Phase 3 plan writing, and Phase 3.5 spec-review. Invoked from start-feature Phase 1 when the PM agent classifies the work as trivial, or when the user passes `--quick` to /develop.
user-invocable: false
---

# quick-dev

Terminal handoff from `start-feature` Phase 1 for trivial work. Writes a 3-paragraph spec to the consumer repo, commits it, and files the `state:spec-ready` issue. The phase-implement engine reads the spec and derives its own task list — `plan_path` is left empty (already supported by `prompts/implement.md`: "Optional — empty for legacy issues filed via the old dashboard chat; in that case, derive your own plan from the spec.").

**Announce at start:** "Using `quick-dev` to fast-path this trivial change."

## When to invoke

This skill is INDIRECT-INVOCATION only. Two entry points, both from `start-feature`:

1. **PM auto-routing** — Phase 1's PM agent estimates effort. If it returns `kind: bug` or `kind: improvement` AND the estimated effort is "<10 minutes / one-liner / typo / copy fix", `start-feature` invokes `dev-agent:quick-dev` instead of advancing to Phase 2.
2. **User-forced via `--quick`** — `/develop --quick "<pitch>"` (or `--from-issue` + `--quick`) signals `start-feature` to skip the trivial-detection heuristic and route here unconditionally.

**Do NOT activate when:**
- The PM has not yet produced an Agreed scope + kind + title — quick-dev is a terminal phase, it cannot do PM evaluation itself
- The work is non-trivial (touches >2 files, has multiple ACs, introduces a new dependency / env var / migration / API contract) — use the full `start-feature` flow instead
- The change requires a brainstorming pass to clarify intent — that's exactly what Phase 2 exists for

## Contract with the caller

Quick-dev is **terminal**: when it completes, `start-feature` is done. The user goes to the dashboard for the three approval gates.

```
Input from caller (start-feature Phase 1):
  - agreed_scope (str) — the PM's distilled "what gets built"
  - kind (str) — "feature" | "bug" | "improvement"
  - feature_title (str) — short title for the issue + spec filename slug
  - consumer_root (str) — the resolved consumer repo working tree
  - forced_quick (bool, optional) — true if `--quick` flag was used, false if PM auto-routed

Output to caller:
  - issue_url (str) — the URL of the filed state:spec-ready issue
  - The user is told to approve in the dashboard. No more work for start-feature.
```

There is no return-to-caller for further work — `start-feature` Phase 1 ends with "invoke quick-dev" or "invoke quick-dev returned with the issue URL." Either way, that's the end of the workflow.

## Flow

### Step 1 — Sanity-check the input

If `agreed_scope` is missing or `feature_title` is missing, **bail**. Quick-dev cannot do PM evaluation itself; the caller must produce these. Surface "ERROR: quick-dev requires agreed_scope + feature_title from start-feature Phase 1" and exit.

If `forced_quick` is true but the agreed_scope describes work that obviously needs a real spec (e.g. "rewrite auth" or "add Stripe integration"), warn loudly:

> The `--quick` flag was passed but the scope reads like substantial work. Quick-dev produces a 3-paragraph spec with no plan and no review — that's right for typos, wrong for refactors. Proceed anyway? (y/n)

Wait for explicit `y`. If the user says no, return to `start-feature` with a request to re-run without `--quick`. (This is the one exception to "no return-to-caller" — bailout before any state is written.)

### Step 2 — Fill the quick-spec template

Read `${PLUGIN_DIR}/templates/quick-spec.template.md`. Fill placeholders:

- `{{feature_title}}` — from `feature_title`
- `{{YYYY-MM-DD}}` — today's date
- `{{owner_name_or_email}}` — from `git config user.email`

Replace each `<…>` block with real content derived from `agreed_scope`:

- **What changes** — one paragraph, literal description of the change in plain English
- **Why** — one paragraph, motivation. If the caller passed a `--from-issue` link or a scout finding, cite it
- **Acceptance Criteria** — usually 1 AC, occasionally 2. Numbered `AC-1`, `AC-2`. Testable, user-visible
- **Files to Touch** — explicit `Modify:` list (and `Create:` if needed). Each `Modify` entry ends with `— <one-line reason>`

Keep all section headers — the implement agent's drift-check still keys on `## Files to Touch`.

Save to `${consumer_root}/docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` where `<topic>` is a 2-4 word slug derived from `feature_title`. **All file writes target `consumer_root`**, never the caller's cwd — `start-feature` may resolve a clone path different from where `/develop` was invoked.

### Step 3 — Commit the spec

```bash
cd "$consumer_root"

git add docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
git commit -m "docs(spec): <feature title>"
git push
```

If `.dev-agent.yml` has `spec_plan_via_pr: true`, branch first (`git checkout -b dev-agent/spec-<topic>`) and open a PR via `gh pr create` instead of pushing to default. Otherwise direct-to-default — these are docs, not code.

### Step 4 — File the issue

Construct the body. Note: `Plan:` line is **deliberately omitted**. `prompts/implement.md` handles the missing-plan case by deriving from the spec.

Capture the consumer repo's slug from inside `consumer_root` and pass it to every `gh` call. The default `gh` behavior follows the cwd's git remote, but `--repo` is the explicit guarantee against filing the issue against the wrong repo when this skill was invoked via `/develop --repo owner/name --quick` from outside the consumer.

```bash
cd "$consumer_root"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

SPEC_PATH=docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
TITLE="<feature title>"
KIND="<kind>"  # from caller — feature / bug / improvement

# Extract the TL;DR from the `## What changes` section specifically.
# Prior implementations stopped at the first `##` heading, which on
# the quick-spec template captured the Date/Owner/Status preamble
# and the HTML comment block instead of the scope summary.
TLDR="$(awk '
  /^## What changes$/ { in_section=1; next }
  /^## / && in_section { exit }
  in_section && NF { print }
' "$SPEC_PATH" | head -10)"

BODY=$(cat <<EOF
Spec: ${SPEC_PATH}

## TL;DR

${TLDR}

---

Quick-dev path: 3-paragraph spec, no separate plan, no spec-review. The implement agent reads the spec directly and derives its own task list. Tap **Approve and start implementation** in the dashboard to dispatch.
EOF
)

gh issue create --repo "$REPO" \
  --title "$TITLE" \
  --body "$BODY" \
  --label "state:spec-ready,kind:${KIND},quick-dev"
```

The `quick-dev` label is informational — surfaces on the dashboard so the approver knows this issue skipped the heavyweight flow.

**If `gh issue create` fails** because labels don't exist (the `quick-dev` label is new):

```bash
gh label create "quick-dev" --repo "$REPO" --color a2eeef --description "Filed via skills/quick-dev — no separate plan, no spec-review" --force 2>/dev/null
gh label create "state:spec-ready" --repo "$REPO" --color 0e8a16 --description "Spec written; awaiting approval to implement" --force 2>/dev/null
gh label create "kind:${KIND}" --repo "$REPO" --color 1d76db --description "<kind> work" --force 2>/dev/null
```

Then retry.

### Step 5 — Surface the result

Print the issue URL and a one-line reminder:

```
Filed: https://github.com/<owner>/<repo>/issues/<number>

Next: approve in the dashboard. The engine will implement and open a PR. No further Claude Code involvement.
```

That's the end of the workflow. `start-feature` is done.

## Failure modes

- **Caller didn't pass agreed_scope or feature_title** → bail immediately. Surface "quick-dev requires start-feature Phase 1 to produce agreed_scope + feature_title" and exit. Do NOT attempt to do PM evaluation.
- **User declines the `--quick` warning when scope looks substantial** → return control to `start-feature` so it can re-run the full flow. The spec hasn't been written yet; no cleanup needed.
- **`gh issue create` fails** for reasons other than missing labels (rate limit, network, perm change) → print the would-be issue body so the user can file manually via the web UI. Surface the gh error verbatim. The spec is already committed; the user just needs to file the issue.
- **Spec commit fails** (pre-commit hooks, merge conflict) → surface the error. The spec is in the working tree; the user can resolve and re-run.

## Discipline

- **Don't pad.** Quick-dev exists because the full flow is overkill for trivial work. If you find yourself writing >300 words of spec content, the work isn't trivial — bail and tell the user to re-run without `--quick`.
- **Don't add plan or test scaffolding.** The full `spec.template.md`'s `Testing strategy` and the separate `plan.template.md` are intentionally absent here. The implement agent derives its own tasks.
- **Always include Files to Touch.** Quick-dev still needs a concrete file list — drift-check enforces scope on every implement run, regardless of which path filed the issue.
- **Don't invoke spec-review.** It would write `.dev-agent/spec-review.json` and prolong the workflow. Quick-dev is for cases where a 30-second adversarial review on a 3-paragraph spec adds no value.
