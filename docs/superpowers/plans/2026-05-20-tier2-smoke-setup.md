# tier2-smoke Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-built `phase-tier2-smoke.yml` engine workflow into dev-agent's pipeline so the Smoke (Pillar 7) gate runs automatically on every feature reaching staging.

**Architecture:** Add a consumer wrapper (`dev-agent-tier2-smoke.yml`) that triggers on the existing `state:staging-deployed` label, resolves `staging_url` from Vercel's PR comment and `pr_number`/`spec_path` from the issue context, flips the issue to `state:tier2-smoke`, and calls the reusable workflow. Ship via the established wire-up template + one-click backfill installer. No engine change required.

**Tech Stack:** GitHub Actions YAML, TypeScript (orchestrator + dashboard), Vitest, the `installWorkflow` server action from PR #86, Vercel preview deployments.

---

## File summary

| File | Task | Responsibility |
|---|---|---|
| `examples/web-app-template/.github/workflows/dev-agent-tier2-smoke.yml` | 1 | new — consumer wrapper |
| `tests/unit/web-app-template.test.ts` | 1 | new `it()` asserting wrapper shape (workflow_call pin, permissions) |
| `dashboard/lib/wire-up-template.ts` | 2 | embed `TEMPLATE_TIER2_SMOKE_WORKFLOW_YML`; add to `WIRE_UP_FILES` + `INSTALLABLE_WORKFLOWS` |
| `tests/unit/wire-up-template-drift.test.ts` | 2 | new drift `it()` for the new template |
| `dashboard/__tests__/lib/actions.test.ts` | 2 | extend `installWorkflow` tests for the `tier2-smoke` key |
| `lib/orchestrator.ts` | 3 | new `workflow-tier2-fire` `TransitionTrigger` + entry transition |
| `__tests__/orchestrator.test.ts` (or equivalent — find via grep) | 3 | assert the new transition validates |
| `dashboard/__tests__/lib/dashboard/repo-workspace.test.ts` | 2 | (no change — `smoke_p7` check already correct, but exercised via PR #91's universal-pillars test once tier2-smoke.yml is present) |
| `docs/runbooks/2026-05-20-tier2-smoke-rollout.md` | 4 | new — canary procedure, override paths |

---

## Task 1: Consumer wrapper `dev-agent-tier2-smoke.yml`

**Files:**
- Create: `examples/web-app-template/.github/workflows/dev-agent-tier2-smoke.yml`
- Modify: `tests/unit/web-app-template.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/web-app-template.test.ts`, after the existing verification-wrapper tests, append:

```typescript
  it('tier2-smoke wrapper exists, pins reusable to v1, declares the right permissions', () => {
    const path = resolve(templateRoot, '.github/workflows/dev-agent-tier2-smoke.yml');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    const parsed = yaml.load(raw) as {
      permissions?: Record<string, string>;
      on?: { issues?: { types: string[] }; workflow_dispatch?: unknown };
      jobs: Record<string, { uses?: string; if?: string }>;
    };
    // Permissions must cover what the reusable's job requests
    // (contents: read, issues: write, id-token: write).
    expect(parsed.permissions?.contents).toBe('read');
    expect(parsed.permissions?.issues).toBe('write');
    expect(parsed.permissions?.['id-token']).toBe('write');
    // Triggers: issues.labeled (auto) + workflow_dispatch (manual re-run).
    expect(parsed.on?.issues?.types).toContain('labeled');
    expect(parsed.on?.workflow_dispatch).toBeDefined();
    // Wrapper jobs: the resolve step is a plain run step (no `uses`), and
    // the smoke job calls the reusable pinned to v1.
    const jobs = Object.values(parsed.jobs);
    const reusableJobs = jobs.filter((j) => j.uses !== undefined);
    expect(reusableJobs.length).toBe(1);
    expect(reusableJobs[0].uses).toMatch(
      /^alizaouane\/dev-agent\/\.github\/workflows\/phase-tier2-smoke\.yml@v\d+/,
    );
    // The dispatching job has a same-repo + state:staging-deployed + kind:user-intent guard.
    const dispatchJob = jobs.find((j) => j.uses);
    expect(dispatchJob?.if ?? '').toMatch(/state:staging-deployed/);
    expect(dispatchJob?.if ?? '').toMatch(/kind:user-intent/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/web-app-template.test.ts -t "tier2-smoke wrapper"`
Expected: FAIL — the file does not exist.

- [ ] **Step 3: Create the consumer wrapper**

Create `examples/web-app-template/.github/workflows/dev-agent-tier2-smoke.yml`:

```yaml
name: dev-agent · tier2-smoke

# Auto-runs Tier-2 smoke (Pillar 7) on a dev-agent feature once it has
# reached state:staging-deployed. The reusable phase-tier2-smoke.yml has
# a Claude sub-agent author a Playwright probe from the spec's acceptance
# criteria, runs it against the staging URL, and emits the verdict +
# state transition.
#
# Trigger: issues.labeled where the added label is exactly
# state:staging-deployed AND the issue carries kind:user-intent. Also
# allows manual re-run via workflow_dispatch with explicit inputs.
#
# Inputs are resolved from the issue context inside this wrapper:
#  - pr_number    — from the implement-phase telemetry comment's `PR: #N`
#                   line, with `gh pr list --head feat/dev-agent-issue-<N>`
#                   as a fallback.
#  - staging_url  — from Vercel's preview-deployment comment on the PR
#                   (Vercel posts a `https://*.vercel.app` URL when the
#                   preview is ready). Assumes the consumer uses Vercel
#                   for staging (the default in .dev-agent.yml).
#  - spec_path    — from the issue body's spec link if present; if absent
#                   the wrapper posts a "no spec linked, skipping smoke"
#                   comment and exits (rather than calling the reusable
#                   with empty inputs, which would 422 on its required
#                   spec_path input).
#
# Failure paths: missing PR, missing Vercel URL, or missing spec each
# post a single explanatory issue comment + exit 0 (the gate is
# advisory-skip on missing-input — see runbook). A failed probe routes
# the issue to state:blocked via the reusable's exit transition.
#
# Granted at the workflow level so the called reusable workflow can
# request these for its own job — same pattern as the scout workflows.
# Without this block the caller inherits the repo's default GITHUB_TOKEN
# scopes; if those are read-only the called job fails at startup ("but is
# only allowed issues: none, ...").

on:
  issues:
    types: [labeled]
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to re-run smoke for'
        required: true
        type: number

permissions:
  contents: read
  issues: write
  id-token: write

jobs:
  tier2-smoke:
    if: |
      github.event_name == 'workflow_dispatch' ||
      (github.event.label.name == 'state:staging-deployed' &&
       contains(github.event.issue.labels.*.name, 'kind:user-intent'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      issues: write
      id-token: write
    outputs:
      ready: ${{ steps.resolve.outputs.ready }}
      issue_number: ${{ steps.resolve.outputs.issue_number }}
      pr_number: ${{ steps.resolve.outputs.pr_number }}
      staging_url: ${{ steps.resolve.outputs.staging_url }}
      spec_path: ${{ steps.resolve.outputs.spec_path }}
    steps:
      - name: Resolve smoke inputs from issue context
        id: resolve
        env:
          # Untrusted GitHub event values flow through env vars (never
          # interpolated into run: blocks) — same security pattern as
          # dev-agent-verification.yml.
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          ISSUE_FROM_EVENT: ${{ github.event.issue.number }}
          ISSUE_FROM_DISPATCH: ${{ github.event.inputs.issue_number }}
        run: |
          set -euo pipefail

          ISSUE="${ISSUE_FROM_EVENT:-$ISSUE_FROM_DISPATCH}"
          if [ -z "$ISSUE" ]; then
            echo "::error::no issue number resolved (neither labeled event nor workflow_dispatch input)"
            exit 1
          fi
          echo "issue_number=$ISSUE" >> "$GITHUB_OUTPUT"

          # --- pr_number ---
          # The implement-phase success telemetry comment carries a line
          # like `PR: #123`. Read the issue's comments newest-first and
          # extract the first match. Fallback: gh pr list against the
          # standard dev-agent feature branch name.
          PR=""
          PR_FROM_COMMENT=$(gh issue view "$ISSUE" --repo "$REPO" --json comments \
            --jq '.comments | reverse | .[] | .body' 2>/dev/null \
            | grep -oE 'PR: #[0-9]+' | head -1 | sed 's/PR: #//' || true)
          if [ -n "$PR_FROM_COMMENT" ]; then
            PR="$PR_FROM_COMMENT"
          else
            PR=$(gh pr list --repo "$REPO" --head "feat/dev-agent-issue-${ISSUE}" \
              --json number --jq '.[0].number // empty' 2>/dev/null || true)
          fi
          if [ -z "$PR" ]; then
            BODY=$'🤖 Phase: tier2-smoke\nVerdict: skipped\n\nCould not resolve a PR number for this feature (no `PR: #N` line in implement telemetry and no `feat/dev-agent-issue-'"$ISSUE"$'` branch). Open the PR or re-run the implement phase before re-triggering smoke.'
            gh issue comment "$ISSUE" --repo "$REPO" --body "$BODY" || true
            echo "ready=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "pr_number=$PR" >> "$GITHUB_OUTPUT"

          # --- staging_url ---
          # Vercel posts a comment on the PR with the preview URL. Match
          # the first https://*.vercel.app URL in the most recent vercel[bot]
          # comment. Tolerant of trailing punctuation and markdown.
          STAGING_URL=$(gh pr view "$PR" --repo "$REPO" --json comments \
            --jq '.comments | reverse | .[] | select(.author.login == "vercel[bot]" or .author.login == "vercel") | .body' 2>/dev/null \
            | grep -oE 'https://[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app' \
            | head -1 || true)
          if [ -z "$STAGING_URL" ]; then
            BODY=$'🤖 Phase: tier2-smoke\nVerdict: skipped\n\nCould not find a Vercel preview URL on PR #'"$PR"$' (no `vercel[bot]` comment matching `https://*.vercel.app`). dev-agent'\''s tier2-smoke wrapper currently assumes a Vercel staging deploy. If you use a different deploy stack, customize `dev-agent-tier2-smoke.yml` in your repo to derive the URL.'
            gh issue comment "$ISSUE" --repo "$REPO" --body "$BODY" || true
            echo "ready=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "staging_url=$STAGING_URL" >> "$GITHUB_OUTPUT"

          # --- spec_path ---
          # Extract the spec link from the issue body. Convention: the body
          # carries a `docs/specs/<slug>.md` reference (markdown link or bare
          # path). If none found, the reusable workflow requires spec_path,
          # so we skip with a clear error rather than fire with empty input.
          SPEC=$(gh issue view "$ISSUE" --repo "$REPO" --json body --jq '.body' 2>/dev/null \
            | grep -oE 'docs/specs/[a-zA-Z0-9._/-]+\.md' | head -1 || true)
          if [ -z "$SPEC" ]; then
            BODY=$'🤖 Phase: tier2-smoke\nVerdict: skipped\n\nCould not find a `docs/specs/*.md` reference in the issue body. tier2-smoke needs the spec to author the Playwright probe. Add the spec link to the issue body and re-trigger by removing and re-adding the `state:staging-deployed` label.'
            gh issue comment "$ISSUE" --repo "$REPO" --body "$BODY" || true
            echo "ready=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "spec_path=$SPEC" >> "$GITHUB_OUTPUT"

          # --- Flip state to `state:tier2-smoke` so the dashboard reflects
          # "smoke in flight" rather than "staging deployed, idle". The
          # reusable workflow flips it again at its terminal state. ---
          gh issue edit "$ISSUE" --repo "$REPO" \
            --remove-label state:staging-deployed \
            --add-label state:tier2-smoke || true

          echo "ready=true" >> "$GITHUB_OUTPUT"

  smoke-call:
    needs: tier2-smoke
    if: needs.tier2-smoke.outputs.ready == 'true'
    uses: alizaouane/dev-agent/.github/workflows/phase-tier2-smoke.yml@v1
    with:
      issue_number: ${{ fromJSON(needs.tier2-smoke.outputs.issue_number) }}
      pr_number: ${{ fromJSON(needs.tier2-smoke.outputs.pr_number) }}
      staging_url: ${{ needs.tier2-smoke.outputs.staging_url }}
      spec_path: ${{ needs.tier2-smoke.outputs.spec_path }}
      invocation_mode: live
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Note on the `tier2-smoke` job's name vs the spec's wording: the spec named the single job `tier2-smoke` but the reusable-workflow call has to be its own job (a job that `uses:` cannot also have `runs-on`/`steps`). Splitting into two jobs (`tier2-smoke` resolves inputs, `smoke-call` calls the reusable) is the standard GitHub Actions pattern; the test from Step 1 still passes (exactly one reusable-call job pinned to v1).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/web-app-template.test.ts -t "tier2-smoke wrapper"`
Expected: PASS.

- [ ] **Step 5: YAML validity sanity check**

Run: `python3 -c "import yaml; d=yaml.safe_load(open('examples/web-app-template/.github/workflows/dev-agent-tier2-smoke.yml')); print(list(d['jobs'].keys()))"`
Expected: prints `['tier2-smoke', 'smoke-call']` with no parse error.

- [ ] **Step 6: Commit**

```bash
git add examples/web-app-template/.github/workflows/dev-agent-tier2-smoke.yml tests/unit/web-app-template.test.ts
git commit -m "feat(verification): add tier2-smoke consumer wrapper"
```

---

## Task 2: Distribution — wire-up template + INSTALLABLE_WORKFLOWS

**Files:**
- Modify: `dashboard/lib/wire-up-template.ts`
- Modify: `tests/unit/wire-up-template-drift.test.ts`
- Modify: `dashboard/__tests__/lib/actions.test.ts`

- [ ] **Step 1: Write the failing drift test**

In `tests/unit/wire-up-template-drift.test.ts`, append a new `it()` inside the `describe('wire-up-template embedded copy', ...)` block, after the verification workflow drift check:

```typescript
  it('tier2-smoke workflow on disk matches the embedded TEMPLATE_TIER2_SMOKE_WORKFLOW_YML', () => {
    const onDisk = readFileSync(
      resolve(tplDir, '.github/workflows/dev-agent-tier2-smoke.yml'),
      'utf8',
    );
    const normalized = embedded
      .replace(/\\\$\{\{/g, '${{')
      .replace(/\\`/g, '`')
      .replace(/\\\$/g, '$');
    expect(normalized).toContain(onDisk);
  });
```

- [ ] **Step 2: Write the failing actions test**

In `dashboard/__tests__/lib/actions.test.ts`, find the existing `describe('installWorkflow', ...)` block. Add this test alongside the existing `bug-scout` / `verification` cases:

```typescript
  it('commits the tier2-smoke workflow file when missing', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'tier2-smoke');
    await expect(installWorkflow(fd)).resolves.toBeUndefined();

    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '.github/workflows/dev-agent-tier2-smoke.yml',
      }),
    );
  });
```

Also extend the existing `'targets the correct path for each workflow key'` test's `cases` array (find it in the same describe block) with this entry:

```typescript
      ['tier2-smoke', '.github/workflows/dev-agent-tier2-smoke.yml'],
```

- [ ] **Step 3: Run both tests to verify they fail**

Run:
```
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/wire-up-template-drift.test.ts -t "tier2-smoke"
cd "$(git rev-parse --show-toplevel)/dashboard" && npx vitest run __tests__/lib/actions.test.ts -t "tier2-smoke"
```
Expected: both FAIL — the embedded constant doesn't exist; `tier2-smoke` is not a valid `WorkflowKey`.

- [ ] **Step 4: Embed the workflow + extend the maps**

In `dashboard/lib/wire-up-template.ts`, add a new `TEMPLATE_TIER2_SMOKE_WORKFLOW_YML` constant after the existing `TEMPLATE_VERIFICATION_WORKFLOW_YML` constant. Its value is the EXACT current content of `examples/web-app-template/.github/workflows/dev-agent-tier2-smoke.yml` from Task 1, embedded as a TypeScript template literal with the same two escapes the sibling `TEMPLATE_*_WORKFLOW_YML` constants use:
- every `${` becomes `\${`
- every backtick becomes `` \` ``

(Use the same escaping pattern as `TEMPLATE_VERIFICATION_WORKFLOW_YML` from PR #88 — verify by reading that constant first.)

Then add the file to `WIRE_UP_FILES`, immediately after the verification entry:

```typescript
  {
    path: '.github/workflows/dev-agent-tier2-smoke.yml',
    content: TEMPLATE_TIER2_SMOKE_WORKFLOW_YML,
  },
```

And extend `INSTALLABLE_WORKFLOWS`, immediately after the `verification` entry:

```typescript
  'tier2-smoke': {
    path: '.github/workflows/dev-agent-tier2-smoke.yml',
    content: TEMPLATE_TIER2_SMOKE_WORKFLOW_YML,
    label: 'Tier-2 smoke (Pillar 7)',
  },
```

Update the JSDoc above `WIRE_UP_FILES` to mention the new file briefly, and the JSDoc above `INSTALLABLE_WORKFLOWS` (which currently says "Installable workflows that older wire-ups may be missing") — that wording already covers it; no change required unless it needs the new label called out.

- [ ] **Step 5: Update `wireUpRepo`'s test assertion counts**

The `wireUpRepo` describe block in `dashboard/__tests__/lib/actions.test.ts` has assertions like `expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(8)` (the verification workflow brought this to 8 in PR #88). With tier2-smoke added, it's 9. Update every `toHaveBeenCalledTimes(8)` inside the `describe('wireUpRepo', ...)` block (and any `applyPmMdUpdate` block that also exercises `wireUpRepo`) to `9`.

- [ ] **Step 6: Run all the affected tests to verify pass**

Run:
```
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/wire-up-template-drift.test.ts
cd "$(git rev-parse --show-toplevel)/dashboard" && npx vitest run __tests__/lib/actions.test.ts
cd "$(git rev-parse --show-toplevel)/dashboard" && npx tsc --noEmit
```
Expected: drift suite all green (9 tests now), actions suite all green, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/wire-up-template.ts tests/unit/wire-up-template-drift.test.ts dashboard/__tests__/lib/actions.test.ts
git commit -m "feat(dashboard): ship dev-agent-tier2-smoke.yml via wire-up + installer"
```

---

## Task 3: Orchestrator — new entry transition

**Files:**
- Modify: `lib/orchestrator.ts`
- Modify: `tests/unit/orchestrator.test.ts` (verify path by `find ./tests -name 'orchestrator.test.*'` first — adjust if needed)

- [ ] **Step 1: Confirm the orchestrator test file**

Run: `find tests -name 'orchestrator.test.*' -o -name 'orchestrator.spec.*' 2>/dev/null`
Expected: one path printed. Use that path in Step 2.

If no test file is found, create `tests/unit/orchestrator.test.ts` with a minimal vitest harness that imports the orchestrator and runs the validateTransition function — the codebase's test conventions are documented in `tests/unit/web-app-template.test.ts` for reference.

- [ ] **Step 2: Write the failing transition test**

In the orchestrator test file, append:

```typescript
import { describe, it, expect } from 'vitest';
import { validateTransition } from '../../lib/orchestrator';

describe('orchestrator: tier2-smoke entry transition', () => {
  it('routes state:staging-deployed -> state:tier2-smoke via workflow-tier2-fire', () => {
    const result = validateTransition('state:staging-deployed', 'workflow-tier2-fire');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe('state:tier2-smoke');
      expect(result.fires).toBe('dev-agent-tier2-smoke.yml');
    }
  });
});
```

(If a `describe('orchestrator', ...)` block already exists in the file, append the `it()` inside it rather than adding a new describe.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run <orchestrator-test-path>`
Expected: FAIL — `workflow-tier2-fire` is not a valid `TransitionTrigger`, OR no row matches.

- [ ] **Step 4: Add the trigger value + transition row**

In `lib/orchestrator.ts`, extend the `TransitionTrigger` union by adding `'workflow-tier2-fire'` to the list. Place it next to `'workflow-pr-open'` for symmetry:

```typescript
export type TransitionTrigger =
  | '/proposals-accept'
  | '/develop-auto'
  | '/approve'
  | 'workflow-pr-open'
  | 'workflow-tier2-fire'
  | 'smoke-pass-staging'
  | '/approve --promote'
  | 'smoke-pass-prod'
  | '/abandon'
  | '/rollback-complete'
  | 'phase-failure'
  | 'acm-pass'
  | 'acm-fail'
  | 'swarm-pass'
  | 'swarm-fail'
  | 'human-override'
  | 'tier2-pass'
  | 'tier2-fail';
```

Then add the entry row in `TRANSITION_TABLE`. Place it immediately before the two existing `state:tier2-smoke` exit rows (so the entry/exit rows for that state are grouped):

```typescript
  { from: 'state:staging-deployed',  trigger: 'workflow-tier2-fire', to: 'state:tier2-smoke',      fires: 'dev-agent-tier2-smoke.yml' },
  { from: 'state:tier2-smoke',       trigger: 'tier2-pass',         to: 'state:ready-to-promote' },
  { from: 'state:tier2-smoke',       trigger: 'tier2-fail',         to: 'state:blocked' },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run <orchestrator-test-path>`
Expected: PASS — the new transition row is reachable and `fires` is set.

- [ ] **Step 6: Commit**

```bash
git add lib/orchestrator.ts <orchestrator-test-path>
git commit -m "feat(orchestrator): workflow-tier2-fire entry transition into state:tier2-smoke"
```

---

## Task 4: Enforcement + canary runbook

**Files:**
- Create: `docs/runbooks/2026-05-20-tier2-smoke-rollout.md`
- Modify: `README.md` (one-line link, matching how the swarm-review runbook is linked)

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/2026-05-20-tier2-smoke-rollout.md` with these sections, each fully written out (no placeholders — write real prose):

- **What tier2-smoke is** — One paragraph. Reusable workflow `phase-tier2-smoke.yml` has a Claude sub-agent author a Playwright probe from the spec's acceptance criteria, runs it against the deployed staging URL, and emits a `tier2-pass` / `tier2-fail` verdict that drives the orchestrator from `state:tier2-smoke` to `state:ready-to-promote` or `state:blocked`. The consumer wrapper `dev-agent-tier2-smoke.yml` auto-triggers on the `state:staging-deployed` label, resolves the PR number / Vercel preview URL / spec path, flips the issue to `state:tier2-smoke`, and calls the reusable.
- **Canary phase** — Install the wrapper on ONE repo first. Suggested: `caliente-booking-app` (highest feature throughput today). Watch the next ~5 features. For each, record:
  - The `tier2-pass` / `tier2-fail` verdict the wrapper applied.
  - The actual outcome of the deploy: was the code fine (false-positive smoke) or did the smoke catch a real regression (true-positive)?
  - Whether the staging-URL resolution worked (it depends on Vercel's PR comment).
  Goal: < 1 in 10 false positives before enabling on other repos. If false positives are noisy, fix the wrapper's spec-extraction or the probe generator rather than disabling the gate.
- **Enabling on more repos** — Once the canary is acceptable, install on the rest via the dashboard's "Tier-2 smoke" install button on each repo's workspace page (the same one-click pattern used for the verification workflow). The wrapper is also part of fresh wire-ups going forward.
- **Failure recovery** — When a smoke run fails and the issue lands in `state:blocked`:
  1. **Re-run.** Remove the `state:tier2-smoke` label (or any current label) and re-add `state:staging-deployed` — the wrapper re-fires. Or `gh workflow run dev-agent-tier2-smoke.yml -f issue_number=<N>`.
  2. **Admin-merge.** If the smoke verdict is wrong and the operator accepts the risk, admin-merge the promote PR (provided branch protection allows admin bypass).
  3. **Temporarily un-require the check.** Remove the `dev-agent · phase-tier2-smoke / smoke-call` check from branch protection's required-checks list, merge, re-add it. Has the largest blast radius — prefer admin-merge for one-off.
- **Vercel assumption** — The wrapper sources the staging URL from Vercel's PR comment (`vercel[bot]` post with `https://*.vercel.app`). If the consumer uses a different deploy stack (fly.io, Render, etc.), they must customize `dev-agent-tier2-smoke.yml` in their repo to derive the URL — change the `--- staging_url ---` block in the `resolve` step. The rest of the wrapper is deploy-stack-agnostic.
- **Spec-path requirement** — The wrapper expects a `docs/specs/*.md` reference in the issue body. Features approved via the dashboard's PM brainstorm already get one. Hand-filed `kind:user-intent` issues without a spec link are skipped with an explanatory comment (no smoke = no verdict; promote can still proceed past staging-deployed if the gate is not yet required in branch protection).
- **Override gap** — A consumer `/smoke-override` command is NOT shipped in v1 (same gap as `/swarm-override`). The escape hatches above are the v1 paths.

- [ ] **Step 2: Add the README link**

In `README.md`, find the existing `## Swarm-review` section (added in PR #88). Add a parallel `## Tier-2 smoke` section immediately after it:

```markdown
## Tier-2 smoke

Tier-2 smoke enforcement + canary rollout: see [docs/runbooks/2026-05-20-tier2-smoke-rollout.md](docs/runbooks/2026-05-20-tier2-smoke-rollout.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/2026-05-20-tier2-smoke-rollout.md README.md
git commit -m "docs(tier2-smoke): rollout runbook + README link"
```

---

## Self-Review

**1. Spec coverage:**
- Trigger model (auto on `state:staging-deployed`, wrapper-driven) → Task 1.
- Wrapper resolving PR / staging URL / spec path → Task 1 (the Resolve step).
- Wrapper flipping state → Task 1 (the `gh issue edit` near the end of Resolve).
- Wrapper calling reusable pinned to `@v1` → Task 1 (the `smoke-call` job).
- Orchestrator entry transition → Task 3.
- Distribution: wire-up + INSTALLABLE_WORKFLOWS + drift test → Task 2.
- Dashboard surface — handled by the existing install panel (covered by `configuredPillars`'s SMOKE_WORKFLOW check + the universal install panel from PR #86). No separate dashboard task needed; the spec marked this "optional" and the existing one-click panel covers it.
- Canary rollout + override paths → Task 4.

**2. Placeholder scan:**
- "Find via grep" appears once in Task 3 Step 1 — but it's accompanied by a concrete command (`find tests -name 'orchestrator.test.*' ...`) and explicit fallback instructions if no file is found. Not a placeholder, an instruction.
- No "TBD" / "implement later" / "similar to Task N" anywhere.

**3. Type consistency:**
- `WorkflowKey` includes `'tier2-smoke'` after Task 2's `INSTALLABLE_WORKFLOWS` extension (TypeScript infers it from the map keys).
- `TransitionTrigger` includes `'workflow-tier2-fire'` after Task 3.
- The wrapper's output names (`ready`, `issue_number`, `pr_number`, `staging_url`, `spec_path`) match the `needs.tier2-smoke.outputs.*` references in the `smoke-call` job within the same file.

**Notes for the implementer:**
- The wrapper file in Task 1 is large (~120 lines). Read `examples/web-app-template/.github/workflows/dev-agent-verification.yml` first for the security/permissions pattern this should mirror.
- All untrusted GitHub event values in Task 1's resolve step are routed through env vars (`ISSUE_FROM_EVENT`, etc.) — match this pattern verbatim. Never interpolate `${{ github.event.* }}` directly into a `run:` block.
- After Tasks 1–3 land, manually verify on the canary repo (`caliente-booking-app`): trigger a staging-deploy, watch the wrapper fire, confirm the smoke run shows up in GitHub Actions. The runbook from Task 4 documents this for future operators.
