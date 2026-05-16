# Swarm-Review Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-built swarm-review gate actually run on dev-agent consumer repos, as a blocking PR status check.

**Architecture:** The swarm-review *engine* is already complete — `phase-swarm-review.yml` (live mode), `phase-evidence-collector.yml`, the `lib/swarm-review.ts` aggregator, reviewer prompts/skills, and the consumer auto-trigger workflow `examples/web-app-template/.github/workflows/dev-agent-verification.yml` all exist and are tagged at `v1`. The only gaps are *distribution* (the verification workflow is not shipped by wire-up, so no repo has it) and *enforcement* (no repo marks the swarm-review check as required). This plan ships the verification workflow through the existing wire-up + backfill-installer machinery (the same pattern PR #86 used for scout workflows), surfaces it on the dashboard, refreshes the `v1` release tag, and documents the canary→enforce rollout. The enforcement model is a **PR status check gated by branch protection** — deliberately *not* a new orchestrator state, because an orchestrator/workflow split would add a bespoke failure surface (stuck issues, label drift) without catching more bugs.

**Tech Stack:** Next.js 15 (dashboard), TypeScript, Vitest, GitHub Actions reusable workflows, Octokit, Tailwind.

---

## Context: what already exists (do not rebuild)

- `.github/workflows/phase-swarm-review.yml` — full live mode: installs Claude Code CLI, downloads the evidence bundle, renders 3 reviewer prompts, runs `spec-compliance` / `regression-guard` / `security-scout` via `claude-code-action`, aggregates, posts a PR comment + `swarm-review:*` label, and exits non-zero on `swarm-fail`. `invocation_mode` defaults to `live`. (The stale header comment claiming "stub mode by default / step 12b" is corrected in Task 6.)
- `.github/workflows/phase-evidence-collector.yml` — deterministic scanners, produces `verification-bundle-pr-<n>`.
- `examples/web-app-template/.github/workflows/dev-agent-verification.yml` — consumer auto-trigger: on `pull_request` opened/synchronize/reopened for `feat/dev-agent-issue-*` branches it calls `phase-evidence-collector.yml@v1` then `phase-swarm-review.yml@v1`; on `/approve` issue comments it calls `phase-acm.yml@v1`. **This file is the thing that is not being distributed.**
- `dashboard/lib/wire-up-template.ts` — embedded `TEMPLATE_*` constants + `WIRE_UP_FILES` array + `SCOUT_WORKFLOWS` map + `installScoutWorkflow` machinery (PR #86).
- `dashboard/components/install-scout-workflow-panel.tsx`, `dashboard/lib/actions.ts::installScoutWorkflow` — the one-click backfill installer (PR #86).
- `tests/unit/wire-up-template-drift.test.ts` — fails if an embedded template constant diverges from its on-disk source in `examples/web-app-template/`.

**The gaps this plan closes:**
1. `dev-agent-verification.yml` is absent from `WIRE_UP_FILES` → fresh wire-ups never get the gate.
2. No backfill path → already-wired repos (e.g. `whatsapp-console`) can never get the gate.
3. The dashboard repo page has no surface for the verification gate's install state.
4. The `v1` tag is 42 commits behind `main`; consumers pinned to `@v1` may resolve a stale `phase-swarm-review.yml`.
5. No documented enforcement (branch-protection required check) or canary rollout.

---

## Task 1: Embed the verification workflow in the wire-up template

**Files:**
- Modify: `dashboard/lib/wire-up-template.ts`
- Modify: `tests/unit/wire-up-template-drift.test.ts`
- Source of truth (read-only): `examples/web-app-template/.github/workflows/dev-agent-verification.yml`

- [ ] **Step 1: Write the failing drift test**

Append a new `it()` block to `tests/unit/wire-up-template-drift.test.ts`, inside the `describe('wire-up-template embedded copy', ...)` block, after the `cleanup-scout` test (line 91):

```typescript
  it('verification workflow on disk matches the embedded TEMPLATE_VERIFICATION_WORKFLOW_YML', () => {
    const onDisk = readFileSync(
      resolve(tplDir, '.github/workflows/dev-agent-verification.yml'),
      'utf8',
    );
    const normalized = embedded
      .replace(/\\\$\{\{/g, '${{')
      .replace(/\\`/g, '`')
      .replace(/\\\$/g, '$');
    expect(normalized).toContain(onDisk);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/wire-up-template-drift.test.ts -t "verification workflow"`
Expected: FAIL — `embedded` does not contain the on-disk file (constant not added yet).

- [ ] **Step 3: Add the embedded constant**

In `dashboard/lib/wire-up-template.ts`, add a new exported constant after `TEMPLATE_CLEANUP_SCOUT_WORKFLOW_YML`. Its value is the **exact current contents** of `examples/web-app-template/.github/workflows/dev-agent-verification.yml`, embedded as a TypeScript template literal with two escapes (the same escaping the sibling `TEMPLATE_*_WORKFLOW_YML` constants already use):
- every `${` becomes `\${` (so GitHub Actions `${{ ... }}` expressions are not interpolated by JS),
- every backtick `` ` `` becomes `` \` ``.

```typescript
export const TEMPLATE_VERIFICATION_WORKFLOW_YML = `name: dev-agent · verification gates
... exact escaped contents of examples/web-app-template/.github/workflows/dev-agent-verification.yml ...
`;
```

- [ ] **Step 4: Add the file to `WIRE_UP_FILES`**

In the `WIRE_UP_FILES` array in the same file, add this entry immediately after the `dev-agent-cleanup-scout.yml` entry:

```typescript
  {
    path: '.github/workflows/dev-agent-verification.yml',
    content: TEMPLATE_VERIFICATION_WORKFLOW_YML,
  },
```

- [ ] **Step 5: Run the drift test to verify it passes**

Run: `npx vitest run tests/unit/wire-up-template-drift.test.ts`
Expected: PASS — all 8 drift checks green (7 prior + the new verification check).

- [ ] **Step 6: Run the dashboard wireUpRepo tests to confirm the new file count**

`wireUpRepo` tests in `dashboard/__tests__/lib/actions.test.ts` assert `createOrUpdateFileContents` is called `toHaveBeenCalledTimes(7)`. Adding an 8th `WIRE_UP_FILES` entry breaks them. Update every `toHaveBeenCalledTimes(7)` in the `describe('wireUpRepo', ...)` block to `toHaveBeenCalledTimes(8)`.

Run: `cd dashboard && npx vitest run __tests__/lib/actions.test.ts -t "wireUpRepo"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/wire-up-template.ts tests/unit/wire-up-template-drift.test.ts dashboard/__tests__/lib/actions.test.ts
git commit -m "feat(wire-up): ship dev-agent-verification.yml on fresh wire-ups"
```

---

## Task 2: Generalize the scout installer to cover the verification workflow

PR #86 built `installScoutWorkflow` + the `SCOUT_WORKFLOWS` map for the three scout workflows. The verification workflow is not a scout, so this task renames the machinery to a neutral "installable workflow" name and adds the verification entry. This is a mechanical rename plus one new map entry — no behavior change to the existing three scouts.

**Files:**
- Modify: `dashboard/lib/wire-up-template.ts`
- Modify: `dashboard/lib/actions.ts`
- Rename + modify: `dashboard/components/install-scout-workflow-panel.tsx` → `dashboard/components/install-workflow-panel.tsx`
- Modify: `dashboard/components/scan-with-pm-button.tsx`, `dashboard/components/scan-cleanup-button.tsx`, `dashboard/components/bug-scout-schedule-form.tsx`
- Modify: `dashboard/__tests__/lib/actions.test.ts`

- [ ] **Step 1: Update the test suite to the new names + add the verification case**

In `dashboard/__tests__/lib/actions.test.ts`, rename the `describe('installScoutWorkflow', ...)` block to `describe('installWorkflow', ...)`, change every `import { installScoutWorkflow }` to `import { installWorkflow }` and every call, and add this case inside the block:

```typescript
  it('commits the verification workflow file when missing', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'verification');
    await expect(installWorkflow(fd)).resolves.toBeUndefined();

    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '.github/workflows/dev-agent-verification.yml',
      }),
    );
  });
```

Also extend the existing `'targets the correct path for each workflow key'` case's `cases` array with:
```typescript
      ['verification', '.github/workflows/dev-agent-verification.yml'],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && npx vitest run __tests__/lib/actions.test.ts -t "installWorkflow"`
Expected: FAIL — `installWorkflow` is not exported (still named `installScoutWorkflow`), `verification` is not a valid key.

- [ ] **Step 3: Rename + extend the workflow map in `wire-up-template.ts`**

In `dashboard/lib/wire-up-template.ts`, rename `SCOUT_WORKFLOWS` → `INSTALLABLE_WORKFLOWS`, `ScoutWorkflowKey` → `WorkflowKey`, `SCOUT_WORKFLOW_KEYS` → `WORKFLOW_KEYS`, and add a `verification` entry:

```typescript
export const INSTALLABLE_WORKFLOWS = {
  'bug-scout': {
    path: '.github/workflows/dev-agent-bug-scout.yml',
    content: TEMPLATE_BUG_SCOUT_WORKFLOW_YML,
    label: 'Bug-scout',
  },
  'unfinished-work': {
    path: '.github/workflows/dev-agent-unfinished-work-scout.yml',
    content: TEMPLATE_UNFINISHED_WORK_SCOUT_WORKFLOW_YML,
    label: 'PM scan (unfinished-work scout)',
  },
  cleanup: {
    path: '.github/workflows/dev-agent-cleanup-scout.yml',
    content: TEMPLATE_CLEANUP_SCOUT_WORKFLOW_YML,
    label: 'Cleanup scan',
  },
  verification: {
    path: '.github/workflows/dev-agent-verification.yml',
    content: TEMPLATE_VERIFICATION_WORKFLOW_YML,
    label: 'Verification gates (swarm-review)',
  },
} as const;

export type WorkflowKey = keyof typeof INSTALLABLE_WORKFLOWS;

export const WORKFLOW_KEYS: WorkflowKey[] = Object.keys(
  INSTALLABLE_WORKFLOWS,
) as WorkflowKey[];
```

- [ ] **Step 4: Rename the action in `actions.ts`**

In `dashboard/lib/actions.ts`: update the import to `import { WIRE_UP_FILES, INSTALLABLE_WORKFLOWS, WORKFLOW_KEYS, type WorkflowKey } from './wire-up-template';`. Rename the exported `installScoutWorkflow` function to `installWorkflow`, and inside it replace `SCOUT_WORKFLOWS` → `INSTALLABLE_WORKFLOWS`, `SCOUT_WORKFLOW_KEYS` → `WORKFLOW_KEYS`, `ScoutWorkflowKey` → `WorkflowKey`, and the `[installScoutWorkflow]` console.error tag → `[installWorkflow]`. No logic change.

- [ ] **Step 5: Rename the panel component**

```bash
git mv dashboard/components/install-scout-workflow-panel.tsx dashboard/components/install-workflow-panel.tsx
```

In `dashboard/components/install-workflow-panel.tsx`: rename the exported component `InstallScoutWorkflowPanel` → `InstallWorkflowPanel`, change the prop type `workflow: ScoutWorkflowKey` → `workflow: WorkflowKey`, update the import to `import { installWorkflow } from '@/lib/actions';` and `import type { WorkflowKey } from '@/lib/wire-up-template';`, and update the call `installScoutWorkflow(fd)` → `installWorkflow(fd)`.

- [ ] **Step 6: Update the three scout components' imports**

In `scan-with-pm-button.tsx`, `scan-cleanup-button.tsx`, `bug-scout-schedule-form.tsx`: change `import { InstallScoutWorkflowPanel } from '@/components/install-scout-workflow-panel';` → `import { InstallWorkflowPanel } from '@/components/install-workflow-panel';` and rename the JSX tag `<InstallScoutWorkflowPanel ... />` → `<InstallWorkflowPanel ... />`. No prop changes.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd dashboard && npx vitest run __tests__/lib/actions.test.ts && npx tsc --noEmit`
Expected: PASS — all actions tests green, no type errors.

- [ ] **Step 8: Commit**

```bash
git add dashboard/lib/wire-up-template.ts dashboard/lib/actions.ts dashboard/components/install-workflow-panel.tsx dashboard/components/scan-with-pm-button.tsx dashboard/components/scan-cleanup-button.tsx dashboard/components/bug-scout-schedule-form.tsx dashboard/__tests__/lib/actions.test.ts
git commit -m "refactor(dashboard): generalize scout installer to installWorkflow + add verification"
```

---

## Task 3: Surface the verification gate on the dashboard repo page

**Files:**
- Modify: `dashboard/app/repos/[name]/page.tsx`

- [ ] **Step 1: Add the verification-workflow probe constant + Promise.all entry**

In `dashboard/app/repos/[name]/page.tsx`, near `UNFINISHED_WORK_WORKFLOW_PATH` (line 18) add:

```typescript
const VERIFICATION_WORKFLOW_PATH = '.github/workflows/dev-agent-verification.yml';
```

Then in the `Promise.all` that computes `unfinishedWorkInstalled` / `cleanupInstalled` (lines 59-72), add a fourth probe:

```typescript
      repo.wired_up
        ? isWorkflowInstalled(octokit, repo.owner, repo.name, repo.default_branch, VERIFICATION_WORKFLOW_PATH)
        : Promise.resolve(false),
```

and add `verificationInstalled` to the destructured array on line 59.

- [ ] **Step 2: Render the verification section in the Settings band**

In the Band 7 `Settings & links` section (after the `Bug-scout schedule` block, before the `Files` block, around line 218), add:

```tsx
            <div className="rounded-md border border-border bg-card p-5">
              <h3 className="mb-1 text-base font-semibold">Verification gates (swarm-review)</h3>
              {verificationInstalled ? (
                <p className="text-sm text-muted-foreground">
                  Installed. On every dev-agent PR, three reviewers (spec-compliance,
                  regression-guard, security-scout) run over the evidence bundle and post a
                  verdict. To make it block merges, add the{' '}
                  <code>dev-agent · phase-swarm-review</code> check as a required status
                  check in branch protection.
                </p>
              ) : (
                <InstallWorkflowPanel
                  repo={name}
                  workflow="verification"
                  title="Verification gates"
                  description="Installs dev-agent-verification.yml so swarm-review (3 adversarial reviewers + deterministic scanners) runs automatically on every dev-agent PR."
                />
              )}
            </div>
```

- [ ] **Step 3: Add the import**

At the top of the file, add: `import { InstallWorkflowPanel } from '@/components/install-workflow-panel';`

- [ ] **Step 4: Verify typecheck + build compile**

Run: `cd dashboard && npx tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/app/repos/[name]/page.tsx
git commit -m "feat(dashboard): verification-gate install panel on repo workspace"
```

---

## Task 4: Refresh the `v1` release tag

The consumer `dev-agent-verification.yml` pins `uses: alizaouane/dev-agent/.github/workflows/phase-{acm,evidence-collector,swarm-review}.yml@v1`. `v1` is currently 42 commits behind `main`, so consumers may resolve a stale `phase-swarm-review.yml` that predates the PR #78/#79 review fixes already on `main`.

**Files:** none (release operation).

- [ ] **Step 1: Confirm the staleness**

Run:
```bash
git fetch origin --tags
git log --oneline v1..origin/main -- .github/workflows/phase-swarm-review.yml .github/workflows/phase-evidence-collector.yml
```
Expected: lists commits to those workflows that are on `main` but not at `v1`. If the list is empty, `v1` is already current — skip Steps 2-3.

- [ ] **Step 2: Re-point `v1` to current `main`**

This is a force-update of a shared release tag — every consumer repo follows `@v1`. Confirm with the team before running. After Tasks 1-3 have merged to `main`:

```bash
git checkout main && git pull --ff-only
git tag -f v1 main
git push -f origin v1
```

- [ ] **Step 3: Verify the tag moved**

Run: `git ls-tree --name-only v1 .github/workflows/ | grep -E "swarm|evidence"`
Expected: both `phase-swarm-review.yml` and `phase-evidence-collector.yml` listed, and `git show v1:.github/workflows/phase-swarm-review.yml | head -20` matches current `main`.

---

## Task 5: Document enforcement + canary rollout

`phase-swarm-review.yml` already exits non-zero on `swarm-fail`, so the GitHub check goes red — but a red check does not *block* merge unless branch protection requires it. Best practice for shipping bug-free code: run advisory first, measure the false-positive rate, then make it a required check.

**Files:**
- Modify: `README.md`
- Create: `docs/runbooks/2026-05-16-swarm-review-enforcement.md`

- [ ] **Step 1: Write the enforcement runbook**

Create `docs/runbooks/2026-05-16-swarm-review-enforcement.md` with these sections, each fully written out (no placeholders):
- **What swarm-review is** — 3 reviewers over a frozen evidence bundle, runs on every `feat/dev-agent-issue-*` PR once `dev-agent-verification.yml` is installed.
- **Canary phase** — leave the check advisory (do not add it to branch protection). Let it run on at least 20 dev-agent PRs. Inspect each `swarm-review:*` label vs. the actual merged outcome; record false positives (gate said fail, code was fine) and false negatives (gate said pass, a bug shipped).
- **Enforce phase** — once the false-positive rate is acceptable (target < 1 in 10), require the verification checks in branch protection for the default branch.
- **Override** — how a maintainer advances a PR past a failed verification check.
- **Kill switch** — how to bypass the gate during an infrastructure incident.

> **Superseded during implementation:** The bullets above were drafted before the runbook was verified against v1 code, and three of them turned out to be inaccurate — they are corrected in the as-built runbook (`docs/runbooks/2026-05-16-swarm-review-enforcement.md`), which is the source of truth:
> - **Enforce** — the runbook requires *both* the `evidence` and `swarm-review` checks (a `needs:`-skipped required check counts as passing, so `evidence` must be required in its own right); it does not name a single `dev-agent · phase-swarm-review` check.
> - **Override** — `/swarm-override` and its `events.jsonl` logging are a dev-agent-engine-internal mechanism (`phase-pr-review.yml`), *not* shipped to consumer wire-ups in v1. Consumers override via admin merge or by temporarily un-requiring the check.
> - **Kill switch** — `DEV_AGENT_GATE_KILL_SWITCH` does not exist in v1; the runbook documents the actual v1 bypass options instead.

- [ ] **Step 2: Link the runbook from the README**

In `README.md`, under the verification/status section, add one line: `Swarm-review enforcement + canary rollout: see docs/runbooks/2026-05-16-swarm-review-enforcement.md`.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/runbooks/2026-05-16-swarm-review-enforcement.md
git commit -m "docs(swarm-review): enforcement runbook + canary rollout"
```

---

## Task 6: Correct the stale workflow header comment

`phase-swarm-review.yml` lines 13-16 claim "v1 ships in stub mode by default. Live mode ... lands in step 12b" — false; live mode is the default and fully implemented.

**Files:**
- Modify: `.github/workflows/phase-swarm-review.yml`

- [ ] **Step 1: Replace the stale comment**

Replace lines 13-16 of `.github/workflows/phase-swarm-review.yml`:

```yaml
# Live mode (the default) runs three real reviewer agents via
# claude-code-action over prompts/swarm-{spec-compliance,regression-guard,
# security-scout}.md. Stub mode (invocation_mode: stub) is retained for
# wiring tests only.
```

- [ ] **Step 2: Also fix the `workflow_dispatch` input description**

On the `invocation_mode` input under `workflow_dispatch` (line 66), change `'live (real reviewers — TODO step 12b) or stub'` to `'live (real reviewers, default) or stub (wiring tests only)'`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/phase-swarm-review.yml
git commit -m "docs(swarm-review): correct stale stub-mode header comment"
```

---

## Self-Review

**1. Spec coverage:** The five gaps from the Context section map to tasks — gap 1 (fresh wire-ups) → Task 1; gap 2 (backfill) → Task 2; gap 3 (dashboard surface) → Task 3; gap 4 (`v1` tag) → Task 4; gap 5 (enforcement/canary) → Task 5. Task 6 is a documentation-correctness cleanup surfaced during the audit. No gap is unaddressed.

**2. Placeholder scan:** The embedded YAML in Task 1 Step 3 instructs "exact current contents of `examples/web-app-template/.github/workflows/dev-agent-verification.yml`" — this is a copy of a concrete, existing file (the same method by which every sibling `TEMPLATE_*` constant was created), not a TBD. The runbook in Task 5 enumerates the exact sections to write.

**3. Type/name consistency:** `INSTALLABLE_WORKFLOWS` / `WorkflowKey` / `WORKFLOW_KEYS` / `installWorkflow` / `InstallWorkflowPanel` are used consistently across Tasks 2 and 3. `TEMPLATE_VERIFICATION_WORKFLOW_YML` is defined in Task 1 and referenced in Task 2 Step 3. `verificationInstalled` is introduced and consumed within Task 3. `VERIFICATION_WORKFLOW_PATH` defined and used within Task 3.

**Risk note:** Task 4 force-updates a shared tag — sequence it strictly after Tasks 1-3 merge. The verification workflow's same-repo fork guard means fork PRs silently skip the gate; that is intended (documented in the workflow itself), not a gap.
