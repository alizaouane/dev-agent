# Consumer-side `/swarm-override` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/swarm-override` comment handler to consumer repos that mirrors the engine-repo handler. Closes the "consumer-side override is a planned follow-up" gap in the enforcement runbook.

**Architecture:** New consumer workflow `dev-agent-swarm-override.yml`; distributed via the existing wire-up + INSTALLABLE_WORKFLOWS pattern (same as `dev-agent-verification.yml` from PR #88 and `dev-agent-tier2-smoke.yml` from PR #94). Audit comment carries a `<!-- dev-agent:event:b64 <base64> -->` anchor matching the engine-repo format introduced by PR #96.

**Tech Stack:** GitHub Actions YAML, jq, base64, TypeScript (drift + actions tests), vitest.

---

## File structure

| File | Responsibility |
|---|---|
| `examples/web-app-template/.github/workflows/dev-agent-swarm-override.yml` | Consumer-side override workflow. Single job, runs on `issue_comment.created`, gated by head-branch regex + bot exclusion. |
| `dashboard/lib/wire-up-template.ts` | Embeds the workflow as `TEMPLATE_SWARM_OVERRIDE_WORKFLOW_YML`, adds to `WIRE_UP_FILES` (now 10), adds `INSTALLABLE_WORKFLOWS['swarm-override']`. |
| `tests/unit/web-app-template.test.ts` | Structural test for the new workflow (triggers, gate, permissions, audit-anchor pattern). |
| `tests/unit/wire-up-template-drift.test.ts` | Drift test asserting embedded ≡ on-disk. |
| `dashboard/__tests__/lib/actions.test.ts` | Installer test for `installWorkflow('swarm-override')` + bumps wireUpRepo's expected file count 9 → 10. |
| `docs/runbooks/2026-05-16-swarm-review-enforcement.md` | Replace "planned follow-up" wording with "now available" + usage notes. |

---

### Task 1: Consumer workflow + structural test

**Files:**
- Create: `examples/web-app-template/.github/workflows/dev-agent-swarm-override.yml`
- Modify: `tests/unit/web-app-template.test.ts` (add new `it()`)

- [ ] **Step 1: Write the failing structural test** in `tests/unit/web-app-template.test.ts`, alongside the existing `tier2-smoke wrapper exists` test:

```ts
it('swarm-override wrapper exists, declares the right triggers and audit anchor', () => {
  const path = resolve(templateRoot, '.github/workflows/dev-agent-swarm-override.yml');
  expect(existsSync(path)).toBe(true);
  const raw = readFileSync(path, 'utf8');
  const parsed = yaml.load(raw) as {
    on?: { issue_comment?: { types: string[] } };
    permissions?: Record<string, string>;
    jobs: Record<string, { if?: string; permissions?: Record<string, string> }>;
  };

  // Trigger: issue_comment.created only (NOT pull_request_review).
  expect(parsed.on?.issue_comment?.types).toEqual(['created']);

  // Top-level permissions cover label + comment write + PR read.
  // (Either top-level or job-level is acceptable; this assertion checks
  // the override job has the writes it needs.)
  const overrideJob = parsed.jobs?.['swarm-override'];
  expect(overrideJob).toBeDefined();
  const perms = overrideJob.permissions ?? parsed.permissions ?? {};
  expect(perms['issues']).toBe('write');
  expect(perms['pull-requests']).toBe('write');

  // Job gate: PR-only, prefix-match on /swarm-override, bot exclusion.
  const ifExpr = overrideJob.if ?? '';
  expect(ifExpr).toMatch(/issue\.pull_request/);
  expect(ifExpr).toMatch(/startsWith.*swarm-override/);
  expect(ifExpr).toMatch(/claude\[bot\]/);
  expect(ifExpr).toMatch(/dev-agent\[bot\]/);
  expect(ifExpr).toMatch(/github-actions\[bot\]/);

  // Audit pattern: jq builds JSON, base64 encodes, :b64 anchor in body.
  expect(raw).toMatch(/jq -nc/);
  expect(raw).toMatch(/event:"override\.applied"/);
  expect(raw).toMatch(/override_type:"swarm-override"/);
  expect(raw).toMatch(/base64 -w0/);
  expect(raw).toMatch(/<!-- dev-agent:event:b64 /);
});
```

- [ ] **Step 2: Run the test to confirm it fails** (file doesn't exist yet):

```bash
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/web-app-template.test.ts -t "swarm-override"
```

Expected: FAIL with "Cannot read properties of undefined" or similar (the file doesn't exist; `parsed` is `undefined`).

- [ ] **Step 3: Create the workflow file** at `examples/web-app-template/.github/workflows/dev-agent-swarm-override.yml`:

```yaml
name: dev-agent · swarm-override

# Consumer-side /swarm-override comment handler. Mirrors the engine-repo
# handler at dev-agent's own .github/workflows/phase-pr-review.yml (the
# swarm-override sibling job) so consumer-repo PRs can apply the same
# manual override to a failed swarm-review verdict.
#
# Trigger: a PR comment that starts with `/swarm-override` on a PR whose
# head branch matches `feat/dev-agent-issue-*` (dev-agent-authored only).
# The comment body's free-form tail is captured as the operator's reason
# and recorded both in the human-readable audit comment AND in a hidden
# machine-parseable `<!-- dev-agent:event:b64 <base64> -->` anchor that
# mirrors lib/events.ts's `override.applied` event shape. The payload is
# base64-encoded because reason is user-supplied — a reason containing
# `-->` would otherwise truncate the HTML anchor.
#
# v1 behavior: the override flips swarm-review labels (fail/concern → pass)
# and adds `swarm-overridden`. It does NOT mechanically unblock a required
# `verification-gate` branch-protection check; that wiring is v1.1 work
# (same status as the engine handler today).

on:
  issue_comment:
    types: [created]

permissions:
  issues: write
  pull-requests: write

jobs:
  swarm-override:
    if: |
      github.event.issue.pull_request != null &&
      startsWith(github.event.comment.body, '/swarm-override') &&
      github.event.comment.user.login != 'claude[bot]' &&
      github.event.comment.user.login != 'dev-agent[bot]' &&
      github.event.comment.user.login != 'github-actions[bot]'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      issues: write
      pull-requests: write
    steps:
      - name: Harden runner (egress audit)
        uses: step-security/harden-runner@v2
        with:
          egress-policy: audit
          disable-sudo: true

      - name: Resolve PR head branch + extract reason
        id: ctx
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.issue.number }}
          ACTOR: ${{ github.event.comment.user.login }}
          COMMENT_BODY: ${{ github.event.comment.body }}
        run: |
          set -euo pipefail
          HEAD=$(gh pr view "$PR_NUMBER" --json headRefName --jq '.headRefName')
          if ! [[ "$HEAD" =~ ^feat/dev-agent-issue-[0-9]+$ ]]; then
            echo "Not a dev-agent PR; exiting."
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          REASON=$(printf '%s' "$COMMENT_BODY" | sed -E 's|^/swarm-override[[:space:]]*||' | head -c 500)
          if [ -z "$REASON" ]; then
            REASON="(no reason given)"
          fi
          echo "skip=false" >> "$GITHUB_OUTPUT"
          {
            echo "reason<<EOF_REASON"
            printf '%s\n' "$REASON"
            echo "EOF_REASON"
          } >> "$GITHUB_OUTPUT"

      - name: Apply override + post audit comment with event anchor
        if: steps.ctx.outputs.skip != 'true'
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.issue.number }}
          ACTOR: ${{ github.event.comment.user.login }}
          REASON: ${{ steps.ctx.outputs.reason }}
          RUN_ID: ${{ github.run_id }}
        run: |
          set -euo pipefail
          gh pr edit "$PR_NUMBER" --remove-label 'swarm-review:fail' || true
          gh pr edit "$PR_NUMBER" --remove-label 'swarm-review:concern' || true
          gh pr edit "$PR_NUMBER" --add-label 'swarm-overridden' || true
          gh pr edit "$PR_NUMBER" --add-label 'swarm-review:pass' || true
          TS=$(date -u -Iseconds)
          # phase field is the consumer workflow filename (not phase-pr-review)
          # so anchor scrapers can distinguish engine-repo overrides from
          # consumer-repo overrides when walking both.
          EVENT_JSON=$(jq -nc \
            --arg ts "$TS" \
            --arg run_id "$RUN_ID" \
            --argjson issue "$PR_NUMBER" \
            --arg actor "$ACTOR" \
            --arg reason "$REASON" \
            '{ts:$ts, run_id:$run_id, issue:$issue, phase:"dev-agent-swarm-override", event:"override.applied", payload:{override_type:"swarm-override", actor:$actor, reason:$reason}}')
          EVENT_B64=$(printf '%s' "$EVENT_JSON" | base64 -w0)
          BODY=$(printf '🛟 swarm-override applied\n\n**Actor:** @%s\n**Reason:** %s\n**Timestamp:** %s\n\nThe swarm-review verdict has been manually overridden. The PR may now advance to human review. The original verdict comment remains visible above for context.\n\n<!-- dev-agent:event:b64 %s -->\n' "$ACTOR" "$REASON" "$TS" "$EVENT_B64")
          gh pr comment "$PR_NUMBER" --body "$BODY"
```

- [ ] **Step 4: Run the test to confirm it passes**:

```bash
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/web-app-template.test.ts -t "swarm-override"
```

Expected: PASS.

- [ ] **Step 5: Run full root tests** to verify nothing regressed:

```bash
cd "$(git rev-parse --show-toplevel)" && npm test
```

Expected: all green (count goes up by 1 for the new structural test).

- [ ] **Step 6: Commit**:

```bash
git add examples/web-app-template/.github/workflows/dev-agent-swarm-override.yml tests/unit/web-app-template.test.ts
git commit -m "feat(swarm-override): consumer-side override workflow + structural test"
```

---

### Task 2: Distribution (embedded template + drift + installer)

**Files:**
- Modify: `dashboard/lib/wire-up-template.ts`
- Modify: `tests/unit/wire-up-template-drift.test.ts`
- Modify: `dashboard/__tests__/lib/actions.test.ts`

- [ ] **Step 1: Read the existing pattern**. Open `dashboard/lib/wire-up-template.ts` and locate (a) `TEMPLATE_TIER2_SMOKE_WORKFLOW_YML`, (b) the `WIRE_UP_FILES` array, and (c) the `INSTALLABLE_WORKFLOWS` map. Each of those three locations gets one new entry for `swarm-override`. Note the escaping convention used in the sibling constants: every literal `${` becomes `\${` and every backtick becomes `` \` `` in the template-literal embedding.

- [ ] **Step 2: Write the drift test FIRST** in `tests/unit/wire-up-template-drift.test.ts`:

```ts
it('TEMPLATE_SWARM_OVERRIDE_WORKFLOW_YML matches the on-disk consumer workflow', () => {
  const onDisk = readFileSync(
    resolve(repoRoot, 'examples/web-app-template/.github/workflows/dev-agent-swarm-override.yml'),
    'utf8',
  );
  expect(TEMPLATE_SWARM_OVERRIDE_WORKFLOW_YML).toBe(onDisk);
});
```

(Mirror the import + test style of the existing tier2-smoke drift test in the same file.)

- [ ] **Step 3: Run the drift test to confirm it fails** (constant doesn't exist):

```bash
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/wire-up-template-drift.test.ts -t "swarm-override"
```

Expected: FAIL — `TEMPLATE_SWARM_OVERRIDE_WORKFLOW_YML is not defined`.

- [ ] **Step 4: Add the embedded constant + maps** in `dashboard/lib/wire-up-template.ts`:

  a) **Define `TEMPLATE_SWARM_OVERRIDE_WORKFLOW_YML`** as a `const` immediately after `TEMPLATE_TIER2_SMOKE_WORKFLOW_YML`. Value is the EXACT current content of the new on-disk workflow file, embedded as a template literal with:
  - every `${` → `\${`
  - every `` ` `` → `` \` ``
  - all other content (including the `<!--` and base64 step) verbatim

  b) **Add the new file to `WIRE_UP_FILES`** (after the tier2-smoke entry):

  ```ts
  {
    path: '.github/workflows/dev-agent-swarm-override.yml',
    contents: TEMPLATE_SWARM_OVERRIDE_WORKFLOW_YML,
    encoding: 'utf-8',
  },
  ```

  The array now has 10 entries (was 9 after PR #94).

  c) **Add to `INSTALLABLE_WORKFLOWS`**:

  ```ts
  'swarm-override': {
    label: 'swarm-override comment handler (per-repo escape hatch)',
    path: '.github/workflows/dev-agent-swarm-override.yml',
    contents: TEMPLATE_SWARM_OVERRIDE_WORKFLOW_YML,
  },
  ```

  d) **Refresh the JSDoc** on `INSTALLABLE_WORKFLOWS` if it lists the covered surfaces — add "manual swarm-override" alongside the existing items.

- [ ] **Step 5: Run the drift test to confirm it passes**:

```bash
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/wire-up-template-drift.test.ts -t "swarm-override"
```

Expected: PASS.

- [ ] **Step 6: Extend `dashboard/__tests__/lib/actions.test.ts`**:

  a) Add a new `it('installs swarm-override via installWorkflow')` test mirroring the existing `tier2-smoke` install test. The test calls `installWorkflow(octokit, 'owner/repo', 'swarm-override')` and asserts the created file path + content match the embedded template.

  b) **Bump every `toHaveBeenCalledTimes(9)` → `(10)` inside the `describe('wireUpRepo', ...)` and `describe('applyPmMdUpdate', ...)` blocks**. There are 5 such occurrences after PR #94 — search for `toHaveBeenCalledTimes(9)` and update each.

  c) **Extend the path-routing case array** (the test that maps every `INSTALLABLE_WORKFLOWS` key to its expected file path) to include the new `swarm-override` entry.

- [ ] **Step 7: Run full root + dashboard tests**:

```bash
cd "$(git rev-parse --show-toplevel)" && npm test
cd "$(git rev-parse --show-toplevel)/dashboard" && npm test
```

Expected: both all-green. Root gains +1 drift test; dashboard gains +1 installer test plus the +1 file-count update lands in each existing wireUpRepo test.

- [ ] **Step 8: Commit**:

```bash
git add dashboard/lib/wire-up-template.ts tests/unit/wire-up-template-drift.test.ts dashboard/__tests__/lib/actions.test.ts
git commit -m "feat(swarm-override): ship consumer workflow via wire-up + installer"
```

---

### Task 3: Runbook update

**Files:**
- Modify: `docs/runbooks/2026-05-16-swarm-review-enforcement.md`

- [ ] **Step 1: Replace the "## Override" section**.

The existing section opens with:

> **In v1, consumer repos do not have a `/swarm-override` comment command.** The `/swarm-override` handler lives in `phase-pr-review.yml`, which runs only inside the dev-agent engine repository — it is not part of the workflow set that wire-up installs into consumer repos. A consumer-side override command is a planned follow-up.

Replace the entire `## Override` section with the following (preserving the surrounding `---` separators and `## Audit trail for /swarm-override` subsection that already exists at the end):

```markdown
## Override

Consumer repos receive a `/swarm-override` comment handler via wire-up. To advance a consumer-repo PR past a failed verification check — a genuine false positive, or an accepted risk — a reviewer comments on the PR:

```
/swarm-override <one-line reason>
```

The override workflow (`.github/workflows/dev-agent-swarm-override.yml`) validates that the PR's head branch matches `feat/dev-agent-issue-*` and the comment author isn't a bot, then:

1. Removes `swarm-review:fail` and `swarm-review:concern` labels.
2. Adds `swarm-overridden` and `swarm-review:pass`.
3. Posts an audit comment with a hidden `<!-- dev-agent:event:b64 <base64> -->` anchor that records the actor, reason, timestamp, and run id in the same JSON shape the engine-repo handler uses (see "Audit trail for /swarm-override" below).

**v1 behavior — what the override does and does not do.** It flips labels and records the audit anchor. It does *not* mechanically produce a passing `verification-gate` check; the v1 verification gate runs on `pull_request` events, not `issue_comment`, so its check status reflects the swarm-review verdict at the last code push. Treat the override as the audited rationale; the actual unblock path is one of:

1. **Admin merge (preferred for a single PR).** If the branch-protection rule does not have **"Do not allow bypassing the above settings"** enabled, a repo admin can merge the PR through GitHub's admin-merge path. The PR timeline and the `/swarm-override` audit anchor together form the bypass record.
2. **Temporarily un-require the check.** Remove the check from the required list (Settings → Branches → edit the rule), merge, then re-add it. Wider blast radius — use only for outage scenarios.

**Authorization.** Override authority is whoever can comment on the PR and is not a bot (`claude[bot]`, `dev-agent[bot]`, `github-actions[bot]` are excluded). Per-repo actor allowlists are v1.1 work — for now, code-owners-on-this-repo is the de-facto authority and the audit anchor records who actually invoked the override.

**Outage labels.** `swarm-review:outage` and `swarm-review:error` are not cleared by `/swarm-override` — they mean the gate produced no verdict at all (infrastructure failure, not a code judgment). Re-run `dev-agent-verification.yml` once the underlying issue is resolved, rather than overriding.
```

(If the existing runbook has a backtick-fenced code block inside the section, escape its backticks correctly so the markdown nests properly. Preserve the `### Audit trail for /swarm-override in the engine repo` subsection that follows — it's still accurate; the consumer override uses the same anchor format with `phase: "dev-agent-swarm-override"` instead of `phase: "phase-pr-review"`.)

- [ ] **Step 2: Update the audit-trail subsection title**. The existing subsection is titled `### Audit trail for /swarm-override in the engine repo`. Rename to `### Audit trail for /swarm-override (engine + consumer)` and replace the inline content so it covers both. Specifically, the existing paragraph says the anchor is emitted by the engine handler — extend to clarify that both engine (`phase: "phase-pr-review"`) and consumer (`phase: "dev-agent-swarm-override"`) emit the same anchor shape with different `phase` values, and a future scraper distinguishes them by that field.

- [ ] **Step 3: Verify markdown** by reading the runbook end-to-end and confirming no orphan fence, no broken table, no leftover "planned follow-up" wording.

- [ ] **Step 4: Commit**:

```bash
git add docs/runbooks/2026-05-16-swarm-review-enforcement.md
git commit -m "docs(swarm-review): runbook reflects consumer-side override availability"
```

---

## Self-review

- [x] Spec coverage: goal (consumer-side override) → Task 1; distribution (wire-up + installer + drift) → Task 2; "planned follow-up" wording → Task 3. No spec section is unaddressed.
- [x] No placeholders. Every step has exact files, exact commands, exact assertions.
- [x] Type consistency: `'swarm-override'` is the `INSTALLABLE_WORKFLOWS` key everywhere. `TEMPLATE_SWARM_OVERRIDE_WORKFLOW_YML` is the embedded constant name. `dev-agent-swarm-override.yml` is the consumer file name. `dev-agent-swarm-override` is the `phase` field in the audit JSON.
- [x] File-count math: `WIRE_UP_FILES` was 8 originally, 9 after PR #94 (tier2-smoke), 10 after this PR. The `toHaveBeenCalledTimes(N)` assertions in `dashboard/__tests__/lib/actions.test.ts` move 9 → 10 in 5 places.
- [x] No engine-workflow change. This PR is purely additive on the consumer side. PR #96's base64 anchor pattern is already merged (or about to be) on the engine; this consumer workflow ships with that pattern from day one.
