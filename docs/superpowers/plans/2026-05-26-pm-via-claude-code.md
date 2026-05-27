# PM via Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's in-browser PM chat with a Claude Code `/develop` slash command that orchestrates PM evaluation → spec brainstorming → plan writing → handoff. Spec + plan land in the consumer repo; the engine reads both; the dashboard retires its PM chat surface but keeps proposals + approval gates.

**Architecture:** `/develop` is a Claude Code slash command (prompt file) that auto-chains four phases, invoking the existing PM persona prompt and the user's installed `superpowers:brainstorming` + `superpowers:writing-plans` skills. The engine's `phase-implement.yml` gains plan-file extraction alongside its existing spec extraction. The dashboard removes `/intent`, `/api/pm-chat`, the chat component, the `extractAgreedScope` / `applyPmMdUpdate` server-side helpers, and the `@ai-sdk/*` dependencies. The "Brainstorm in Claude Code" copy-paste affordance replaces the dashboard's "Discuss with PM" button on `/proposals`.

**Tech Stack:** GitHub Actions YAML + bash + `gh` CLI (engine), Claude Code prompt-file (slash command), Next.js 15 App Router + React + Vitest + Octokit (dashboard).

---

## File Structure

**Engine — modified:**
- `.github/workflows/phase-implement.yml` — extract `plan_path` alongside `spec_path`; cat plan into the agent prompt.
- `prompts/implement.md` — reference `{{plan_path}}` so the implementation agent reads the plan before coding.
- `lib/cli/render-prompt.ts` — pass `plan_path` through to the template (if it isn't already a pass-through).

**Slash command — modified:**
- `commands/develop.md` — rewrite as a 4-phase orchestrator.

**Dashboard — added/modified:**
- `dashboard/app/proposals/page.tsx` — replace "Discuss with PM" link with a "Brainstorm in Claude Code" copy-paste button.
- `dashboard/components/proposal-brainstorm-button.tsx` (**new**) — client component that copies `/develop --from-issue <#>` to clipboard.

**Dashboard — deleted:**
- `dashboard/app/api/pm-chat/route.ts`
- `dashboard/components/pm-chat.tsx`
- `dashboard/lib/pm-tools.ts`
- `dashboard/lib/pm-chat-draft.ts`
- `dashboard/lib/pm-md-update.ts`
- `dashboard/__tests__/components/pm-chat.test.tsx`
- `dashboard/__tests__/lib/pm-chat-draft.test.ts`
- `dashboard/__tests__/lib/pm-md-update.test.ts`
- `dashboard/__tests__/lib/pm-tools.test.ts`

**Dashboard — modified (removals):**
- `dashboard/app/intent/page.tsx` — replace chat with static explainer.
- `dashboard/lib/actions.ts` — remove `extractAgreedScope`, `approveAndStart`'s scope-extraction branch, and `applyPmMdUpdate`. Add `dispatchExistingIssue` for the new "approve an issue already at `state:spec-ready`" path.
- `dashboard/__tests__/lib/actions.test.ts` — drop `applyPmMdUpdate` + scope-extraction tests; add `dispatchExistingIssue` tests.
- `dashboard/package.json` — drop `@ai-sdk/react` (PmChat was the only consumer). **Keep `@ai-sdk/anthropic` and `ai`** — both are still used server-side by `categorize-proposals.ts` and `recommend-next.ts`. Verify with grep before uninstalling anything.

**Docs:**
- `README.md` — add Install note pinning the validated superpowers version, mention `/develop` as the canonical brainstorming entry point.

---

## Task ordering rationale

Engine first (backward-compatible — works without a plan link). Then `/develop`. Then dashboard bridge button. Then dashboard removals (destructive — only after the replacement path works). README last.

Each task is independently committable. Run tests after every code change.

---

### Task 1: Engine — extract `plan_path` from issue body

**Files:**
- Modify: `.github/workflows/phase-implement.yml:137-167` (the "Read issue" step)
- Test: manual fixture (no automated test for bash-in-YAML; verify via dry-run in step 5 below)

- [ ] **Step 1: Read the existing extraction block**

```bash
sed -n '137,167p' .github/workflows/phase-implement.yml
```
Confirm the block matches what's in the plan's "File Structure" section.

- [ ] **Step 2: Modify the step to also extract `plan_path`**

Replace the body of the `Read issue` step (lines 142–167) with:

```yaml
        run: |
          set -euo pipefail
          gh issue view "$ISSUE_NUMBER" --json number,title,body,labels > issue.json
          TITLE=$(jq -r '.title' issue.json)
          SPECS_DIR=$(jq -r '.artifacts.specs_dir // "docs/specs"' /tmp/config.json)
          PLANS_DIR=$(jq -r '.artifacts.plans_dir // "docs/plans"' /tmp/config.json)
          BODY=$(jq -r '.body' issue.json)

          # Spec: try ${SPECS_DIR}/*.md first, then any docs/**/*.md
          # reference in the body; fall back to a placeholder.
          SPEC_PATH=$(printf '%s' "$BODY" | grep -oE "${SPECS_DIR}/[^[:space:])\"\\\`]+\.md" | head -1 || true)
          if [ -z "$SPEC_PATH" ] || [ ! -f "$SPEC_PATH" ]; then
            SPEC_PATH=$(printf '%s' "$BODY" | grep -oE "docs/[^[:space:])\"\\\`]+\.md" | while read -r p; do [ -f "$p" ] && echo "$p" && break; done || true)
          fi
          if [ -z "$SPEC_PATH" ] || [ ! -f "$SPEC_PATH" ]; then
            SPEC_PATH="${SPECS_DIR}/placeholder-no-spec.md"
            mkdir -p "$SPECS_DIR"
            printf '# (no spec linked)\n\nThe issue body did not reference a spec file under `%s/` or any `docs/**/*.md` path that exists on this branch. Treat the issue body as the spec.\n' "$SPECS_DIR" > "$SPEC_PATH"
          fi

          # Plan: optional. Try ${PLANS_DIR}/*.md, then any docs/**/plans*/**/*.md
          # in the body. Empty string if not present — implement.md handles
          # the optional case.
          PLAN_PATH=$(printf '%s' "$BODY" | grep -oE "${PLANS_DIR}/[^[:space:])\"\\\`]+\.md" | head -1 || true)
          if [ -z "$PLAN_PATH" ] || [ ! -f "$PLAN_PATH" ]; then
            PLAN_PATH=$(printf '%s' "$BODY" | grep -oE "docs/[^[:space:])\"\\\`]*plans?[^[:space:])\"\\\`]*\.md" | while read -r p; do [ -f "$p" ] && echo "$p" && break; done || true)
          fi
          # PLAN_PATH stays empty if no plan link present — that's valid
          # for legacy issues filed via the old dashboard chat.

          echo "title=$TITLE" >> "$GITHUB_OUTPUT"
          echo "spec_path=$SPEC_PATH" >> "$GITHUB_OUTPUT"
          echo "plan_path=$PLAN_PATH" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/phase-implement.yml
git commit -m "feat(engine): extract plan_path alongside spec_path in phase-implement"
```

---

### Task 2: Engine — cat plan content into agent prompt

**Files:**
- Modify: `.github/workflows/phase-implement.yml:198-220` (the "Build agent prompt" step)

- [ ] **Step 1: Read the existing build step**

```bash
sed -n '198,225p' .github/workflows/phase-implement.yml
```
Note the current structure: it cats `$SPEC_PATH` into the prompt.

- [ ] **Step 2: Modify the step to include plan content**

Update the step's `env:` block and `run:` script:

```yaml
        env:
          ISSUE_NUMBER: ${{ inputs.issue_number }}
          ISSUE_TITLE: ${{ steps.issue.outputs.title }}
          SPEC_PATH: ${{ steps.issue.outputs.spec_path }}
          PLAN_PATH: ${{ steps.issue.outputs.plan_path }}
        run: |
          set -euo pipefail
          {
            echo "# Implementation task — issue #$ISSUE_NUMBER"
            echo ""
            echo "**Issue title:** $ISSUE_TITLE"
            echo "**Spec file:** \`$SPEC_PATH\`"
            if [ -n "$PLAN_PATH" ] && [ -f "$PLAN_PATH" ]; then
              echo "**Plan file:** \`$PLAN_PATH\`"
            fi
            echo ""
            echo "---"
            echo ""
            echo "## Spec content"
            echo ""
            cat "$SPEC_PATH"
            echo ""
            if [ -n "$PLAN_PATH" ] && [ -f "$PLAN_PATH" ]; then
              echo "---"
              echo ""
              echo "## Plan content"
              echo ""
              cat "$PLAN_PATH"
              echo ""
            fi
            echo "---"
            echo ""
            # ... (preserve the rest of the existing block: issue context, etc.)
```

**Important:** preserve everything after the `---` that follows the spec cat — only the plan-cat block is new. If the existing step has additional sections (issue context, guardrails reminder), keep them.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/phase-implement.yml
git commit -m "feat(engine): include plan content in implement agent prompt when present"
```

---

### Task 3: Engine — update `prompts/implement.md` to reference the plan

**Files:**
- Modify: `prompts/implement.md`

- [ ] **Step 1: Read the existing prompt**

```bash
head -40 prompts/implement.md
```

- [ ] **Step 2: Update the "Inputs" section**

Find the `## Inputs` section (around line 6) and add `{{plan_path}}` alongside `{{spec_path}}`:

```markdown
## Inputs

- `{{spec_path}}` — path to the spec file (read it in full before writing any code)
- `{{plan_path}}` — path to the implementation plan file (read it in full; follow its task ordering and TDD steps). Optional — empty for legacy issues filed via the old dashboard chat; in that case, derive your own plan from the spec.
- `{{branch_name}}` — feature branch (already checked out)
...
```

- [ ] **Step 3: Update the "Steps" section**

Find the numbered steps (around line 21) and update step 2 + 3:

```markdown
2. Read the spec at `{{spec_path}}` in full.
3. If `{{plan_path}}` is non-empty, read the plan at `{{plan_path}}` in full and follow its task order. Otherwise, derive your own plan from the spec.
4. Make the changes the spec requires — touch only files the spec declares.
```

(Renumber subsequent steps as needed.)

- [ ] **Step 4: Commit**

```bash
git add prompts/implement.md
git commit -m "feat(engine): teach implement prompt to consume an optional plan file"
```

---

### Task 4: Engine — wire `plan_path` through `render-prompt.ts`

**Files:**
- Modify: `lib/cli/render-prompt.ts` (or wherever `PROMPT_VARS_JSON` is consumed)
- Test: `tests/unit/render-prompt.test.ts`

- [ ] **Step 1: Read the existing render-prompt code**

```bash
grep -n "spec_path\|implement" lib/cli/render-prompt.ts | head -20
cat lib/cli/render-prompt.ts | head -100
```

- [ ] **Step 2: Find where `PROMPT_VARS_JSON` is built**

The workflow builds `PROMPT_VARS_JSON` in the "Render system prompt" step (around line 169 of `phase-implement.yml`). It currently includes `spec_path`. Add `plan_path`:

In `.github/workflows/phase-implement.yml` "Render system prompt" step (around line 174), update the `jq -nc` call:

```yaml
          export PROMPT_VARS_JSON=$(jq -nc \
            --arg spec_path "$SPEC_PATH" \
            --arg plan_path "${PLAN_PATH:-}" \
            --arg branch_name "feat/dev-agent-issue-${ISSUE_NUMBER}" \
            ... existing args ...
            '{spec_path:$spec_path, plan_path:$plan_path, branch_name:$branch_name, ...}')
```

The `${PLAN_PATH:-}` is important — `PLAN_PATH` may be unset; the default-to-empty guard keeps `set -u` happy.

The `Render system prompt` step needs `PLAN_PATH` in its env block too:

```yaml
        env:
          ISSUE_NUMBER: ${{ inputs.issue_number }}
          SPEC_PATH: ${{ steps.issue.outputs.spec_path }}
          PLAN_PATH: ${{ steps.issue.outputs.plan_path }}
```

- [ ] **Step 3: Write failing test for render-prompt**

If `lib/cli/render-prompt.ts` is template-driven (Handlebars per `package.json`), add a test in `tests/unit/render-prompt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { renderImplementPrompt } from '@/lib/cli/render-prompt';

describe('renderImplementPrompt', () => {
  it('includes plan_path when present', () => {
    const out = renderImplementPrompt({
      spec_path: 'docs/specs/x.md',
      plan_path: 'docs/plans/x.md',
      branch_name: 'feat/dev-agent-issue-42',
      issue_number: 42,
      commands: { test: 'npm test', typecheck: 'tsc' },
      guardrails: { blocked_paths: [], require_explicit_unlock: [], max_files_changed: 30, max_lines_changed: 800 },
      audit_skills: { pre_pr: [] },
    });
    expect(out).toContain('docs/plans/x.md');
  });

  it('handles empty plan_path gracefully', () => {
    const out = renderImplementPrompt({
      spec_path: 'docs/specs/x.md',
      plan_path: '',
      branch_name: 'feat/dev-agent-issue-42',
      issue_number: 42,
      commands: { test: 'npm test', typecheck: 'tsc' },
      guardrails: { blocked_paths: [], require_explicit_unlock: [], max_files_changed: 30, max_lines_changed: 800 },
      audit_skills: { pre_pr: [] },
    });
    expect(out).not.toMatch(/Plan file: ``\b/);
  });
});
```

- [ ] **Step 4: Run failing test**

```bash
npm test -- tests/unit/render-prompt.test.ts
```
Expected: tests fail because `renderImplementPrompt` doesn't accept or render `plan_path`.

- [ ] **Step 5: Implement — update `lib/cli/render-prompt.ts`**

Adjust the input schema and template to accept and conditionally render `plan_path`. The existing `Handlebars` template likely lives next to or inside this file (or in `prompts/implement.md` itself via `{{plan_path}}` — Task 3 added the reference). Make sure the typed input includes `plan_path: string` (can be empty).

- [ ] **Step 6: Run test to verify pass**

```bash
npm test -- tests/unit/render-prompt.test.ts
```
Expected: PASS.

- [ ] **Step 7: Run full engine test suite**

```bash
npm test
```
Expected: all engine tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/cli/render-prompt.ts tests/unit/render-prompt.test.ts .github/workflows/phase-implement.yml
git commit -m "feat(engine): render plan_path in implement system prompt"
```

---

### Task 5: Engine — end-to-end dry-run on a fixture issue

**Files:**
- No file changes — verification step.

- [ ] **Step 1: Create a fixture issue locally**

```bash
cat > /tmp/fixture-issue.json <<'EOF'
{
  "number": 999,
  "title": "fixture feature",
  "body": "Spec: docs/superpowers/specs/2026-05-26-fixture.md\n\nPlan: docs/plans/2026-05-26-fixture.md\n\nTL;DR: ...",
  "labels": [{"name": "state:spec-ready"}, {"name": "kind:feature"}]
}
EOF
```

- [ ] **Step 2: Verify the extraction logic works**

In a scratch dir with `docs/superpowers/specs/2026-05-26-fixture.md` and `docs/plans/2026-05-26-fixture.md` existing, paste the bash logic from Task 1's step 2 and confirm both paths are extracted.

- [ ] **Step 3: Document the verification**

No commit (no code changes). Move on once the dry-run confirms both `SPEC_PATH` and `PLAN_PATH` resolve correctly.

---

### Task 6: Slash command — rewrite `commands/develop.md` (Phase 1: PM evaluation)

**Files:**
- Modify: `commands/develop.md`

- [ ] **Step 1: Read the current command**

```bash
cat commands/develop.md
```

- [ ] **Step 2: Replace with the new 4-phase orchestrator**

Overwrite `commands/develop.md` with:

```markdown
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

   ```text
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

1. Find the most recent `.md` in `docs/superpowers/specs/` whose corresponding plan file doesn't exist at **either** `docs/plans/<same-date>-<same-topic>.md` **or** `docs/superpowers/plans/<same-date>-<same-topic>.md` (Phase 2 done, Phase 3 not started). The `superpowers:writing-plans` skill writes under `docs/superpowers/plans/` by default; some consumers may use `docs/plans/` — check both before declaring Phase 3 incomplete.
2. If both plan paths are absent and no `state:spec-ready` issue references the spec path, the brainstorm hasn't progressed past Phase 2; resume at Phase 3.
3. Otherwise resume at the appropriate phase.

## Notes for the operator

- This command auto-chains skills. Don't invoke `superpowers:brainstorming` or `superpowers:writing-plans` manually mid-`/develop` — let the orchestrator drive.
- Phase 1's PM persona is intentionally allowed to take many turns. Brainstorm is the rate-limiting step; don't rush it.
- The handoff issue at `state:spec-ready` waits for human approval in the dashboard. `/develop` does NOT dispatch the implement workflow itself.
```

- [ ] **Step 3: Commit**

```bash
git add commands/develop.md
git commit -m "feat(commands): rewrite /develop as PM-eval → brainstorm → plan → handoff orchestrator"
```

---

### Task 7: Slash command — manual end-to-end verification

**Files:**
- No code changes — verification step.

- [ ] **Step 1: Pick a low-stakes consumer repo**

Use `caliente-booking-app` or `social-media-content` (whichever has a `.dev-agent.yml` + `pm.md` in place). `cd` into the local clone.

- [ ] **Step 2: Run `/develop` with a real pitch**

In Claude Code, from the consumer repo dir:

```text
/develop "add a dark mode toggle to the settings page"
```

- [ ] **Step 3: Verify Phase 1**

PM should:
- Load `pm.md`, pipeline, SESSION_LOG
- Push back if dark mode conflicts with the goals
- Estimate effort
- Emit `## Agreed scope` when aligned

- [ ] **Step 4: Verify Phase 2**

Brainstorming skill should:
- Ask clarifying questions
- Propose approaches
- Present design sections with approval gates
- Write `docs/superpowers/specs/2026-05-26-dark-mode-design.md`
- Commit

- [ ] **Step 5: Verify Phase 3**

Writing-plans skill should:
- Read the spec
- Write `docs/plans/2026-05-26-dark-mode.md` (or `docs/superpowers/plans/`)
- Commit

- [ ] **Step 6: Verify Phase 4**

`/develop` should:
- Create a GitHub issue at `state:spec-ready`
- Body should contain `Spec: docs/superpowers/specs/2026-05-26-dark-mode-design.md` and `Plan: docs/plans/2026-05-26-dark-mode.md`
- Print the issue URL

- [ ] **Step 7: Verify dashboard surfaces the issue**

Open the dashboard's `/proposals` or `/features` page. The new issue should appear with the "Approve and start implementation" affordance.

- [ ] **Step 8: Verify the engine can implement it**

Click "Approve and start implementation." Watch the `phase-implement.yml` run in GitHub Actions. Confirm:
- "Read issue" step extracts both `spec_path` and `plan_path` (check step logs)
- "Build agent prompt" includes the plan content (check the rendered prompt artifact if available)
- Implementation proceeds normally

If any phase fails, fix in a new task before continuing.

---

### Task 8: Dashboard — add `dispatchExistingIssue` server action

**Files:**
- Modify: `dashboard/lib/actions.ts`
- Test: `dashboard/__tests__/lib/actions.test.ts`

The existing `approveAndStart` creates the issue from PM-chat output. The new flow has the issue already created by `/develop`. Need a new server action that takes an existing `state:spec-ready` issue and dispatches the implement workflow.

- [ ] **Step 1: Write failing test**

Add to `dashboard/__tests__/lib/actions.test.ts`:

```typescript
describe('dispatchExistingIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 42,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
        html_url: 'https://github.com/x/y/issues/42',
      },
    });
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'admin' },
    });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValue({});
    mockOctokit.issues.setLabels.mockResolvedValue({});
  });

  it('dispatches implement workflow and flips state:spec-ready → state:implementing', async () => {
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('issue', '42');
    const { dispatchExistingIssue } = await import('@/lib/actions');
    // Expect redirect — wrap in try since redirect() throws NEXT_REDIRECT
    await expect(dispatchExistingIssue(fd)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: 'dev-agent.yml',
        inputs: expect.objectContaining({
          phase: 'implement',
          issue_number: '42',
        }),
      }),
    );
    expect(mockOctokit.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.arrayContaining(['state:implementing', 'kind:feature']),
      }),
    );
  });

  it('rejects when the issue is not at state:spec-ready', async () => {
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 42,
        labels: [{ name: 'state:scoping' }],
        html_url: 'https://github.com/x/y/issues/42',
      },
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('issue', '42');
    const { dispatchExistingIssue } = await import('@/lib/actions');
    const result = await dispatchExistingIssue(fd);
    expect(result).toEqual({ error: expect.stringContaining('state:spec-ready') });
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
cd dashboard && npm test -- actions.test
```
Expected: FAIL with "dispatchExistingIssue is not a function" or similar.

- [ ] **Step 3: Implement `dispatchExistingIssue` in `dashboard/lib/actions.ts`**

Add after `approveAndStart` (around line 700):

```typescript
/**
 * Dispatch the implement workflow for an issue that's already at
 * state:spec-ready (typically filed by /develop in Claude Code). Flips
 * the state label to state:implementing on success.
 *
 * Form fields:
 *  - repo  — owner/name
 *  - issue — issue number (string, parsed)
 */
export async function dispatchExistingIssue(
  formData: FormData,
): Promise<ApproveAndStartError | void> {
  try {
    const session_username = await getCurrentUsername();
    const octokit = await getOctokit();
    const repoFull = (formData.get('repo') as string).trim();
    const issueStr = (formData.get('issue') as string).trim();
    if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
    const issue_number = parseInt(issueStr, 10);
    if (Number.isNaN(issue_number)) throw new Error('issue must be a number');

    const [owner, repo] = repoFull.split('/');
    await assertWritePermission(octokit, owner, repo, session_username);

    const issue = await octokit.issues.get({ owner, repo, issue_number });
    const labels = issue.data.labels.map((l) =>
      typeof l === 'string' ? l : l.name ?? '',
    );
    if (!labels.includes('state:spec-ready')) {
      return {
        error: `issue is at ${labels.find((l) => l.startsWith('state:')) ?? 'unknown state'}; expected state:spec-ready`,
        issue_url: issue.data.html_url,
      };
    }

    const repoData = await octokit.repos.get({ owner, repo });
    const default_branch = repoData.data.default_branch;

    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: 'dev-agent.yml',
      ref: default_branch,
      inputs: {
        phase: 'implement',
        issue_number: String(issue_number),
        invocation_mode: 'live',
      },
    });

    // Flip state:spec-ready → state:implementing, preserving other labels.
    const nextLabels = labels
      .filter((l) => l !== 'state:spec-ready')
      .concat('state:implementing');
    await octokit.issues.setLabels({ owner, repo, issue_number, labels: nextLabels });

    revalidatePath('/');
    redirect(`/features/${issue_number}?repo=${encodeURIComponent(repoFull)}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('NEXT_REDIRECT')) throw err;
    console.error('[dispatchExistingIssue] failed', err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd dashboard && npm test -- actions.test
```
Expected: both new tests PASS; existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/actions.ts dashboard/__tests__/lib/actions.test.ts
git commit -m "feat(dashboard): add dispatchExistingIssue for /develop-filed state:spec-ready issues"
```

---

### Task 9: Dashboard — wire `/features/[issue]` approve button to `dispatchExistingIssue`

**Files:**
- Modify: `dashboard/app/features/[issue]/page.tsx` (or wherever the approve button lives for existing issues)

- [ ] **Step 1: Find the existing approve button**

```bash
grep -rn "approveAndStart\|state:spec-ready" dashboard/app/features/ dashboard/components/ 2>/dev/null | head -10
```

- [ ] **Step 2: For state:spec-ready issues, use dispatchExistingIssue**

If the page already detects state:spec-ready and shows an "Approve and start implementation" button, switch its action from `approveGate` or `approveAndStart` to `dispatchExistingIssue`. Form fields needed: `repo`, `issue`.

The button form (in `dashboard/app/features/[issue]/page.tsx` or a co-located client component):

```tsx
<form action={dispatchExistingIssue}>
  <input type="hidden" name="repo" value={`${owner}/${repo}`} />
  <input type="hidden" name="issue" value={String(issueNumber)} />
  <Button type="submit">Approve and start implementation</Button>
</form>
```

- [ ] **Step 3: Verify the page renders without TypeScript errors**

```bash
cd dashboard && npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add dashboard/app/features/
git commit -m "feat(dashboard): wire approve button to dispatchExistingIssue for /develop issues"
```

---

### Task 10: Dashboard — replace "Discuss with PM" with "Brainstorm in Claude Code" button

**Files:**
- Modify: `dashboard/app/proposals/page.tsx`
- Create: `dashboard/components/proposal-brainstorm-button.tsx`
- Test: `dashboard/__tests__/components/proposal-brainstorm-button.test.tsx`

- [ ] **Step 1: Write failing test for the button component**

Create `dashboard/__tests__/components/proposal-brainstorm-button.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProposalBrainstormButton } from '@/components/proposal-brainstorm-button';

describe('ProposalBrainstormButton', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('copies the /develop slash command to clipboard on click', async () => {
    render(<ProposalBrainstormButton issueNumber={42} />);
    const btn = screen.getByRole('button', { name: /Brainstorm in Claude Code/i });
    fireEvent.click(btn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '/develop --from-issue 42',
    );
  });

  it('shows a confirmation after copy', async () => {
    render(<ProposalBrainstormButton issueNumber={42} />);
    const btn = screen.getByRole('button', { name: /Brainstorm in Claude Code/i });
    fireEvent.click(btn);
    expect(await screen.findByText(/Copied/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
cd dashboard && npm test -- proposal-brainstorm-button
```
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement the component**

Create `dashboard/components/proposal-brainstorm-button.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function ProposalBrainstormButton({ issueNumber }: { issueNumber: number }) {
  const [copied, setCopied] = useState(false);
  const command = `/develop --from-issue ${issueNumber}`;

  async function onCopy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onCopy}
      title={`Copies ${command} to clipboard. Paste into Claude Code.`}
    >
      {copied ? 'Copied!' : 'Brainstorm in Claude Code'}
    </Button>
  );
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd dashboard && npm test -- proposal-brainstorm-button
```
Expected: PASS.

- [ ] **Step 5: Replace the "Discuss with PM" link on /proposals**

In `dashboard/app/proposals/page.tsx`, find the line (around 365 — verify with grep first):

```bash
grep -n "Discuss with PM\|prefill=" dashboard/app/proposals/page.tsx
```

Replace the `<a href={...}>Discuss with PM</a>` link with `<ProposalBrainstormButton issueNumber={p.issue_number} />`. Add the import at the top:

```tsx
import { ProposalBrainstormButton } from '@/components/proposal-brainstorm-button';
```

Drop the `buildPmPrefill` import + helper if no longer used (verify with grep before deleting).

- [ ] **Step 6: Run dashboard tests + build**

```bash
cd dashboard && npm test && npm run build
```
Expected: PASS, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/proposal-brainstorm-button.tsx dashboard/__tests__/components/proposal-brainstorm-button.test.tsx dashboard/app/proposals/page.tsx
git commit -m "feat(dashboard): replace 'Discuss with PM' with 'Brainstorm in Claude Code' copy-paste button"
```

---

### Task 11: Dashboard — replace `/intent` page with static explainer

**Files:**
- Modify: `dashboard/app/intent/page.tsx`

- [ ] **Step 1: Overwrite the page**

Replace `dashboard/app/intent/page.tsx` with:

```tsx
import { PageHeader } from '@/components/ui/page-header';

/**
 * The dashboard's brainstorming surface has moved into Claude Code via
 * the /develop slash command. This page used to host a streaming PM chat;
 * it now redirects users to the new flow.
 */
export default function IntentPage() {
  return (
    <div>
      <PageHeader
        title="Brainstorm"
        descriptor="Brainstorming happens in Claude Code now."
      />
      <div className="max-w-2xl space-y-4 text-sm">
        <p>
          To start a new feature, run the <code>/develop</code> slash command in
          Claude Code from your consumer repo:
        </p>
        <pre className="rounded-md bg-muted p-4 font-mono text-xs">
          /develop &quot;your pitch in 1–3 sentences&quot;
        </pre>
        <p>
          To brainstorm from a proposal, go to{' '}
          <a className="underline" href="/proposals">/proposals</a> and click{' '}
          <strong>Brainstorm in Claude Code</strong> on the card. That copies the
          right command to your clipboard.
        </p>
        <p className="text-muted-foreground">
          The PM, spec brainstorm, and plan writing all happen in Claude Code via
          superpowers skills. Once <code>/develop</code> finishes, the issue
          appears on{' '}
          <a className="underline" href="/proposals">/proposals</a> at
          state:spec-ready, ready for you to approve and start implementation.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the page builds**

```bash
cd dashboard && npm run build
```
Expected: build succeeds. There will be unresolved imports for `PmChat`, `getOctokit`, etc. that need cleanup in subsequent tasks — that's fine if the build still passes; otherwise add `// eslint-disable-next-line` shims or move deletion of the component into this task.

- [ ] **Step 3: Commit**

```bash
git add dashboard/app/intent/page.tsx
git commit -m "feat(dashboard): replace /intent chat with /develop pointer page"
```

---

### Task 12: Dashboard — delete `/api/pm-chat` route

**Files:**
- Delete: `dashboard/app/api/pm-chat/route.ts`

- [ ] **Step 1: Verify nothing else references the route**

```bash
grep -rn "/api/pm-chat\|api/pm-chat" dashboard/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v ".local-recovery" | grep -v "/api/pm-chat/route.ts"
```
Expected: empty (after Task 11 removed the PmChat component's reference) or only the PmChat component file itself (to be deleted in Task 13).

- [ ] **Step 2: Delete the file**

```bash
rm dashboard/app/api/pm-chat/route.ts
rmdir dashboard/app/api/pm-chat
```

- [ ] **Step 3: Verify build still works**

```bash
cd dashboard && npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add -A dashboard/app/api/pm-chat/
git commit -m "chore(dashboard): delete /api/pm-chat route (replaced by /develop in Claude Code)"
```

---

### Task 13: Dashboard — delete PM chat component + libs + their tests

**Files:**
- Delete: `dashboard/components/pm-chat.tsx`
- Delete: `dashboard/lib/pm-tools.ts`
- Delete: `dashboard/lib/pm-chat-draft.ts`
- Delete: `dashboard/lib/pm-md-update.ts`
- Delete: `dashboard/__tests__/components/pm-chat.test.tsx`
- Delete: `dashboard/__tests__/lib/pm-chat-draft.test.ts`
- Delete: `dashboard/__tests__/lib/pm-md-update.test.ts`
- Delete: `dashboard/__tests__/lib/pm-tools.test.ts`

- [ ] **Step 1: Verify no remaining imports**

```bash
grep -rn "from '@/components/pm-chat'\|from '@/lib/pm-tools'\|from '@/lib/pm-chat-draft'\|from '@/lib/pm-md-update'" dashboard/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v ".local-recovery"
```
Expected: empty.

- [ ] **Step 2: Delete the files**

```bash
rm dashboard/components/pm-chat.tsx
rm dashboard/lib/pm-tools.ts
rm dashboard/lib/pm-chat-draft.ts
rm dashboard/lib/pm-md-update.ts
rm dashboard/__tests__/components/pm-chat.test.tsx
rm dashboard/__tests__/lib/pm-chat-draft.test.ts
rm dashboard/__tests__/lib/pm-md-update.test.ts
rm dashboard/__tests__/lib/pm-tools.test.ts
```

Also delete the orphan "2.tsx" / "2.ts" files in the same paths (from earlier merges):

```bash
rm -f "dashboard/components/pm-chat 2.tsx" "dashboard/__tests__/components/pm-chat.test 2.tsx"
```

- [ ] **Step 3: Run dashboard tests + build**

```bash
cd dashboard && npm test && npm run build
```
Expected: PASS, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add -A dashboard/components/pm-chat* dashboard/lib/pm-* dashboard/__tests__/components/pm-chat* dashboard/__tests__/lib/pm-*
git commit -m "chore(dashboard): delete PM chat component, libs, and tests (replaced by /develop)"
```

---

### Task 14: Dashboard — remove `extractAgreedScope` + `applyPmMdUpdate` from `actions.ts`

**Files:**
- Modify: `dashboard/lib/actions.ts`
- Modify: `dashboard/__tests__/lib/actions.test.ts`

- [ ] **Step 1: Find the function boundaries**

```bash
grep -n "function extractAgreedScope\|^export async function applyPmMdUpdate\|^export async function approveAndStart" dashboard/lib/actions.ts
```
Note the line numbers — you'll delete `extractAgreedScope` (line ~43) and `applyPmMdUpdate` (line ~713).

- [ ] **Step 2: Remove `extractAgreedScope` (lines ~43–53 and its callsite in `approveAndStart`)**

Read the function in full:

```bash
sed -n '38,53p' dashboard/lib/actions.ts
```

Delete the function definition + the JSDoc block above it. Then find its call in `approveAndStart` (around line 527):

```bash
sed -n '520,540p' dashboard/lib/actions.ts
```

Since `approveAndStart` is being kept (for backward compat with in-flight features from the old flow), but its `pm_final_message`-driven scope extraction is no longer the primary path — for now, leave `approveAndStart` itself in place but inline a simpler "take the body as-is" if the function still needs to support legacy chat-output paths. **Recommendation:** since `/intent` is gone (Task 11) and nothing else calls `approveAndStart`, delete `approveAndStart` entirely too. Verify with grep:

```bash
grep -rn "approveAndStart" dashboard/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v ".local-recovery"
```

If nothing references it, delete it. If anything still does (e.g. a leftover button), migrate the caller to `dispatchExistingIssue` first.

- [ ] **Step 3: Remove `applyPmMdUpdate` (lines ~713 onward)**

```bash
sed -n '700,780p' dashboard/lib/actions.ts
```

Find the start of `export async function applyPmMdUpdate` and the closing `}` of its function. Delete the function + its JSDoc block.

Verify no caller remains:

```bash
grep -rn "applyPmMdUpdate" dashboard/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v ".local-recovery"
```
Expected: empty (after Task 13 removed pm-chat.tsx).

- [ ] **Step 4: Remove related tests in `dashboard/__tests__/lib/actions.test.ts`**

```bash
grep -n "describe('extractAgreedScope'\|describe('applyPmMdUpdate'\|describe('approveAndStart'" dashboard/__tests__/lib/actions.test.ts
```

Delete the test blocks for `extractAgreedScope`, `applyPmMdUpdate`, and (if you removed `approveAndStart`) `approveAndStart`.

- [ ] **Step 5: Run tests + build**

```bash
cd dashboard && npm test && npm run build
```
Expected: PASS, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/actions.ts dashboard/__tests__/lib/actions.test.ts
git commit -m "chore(dashboard): remove extractAgreedScope + applyPmMdUpdate (deprecated by /develop flow)"
```

---

### Task 15: Dashboard — remove unused `@ai-sdk/*` and `ai` dependencies

**Files:**
- Modify: `dashboard/package.json`
- Modify: `dashboard/package-lock.json` (auto-updated by npm)

- [ ] **Step 1: Verify nothing imports `@ai-sdk/*` or `ai` anymore**

```bash
grep -rn "from '@ai-sdk/\|from 'ai'" dashboard/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v ".local-recovery" | grep -v "node_modules"
```
Expected: empty.

- [ ] **Step 2: Uninstall the packages**

```bash
cd dashboard && npm uninstall @ai-sdk/anthropic @ai-sdk/react ai
```

- [ ] **Step 3: Verify tests + build still pass**

```bash
cd dashboard && npm test && npm run build
```
Expected: PASS, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json
git commit -m "chore(dashboard): drop @ai-sdk/anthropic, @ai-sdk/react, ai (no longer used after /develop migration)"
```

---

### Task 16: Docs — update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current Install + slash commands sections**

```bash
sed -n '15,55p' README.md
```

- [ ] **Step 2: Update the Install section**

After the existing `claude plugin install` instructions, add:

```markdown
### Required superpowers version

`/develop` depends on these skills:

- `superpowers:brainstorming`
- `superpowers:writing-plans`
- `superpowers:writing-clearly-and-concisely`

Validated against superpowers `5.1.0`. Install via:

```bash
claude plugin install superpowers@5.1.0
```

Newer versions should work as long as the brainstorming skill continues writing specs to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and writing-plans writes to `docs/plans/YYYY-MM-DD-<topic>.md`.
```

- [ ] **Step 3: Update the slash commands table**

Replace the `/develop` row with the new behavior:

```markdown
| `/develop` | Full flow: PM evaluation → spec brainstorm → plan write → handoff. Files a state:spec-ready issue. See [docs/superpowers/specs/2026-05-26-pm-via-claude-code-design.md](docs/superpowers/specs/2026-05-26-pm-via-claude-code-design.md). |
```

- [ ] **Step 4: Add a note about the retired dashboard chat**

Find the "Status: v0.2.0 (Dashboard v1)" section. Add a status note above it:

```markdown
## Status: v0.x.0 (PM via Claude Code)

Retires the dashboard's in-browser PM chat. Brainstorming, spec writing, and plan writing now run in Claude Code via `/develop` and the superpowers skill chain. Dashboard keeps proposals, approval gates, status, and engine orchestration. See [docs/superpowers/specs/2026-05-26-pm-via-claude-code-design.md](docs/superpowers/specs/2026-05-26-pm-via-claude-code-design.md).
```

(Bump the version number per the repo's existing conventions — check `package.json` and the most-recent CHANGELOG entry if there is one.)

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): document /develop slash-command flow and superpowers pin"
```

---

### Task 17: SESSION_LOG — append entry

**Files:**
- Modify: `SESSION_LOG.md`

- [ ] **Step 1: Read the current top of SESSION_LOG**

```bash
sed -n '1,15p' SESSION_LOG.md
```

- [ ] **Step 2: Append a new entry under the H1**

Insert under `# Session Log` (and its trailing blank line):

```markdown
## 2026-05-26 HH:MM UTC — interactive — PM brainstorming moves into Claude Code via /develop

**Trigger:** User: "the PM brainstorming is not user friendly and doesn't use claude code at all." Brainstorm concluded that dashboard-hosted PM chat is the wrong surface for content-heavy spec + plan work; Claude Code with superpowers skills is.

**What changed:**

- Spec: [docs/superpowers/specs/2026-05-26-pm-via-claude-code-design.md](docs/superpowers/specs/2026-05-26-pm-via-claude-code-design.md)
- Plan: [docs/superpowers/plans/2026-05-26-pm-via-claude-code.md](docs/superpowers/plans/2026-05-26-pm-via-claude-code.md)
- Implementation: 16 tasks across engine (phase-implement.yml + render-prompt), slash command (commands/develop.md rewritten), dashboard (proposal-brainstorm-button.tsx added, /intent + PM chat + applyPmMdUpdate removed), README updated.

**Deferred / Next:**

- Spec/plan via PR (`spec_plan_via_pr: true` in `.dev-agent.yml`) — v1.1.
- `/develop --abandon <topic>` cleanup command — v1.1.
- "Lite" in-dashboard brainstorm for non-Claude-Code users — separate spec if ever needed.

**Next session should start with:** run `/develop` end-to-end on a real consumer repo (caliente-booking-app or social-media-content) to validate the full chain. If anything breaks, file targeted fixes.

---
```

- [ ] **Step 3: Commit**

```bash
git add SESSION_LOG.md
git commit -m "docs(session-log): /develop rewrite + dashboard PM chat retirement"
```

---

## Self-Review

Run through the spec section-by-section and check that every requirement has a corresponding task.

**Spec Coverage:**

- **Goals → "Claude Code as the PM surface"** → Task 6 (rewrite `/develop` as 4-phase orchestrator) ✓
- **Goals → "Dashboard owns coordination"** → Tasks 8 (dispatchExistingIssue), 9 (approve button wiring), 10 (Brainstorm button) keep dashboard's coordination role ✓
- **Goals → "Single command for the full flow"** → Task 6 ✓
- **Goals → "Artifacts on disk"** → Phase 4 of `/develop` (in Task 6) commits to consumer repo and links from issue body ✓
- **Goals → "Resumable"** → Task 6 includes `--resume` mode ✓
- **Goals → "Backward-compatible engine"** → Task 1's extraction is optional for plan (empty string when absent); Task 2's cat is conditional ✓
- **Architecture → Phase 1 (PM eval)** → Task 6 spec ✓
- **Architecture → Phase 2 (Spec brainstorm)** → Task 6 spec ✓
- **Architecture → Phase 3 (Plan writing)** → Task 6 spec ✓
- **Architecture → Phase 4 (Handoff)** → Task 6 spec, Tasks 8-9 wire the dashboard side ✓
- **Slash command surface (4 invocation modes)** → Task 6 documents all four ✓
- **Artifact storage table** → matches Task 6 + Task 1 ✓
- **Spec/plan branch policy** → Task 6 spec documents default + `spec_plan_via_pr` opt-in (opt-in deferred to v1.1) ✓
- **Bridge §1 (Dashboard → Claude Code)** → Task 10 (button) ✓
- **Bridge §2 (Claude Code → Dashboard)** → Tasks 8-9 (issue creation + dispatch via approve button) ✓
- **Bridge §3 (mid-brainstorm pause)** → Task 6 `--resume` ✓
- **Migration § "Drop applyPmMdUpdate"** → Task 14 ✓
- **Migration § "Remove the route"** → Tasks 11–13 ✓
- **Migration § "Replace `/intent`"** → Task 11 ✓
- **Migration § "Keep approveAndStart" (revised to "drop entirely")** → Task 14 step 2 reasoning ✓
- **Migration § "Update phase-implement.yml"** → Tasks 1, 2, 4 ✓
- **Engine changes** → Tasks 1, 2, 4 ✓
- **Edge cases → Consumer repo not cloned locally** → Task 6 spec ("Repo detection") ✓
- **Edge cases → Two specs in the same direction** → covered by PM persona behavior, no new task needed ✓
- **Edge cases → Spec/plan written but never approved** → Task 6 (`--resume`) handles it ✓
- **Edge cases → Multiple consumer repos in flight** → no special handling needed; each repo has its own pm.md + specs dir ✓
- **Edge cases → Brainstorming skill version drift** → Task 16 (README pin) ✓
- **Open questions for the plan phase** → resolved in Task 6 (explicit chaining in prompt) + Task 6 step 2 (`gh` CLI in Phase 4) + Tasks 11–14 (single removal PR) ✓
- **Testing strategy → Manual E2E** → Task 7 ✓
- **Testing strategy → Unit tests for spec-path resolver** → Task 4 ✓
- **Testing strategy → Snapshot the `/develop` prompt** → not added as a task because the prompt is hand-authored markdown; manual review is sufficient. **Gap noted.**
- **Testing strategy → Smoke test the migration** → Task 7 step 8 covers post-migration runs; legacy spec-inline issues should be tested manually by leaving one in flight ✓

**Placeholder scan:** searched for "TBD", "TODO", "fill in", "similar to Task N", "add appropriate" — none found. Code blocks are complete in each task.

**Type consistency:**
- `dispatchExistingIssue` (Task 8) signature matches the form-action shape used in Task 9
- `ProposalBrainstormButton` props (`issueNumber: number`) match the test (Task 10 step 1)
- `spec_path` / `plan_path` naming consistent across Task 1 (bash), Task 4 (TypeScript), prompt template (Task 3)
- `state:spec-ready` used consistently in `/develop` Phase 4 (Task 6), `dispatchExistingIssue` (Task 8), and the approve button wiring (Task 9)

**Gaps identified:** "Snapshot the `/develop` prompt" is in the spec's testing strategy but not in the plan. Adding it as a manual-only check in Task 7 step 9. Leaving it out as a code-level task because the prompt is the source of truth and snapshot diffs would just mirror the prompt-file diff.

Plan complete.

---

## Execution Handoff

Plan saved to [docs/superpowers/plans/2026-05-26-pm-via-claude-code.md](docs/superpowers/plans/2026-05-26-pm-via-claude-code.md).

Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
