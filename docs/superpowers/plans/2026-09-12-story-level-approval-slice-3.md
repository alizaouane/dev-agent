# Story-level approval — Implementation Plan (slice 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A story-based issue can be filed by the intake and dispatched end to end — the gate accepts it, the workflow resolves it, and the implement agent reads the story as its context bundle.

**Architecture:** The issue body gains a `Story:` line where a spec issue carries `Spec:` and `Plan:`. Both the dashboard gate and the workflow-side check branch on which line is present, routing a story to `storyDispatchGateDecision` (already built in slice 1) and a spec to the existing `dispatchGateDecision`. The implement workflow resolves a story path and feeds the story file as the agent's context. The intake gains a second door that skips brainstorming and plan writing when the story already exists.

**Tech Stack:** TypeScript (strict), GitHub Actions YAML, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-12-story-level-approval-design.md`

## Scope of this plan

Slice 3 only: **AC-16, AC-17**, plus the gate and workflow plumbing that makes a story issue dispatchable at all, plus the parked ruling from slice 1's execution.

At the end of this plan, a story with a recorded approval can be filed as an issue and started from the feature page's existing dispatch route. It will not yet appear in the dashboard's picker — that is slice 4.

**Slice 4 is deliberately not planned here.** It carries an unresolved design question that should be decided before it is written, not inside a plan. See "What slice 4 needs decided first" at the end.

## Global Constraints

- TypeScript strict; zero `any` without an inline justification comment.
- 100% docstring coverage on every exported symbol: what it does, its inputs, what it returns or throws. Never restate the signature.
- `dashboard/lib/story-approval.ts` must stay byte-identical to `lib/story-approval.ts`; same for the two `spec-approval.ts` copies. The dashboard deploys with `rootDirectory=dashboard/`, so the copies are what ship. Re-copy and verify with `cmp` in the same task that edits either.
- `SPEC_APPROVAL_SCHEMA_VERSION` and `STORY_APPROVAL_SCHEMA_VERSION` both stay at `1`.
- A read that fails for any reason other than "not found" must never be reported as absence.
- Never write a literal control character into source — escape sequences only.
- Engine tests: `tests/unit/**`, run with `npx vitest run tests/unit/<file>`. Dashboard tests: `dashboard/__tests__/**`.

## File Structure

| File | Responsibility |
|---|---|
| `lib/story-approval.ts` + dashboard mirror (modify) | Derive the status regex from one list |
| `dashboard/lib/spec-approval-gate.ts` (modify) | Parse a `Story:` line; route the gate by issue kind |
| `lib/cli/verify-approval.ts` (modify) | Accept `STORY_PATH` and check a story approval |
| `.github/workflows/phase-implement.yml` (modify) | Resolve a story path; pass it on; feed it to the prompt |
| `skills/start-feature/SKILL.md` (modify) | The second door, and the issue it files |
| `tests/unit/story-approval.test.ts` (modify) | Task 1 |
| `tests/unit/verify-approval.test.ts` (modify) | Task 4 |
| `tests/unit/workflows.test.ts` (modify) | Task 5 |
| `tests/unit/skills.test.ts` (modify) | Task 6 |
| `dashboard/__tests__/lib/spec-approval-gate.test.ts` (modify) | Tasks 2, 3 |

---

### Task 1: One source of truth for the status values

Closes the finding parked at the end of slice 1's execution: `STORY_STATUS_VALUES` and the alternation inside `STATUS_LINE_RE` are two hand-synced literals. Adding a value to one without the other makes stamping succeed while hashing stops stripping — a silent break.

**Files:**
- Modify: `lib/story-approval.ts`
- Modify: `dashboard/lib/story-approval.ts` (re-copy)
- Modify: `tests/unit/story-approval.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `STATUS_LINE_RE` built from `STORY_STATUS_VALUES` rather than a hand-written alternation. No signature changes.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/unit/story-approval.test.ts
import { STORY_STATUS_VALUES, STATUS_LINE_RE as RE } from '../../lib/story-approval';

describe('status values and the regex are one source', () => {
  it('matches every value it declares legal', () => {
    // Two hand-synced literals drift. When they do, stamping writes a status
    // the regex no longer recognises, hashing stops stripping the line, and
    // the next transition breaks the approval on a story nobody edited.
    for (const value of STORY_STATUS_VALUES) {
      RE.lastIndex = 0;
      expect(RE.test(`**Status:** ${value}`), value).toBe(true);
    }
  });

  it('matches the In Progress spelling the conformance check allows', () => {
    RE.lastIndex = 0;
    expect(RE.test('**Status:** In Progress')).toBe(true);
  });

  it('still rejects a value it does not declare', () => {
    for (const bad of ['Merged', 'Doneish', 'Draft-old', 'Approvedish']) {
      RE.lastIndex = 0;
      expect(RE.test(`**Status:** ${bad}`), bad).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test — it PASSES, and that is expected**

Run: `npx vitest run tests/unit/story-approval.test.ts -t "one source"`
Expected: PASS. I checked: `In ?Progress` already matches `InProgress` because
the space is optional, so the two literals happen to agree today. This is a
guard against future drift, not a change in behaviour — the same shape as the
schema-version guard in slice 1, which also went green on its first run.

- [ ] **Step 3: Prove the guard is load-bearing**

A test that has never been seen to fail has not been shown to guard anything.

1. Temporarily add `'Merged'` to `STORY_STATUS_VALUES` **without** touching the
   regex.
2. Run the test. Confirm "matches every value it declares legal" FAILS on
   `Merged`. Capture that output — this is the drift the task exists to catch.
3. Revert the temporary value. Re-run and confirm green.
4. Confirm `git status --short` shows the file unmodified before you continue.

- [ ] **Step 4: Build the regex from the list**

Replace the hand-written alternation. Keep `STORY_STATUS_VALUES` as the declaration and derive the pattern from it:

```typescript
/**
 * The lifecycle values a story's status header may carry.
 *
 * This list is the single source of truth: `STATUS_LINE_RE` is built from it,
 * so a value added here is recognised by both the stamper and the hasher
 * without a second edit. They were two hand-written literals until this was
 * derived, and drift between them broke stamping silently.
 *
 * Must stay in step with the kit's conformance check (`.standard/check.sh`),
 * which is the other authority on what a legal status line is.
 */
export const STORY_STATUS_VALUES = [
  'Draft',
  'Approved',
  'InProgress',
  'Review',
  'Done',
  'Blocked',
] as const;

/**
 * One alternation covering every declared value, plus the spaced spelling of
 * `InProgress` that `.standard/check.sh` also accepts.
 */
const STATUS_ALTERNATION = STORY_STATUS_VALUES.map((v) =>
  v === 'InProgress' ? 'In ?Progress' : v,
).join('|');

/**
 * Matches the story's status header in the spellings the kit's conformance
 * check accepts: bare, bold-label, and bold-with-colon forms, any number of
 * asterisks, an optional trailing annotation, and an optional carriage return.
 *
 * One capture group — the prefix. `stampStatus` writes `$1<status>`, which
 * deliberately drops any trailing annotation, because an annotation describing
 * the previous state is misleading once the state has moved on.
 */
export const STATUS_LINE_RE = new RegExp(
  `^([ \\t>-]*\\**Status\\**:?\\**:?[ \\t]*)(?:${STATUS_ALTERNATION})\\**(?:[ \\t].*)?\\r?$`,
  'im',
);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/story-approval.test.ts`
Expected: PASS, every test including the pre-existing spelling and bounds cases.
Then repeat Step 3's proof against the derived regex: adding a value to the list
must now make the regex accept it, so the "still rejects a value it does not
declare" test is the one that fails. Revert.

- [ ] **Step 6: Re-copy the mirror and verify**

```bash
cp lib/story-approval.ts dashboard/lib/story-approval.ts
cmp lib/story-approval.ts dashboard/lib/story-approval.ts
npx vitest run tests/unit/story-approval.test.ts
```
Expected: `cmp` silent, drift test green.

- [ ] **Step 7: Commit**

```bash
git add lib/story-approval.ts dashboard/lib/story-approval.ts tests/unit/story-approval.test.ts
git commit -m "refactor(approval): derive the status regex from the values it declares legal"
```

---

### Task 2: Parse a `Story:` line out of an issue body

**Files:**
- Modify: `dashboard/lib/spec-approval-gate.ts`
- Modify: `dashboard/__tests__/lib/spec-approval-gate.test.ts`

**Interfaces:**
- Consumes: the existing fence-stripping in `parseSpecRefs`.
- Produces: `export interface StoryRef { story_path: string }` and `export function parseStoryRef(body: string | null | undefined): StoryRef | null`.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to dashboard/__tests__/lib/spec-approval-gate.test.ts
import { parseStoryRef } from '@/lib/spec-approval-gate';

describe('parseStoryRef', () => {
  it('reads the story path out of the body', () => {
    const body = 'Story: docs/stories/epic-8/8.1-gate-hardening.md\n\n## TL;DR\n\nBody.\n';
    expect(parseStoryRef(body)?.story_path).toBe('docs/stories/epic-8/8.1-gate-hardening.md');
  });

  it('returns null for a spec-based issue', () => {
    const body = 'Spec: docs/superpowers/specs/2026-05-01-a-design.md\nPlan: docs/superpowers/plans/2026-05-01-a.md\n';
    expect(parseStoryRef(body)).toBeNull();
  });

  it('ignores a path inside a fenced block', () => {
    // Same rule the spec parser applies: an example in the body is not the
    // reference the workflow will act on.
    const body = 'Intro\n\n```\nStory: docs/stories/epic-8/8.1-example.md\n```\n';
    expect(parseStoryRef(body)).toBeNull();
  });

  it('ignores a path inside backticks', () => {
    expect(parseStoryRef('Story: `docs/stories/epic-8/8.1-x.md`\n')).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(parseStoryRef(null)).toBeNull();
    expect(parseStoryRef('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && npx vitest run __tests__/lib/spec-approval-gate.test.ts -t parseStoryRef`
Expected: FAIL — `parseStoryRef is not exported`.

- [ ] **Step 3: Implement, reusing the existing fence stripping**

`parseSpecRefs` already strips fenced blocks and backtick spans before matching. Extract that into a helper so both parsers use one implementation rather than two that can diverge:

```typescript
/**
 * Strip fenced blocks and inline backtick spans from an issue body.
 *
 * Both reference parsers run against this, so a path quoted inside an example
 * cannot outrank the canonical link — and, more importantly, cannot differ
 * between the two parsers.
 *
 * Only fences that actually close are stripped. A stray opener with no partner
 * would otherwise swallow the rest of the body, including the real reference.
 *
 * @param body - The issue body.
 * @returns The body with quoted regions removed.
 */
function stripQuotedRegions(body: string): string {
  const lines = body.split(/\r?\n/);
  const fences = lines.flatMap((line, i) => (/^ {0,3}(```|~~~)/.test(line) ? [i] : []));
  const stripped = new Set<number>();
  for (let i = 0; i + 1 < fences.length; i += 2) {
    for (let n = fences[i]; n <= fences[i + 1]; n++) stripped.add(n);
  }
  return lines
    .filter((_line, i) => !stripped.has(i))
    .join('\n')
    .replace(/`[^`]*`/g, '');
}

/** The story a handoff issue declares. */
export interface StoryRef {
  /** Repo-relative path to the story. */
  story_path: string;
}

/**
 * Pull the `Story:` path out of a handoff issue body.
 *
 * A story-based issue carries `Story:` where a spec-based issue carries
 * `Spec:` and `Plan:`. The gate branches on which is present, so this
 * returning null is how a spec issue is recognised, not an error.
 *
 * @param body - The issue body, or null for an empty issue.
 * @returns The declared story, or null when there is no `Story:` line.
 */
export function parseStoryRef(body: string | null | undefined): StoryRef | null {
  if (!body) return null;
  const story = stripQuotedRegions(body).match(/^\s*Story:\s*(\S+\.md)\s*$/m)?.[1];
  return story ? { story_path: story } : null;
}
```

Rewrite `parseSpecRefs` to call `stripQuotedRegions` instead of doing its own stripping. Do not change its behaviour.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && npx vitest run __tests__/lib/spec-approval-gate.test.ts`
Expected: PASS, including every pre-existing `parseSpecRefs` test — the refactor must not change its behaviour.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/spec-approval-gate.ts dashboard/__tests__/lib/spec-approval-gate.test.ts
git commit -m "feat(gate): parse a Story: reference, sharing the spec parser's quote stripping"
```

---

### Task 3: Route the dashboard gate by issue kind

**Files:**
- Modify: `dashboard/lib/spec-approval-gate.ts`
- Modify: `dashboard/__tests__/lib/spec-approval-gate.test.ts`

**Interfaces:**
- Consumes: `parseStoryRef` from Task 2; `hashStory`, `approvalPathForStory`, `storyDispatchGateDecision` from `./story-approval`.
- Produces: no signature change to `evaluateSpecApproval`; it gains a story branch.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to dashboard/__tests__/lib/spec-approval-gate.test.ts
import { evaluateSpecApproval } from '@/lib/spec-approval-gate';
import { hashStory } from '@/lib/story-approval';

const STORY = 'docs/stories/epic-8/8.1-gate-hardening.md';
const STORY_TEXT = '# Story 8.1\n\n**Status:** Approved\n**Source spec:** docs/superpowers/specs/2026-07-09-p-design.md\n\nBody.\n';
const STORY_BODY = `Story: ${STORY}\n\n## TL;DR\n\nImplementing it.\n`;

/** Serve a path-to-content map, 404ing anything absent. */
function octokitFor(files: Record<string, string>) {
  return {
    repos: {
      getContent: vi.fn(async ({ path }: { path: string }) => {
        const content = files[path];
        if (content === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: { content: Buffer.from(content, 'utf8').toString('base64') } };
      }),
    },
  } as unknown as Parameters<typeof evaluateSpecApproval>[0]['octokit'];
}

/** A story approval whose hash matches STORY_TEXT. */
function storyApproval(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    kind: 'story',
    story_path: STORY,
    story_sha256: hashStory(STORY_TEXT),
    source_spec_path: 'docs/superpowers/specs/2026-07-09-p-design.md',
    source_spec_sha256: 'a'.repeat(64),
    review_verdict: 'ok',
    review_rounds: 1,
    approved_by: 'ali@example.com',
    approved_at: '2026-09-12T10:00:00.000Z',
    ...over,
  });
}

describe('evaluateSpecApproval — story issues', () => {
  const APPROVAL = 'docs/stories/epic-8/8.1-gate-hardening.approval.json';

  it('allows a story whose approval still matches', async () => {
    const d = await evaluateSpecApproval({
      octokit: octokitFor({ [STORY]: STORY_TEXT, [APPROVAL]: storyApproval() }),
      owner: 'q', repo: 'r', ref: 'main', issueBody: STORY_BODY, labels: [],
    });
    expect(d.allow).toBe(true);
  });

  it('refuses a story edited after approval', async () => {
    const d = await evaluateSpecApproval({
      octokit: octokitFor({ [STORY]: STORY_TEXT.replace('Body.', 'Edited.'), [APPROVAL]: storyApproval() }),
      owner: 'q', repo: 'r', ref: 'main', issueBody: STORY_BODY, labels: [],
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('spec-changed');
  });

  it('allows a story whose status line alone moved on', async () => {
    const moved = STORY_TEXT.replace('**Status:** Approved', '**Status:** InProgress');
    const d = await evaluateSpecApproval({
      octokit: octokitFor({ [STORY]: moved, [APPROVAL]: storyApproval() }),
      owner: 'q', repo: 'r', ref: 'main', issueBody: STORY_BODY, labels: [],
    });
    expect(d.allow).toBe(true);
  });

  it('refuses when the story file itself is gone', async () => {
    const d = await evaluateSpecApproval({
      octokit: octokitFor({ [APPROVAL]: storyApproval() }),
      owner: 'q', repo: 'r', ref: 'main', issueBody: STORY_BODY, labels: [],
    });
    expect(d.allow).toBe(false);
  });

  it('refuses rather than reporting absence when a read fails', async () => {
    // A 500 is not a missing approval. Reading it as one would dispatch work
    // nobody approved, which is the failure this gate exists to prevent.
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
      },
    } as unknown as Parameters<typeof evaluateSpecApproval>[0]['octokit'];
    const d = await evaluateSpecApproval({
      octokit, owner: 'q', repo: 'r', ref: 'main', issueBody: STORY_BODY, labels: [],
    });
    expect(d.allow).toBe(false);
  });

  it('still refuses an issue carrying neither reference', async () => {
    const d = await evaluateSpecApproval({
      octokit: octokitFor({}), owner: 'q', repo: 'r', ref: 'main',
      issueBody: '## TL;DR\n\nNo references.\n', labels: [],
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('missing');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && npx vitest run __tests__/lib/spec-approval-gate.test.ts -t "story issues"`
Expected: FAIL — a story issue currently hits the "no `Spec:` line" refusal.

- [ ] **Step 3: Add the story branch**

At the top of `evaluateSpecApproval`, before the existing `parseSpecRefs` call:

```typescript
  // A story-based issue is checked against the story alone. Its source spec
  // was a precondition when the story was approved and is lineage afterwards,
  // so re-reading it here would let one late amendment to a program spec
  // invalidate every story derived from it.
  const storyRef = parseStoryRef(issueBody);
  if (storyRef) {
    const storyText = await readRepoFile(octokit, owner, repo, storyRef.story_path, ref);
    if (storyText === null) {
      return resolveRefusal(
        'missing',
        `the issue names ${storyRef.story_path}, which is not on ${ref}. Check the story ` +
          'was committed before the issue was filed.',
        overrideRequested,
      );
    }
    const approvalRaw = await readRepoFile(
      octokit, owner, repo, approvalPathForStory(storyRef.story_path), ref,
    );
    return storyDispatchGateDecision({
      approvalRaw,
      currentStoryHash: hashStory(storyText),
      storyPath: storyRef.story_path,
      overrideRequested,
    });
  }
```

Use the module's existing repo-read helper. **Confirm before you write:** that helper must return `null` only on a 404 and throw on anything else. If it swallows other statuses, fix that first — a 500 read as absence dispatches unapproved work. Read it and say which it does in your report.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && npx vitest run __tests__/lib/spec-approval-gate.test.ts`
Expected: PASS, including every pre-existing spec-issue test.

- [ ] **Step 5: Run the whole dashboard suite**

Run: `cd dashboard && npx tsc --noEmit && npx vitest run`
Expected: clean and green.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/spec-approval-gate.ts dashboard/__tests__/lib/spec-approval-gate.test.ts
git commit -m "feat(gate): route a story issue to the story gate, which never reads the spec"
```

---

### Task 4: Teach the workflow-side check about stories

The dashboard gate is a courtesy to the operator; this is the enforcement. A dispatch from `gh workflow run`, a consumer's own wrapper, or a re-run from the Actions tab reaches the workflow without passing the dashboard at all.

**Files:**
- Modify: `lib/cli/verify-approval.ts`
- Modify: `tests/unit/verify-approval.test.ts`

**Interfaces:**
- Consumes: `hashStory`, `approvalPathForStory`, `storyDispatchGateDecision` from `../story-approval`.
- Produces: `STORY_PATH` env support. `SPEC_PATH` and `STORY_PATH` are mutually exclusive.

- [ ] **Step 1: Write the failing tests**

Read the existing tests in `tests/unit/verify-approval.test.ts` first and follow their shape for building a temp repo. Add:

```typescript
describe('verify-approval — story issues', () => {
  it('passes a story whose approval still matches', () => {
    // build a temp repo with the story and a matching approval, run with
    // STORY_PATH set, assert the verdict allows
  });

  it('refuses a story edited after approval', () => {
    // same, with the story text changed after the approval was written
  });

  it('allows a story whose status line alone moved on', () => {
    // the projection must not invalidate the approval it came from
  });

  it('refuses when both SPEC_PATH and STORY_PATH are set', () => {
    // an issue is one kind or the other; being handed both means the
    // workflow resolved something it should not have, and guessing which
    // to honour is how the wrong document gets approved
  });

  it('refuses when neither is set', () => {
    // usage error, exit 2
  });
});
```

Write each body out in full, following the existing tests' helpers.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/verify-approval.test.ts`
Expected: FAIL — `STORY_PATH` is ignored.

- [ ] **Step 3: Implement the branch**

Add `STORY_PATH` to the documented env contract in the file's header docblock. In the entry point: if both `SPEC_PATH` and `STORY_PATH` are set, exit 2 with a usage error naming both. If `STORY_PATH` is set, read the story, hash it, read `approvalPathForStory(...)`, and call `storyDispatchGateDecision`. Otherwise keep today's spec path untouched.

Reads follow the same rule as everywhere else: a file that is not there is `null`; a read that failed for any other reason throws rather than being reported as absence.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/verify-approval.test.ts && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/cli/verify-approval.ts tests/unit/verify-approval.test.ts
git commit -m "feat(approval): enforce a story approval workflow-side, not only in the dashboard"
```

---

### Task 5: Resolve a story in the implement workflow

**Files:**
- Modify: `.github/workflows/phase-implement.yml`
- Modify: `tests/unit/workflows.test.ts`

**Interfaces:**
- Consumes: `STORY_PATH` support from Task 4.
- Produces: a `story_path` step output, passed to the approval check and the prompt.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/unit/workflows.test.ts, in the phase-implement describe
describe('phase-implement.yml — story issues', () => {
  const raw = readFileSync(resolve(workflowsDir, 'phase-implement.yml'), 'utf8');

  it('resolves a Story: reference before falling back to a spec', () => {
    // A Story: line names a docs/**/*.md path that exists, so the existing
    // spec grep would otherwise claim it and hand a story to the spec gate,
    // which refuses it as malformed with a misleading message.
    expect(raw).toMatch(/Story:\s*\\\?\[/);
    expect(raw).toMatch(/story_path=/);
  });

  it('passes the story path to the approval check instead of a spec path', () => {
    const verifyStep = raw.slice(raw.indexOf('- name: Verify spec approval'));
    expect(verifyStep.slice(0, 600)).toMatch(/STORY_PATH:/);
  });

  it('feeds the story to the agent as its context bundle', () => {
    expect(raw).toMatch(/steps\.issue\.outputs\.story_path/);
  });
});
```

Adjust the first assertion's regex once you see how the resolution is written; the requirement is that a `Story:` reference is resolved and exported as `story_path`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/workflows.test.ts -t "story issues"`
Expected: FAIL.

- [ ] **Step 3: Resolve the story first, then fall back**

In the "Read issue" step, **before** the existing spec resolution, add:

```bash
          # A Story: line wins over the spec fallback. The existing spec grep
          # matches any docs/**/*.md that exists, so without this a story issue
          # resolves the story AS the spec and the approval check then reads a
          # story approval through the spec path and refuses it as malformed —
          # fail-closed, but with a message that sends the operator the wrong way.
          STORY_PATH=$(printf '%s' "$BODY" | grep -oE '^[[:space:]]*Story:[[:space:]]*[^[:space:]]+\.md' | head -1 | sed -E 's/^[[:space:]]*Story:[[:space:]]*//' || true)
          if [ -n "$STORY_PATH" ] && [ ! -f "$STORY_PATH" ]; then
            echo "::error::the issue names $STORY_PATH, which is not on this branch"
            exit 1
          fi
```

Then guard the spec and plan resolution with `if [ -z "$STORY_PATH" ]; then ... fi`, and export `story_path` alongside the others. Pass `STORY_PATH` to the "Verify spec approval" step's env, and use the story path as the prompt's context document when it is set.

A story issue must NOT create the `placeholder-no-spec.md` file — that fallback exists for legacy spec issues.

- [ ] **Step 4: Run the tests and validate the YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/phase-implement.yml')); print('YAML OK')"
npx vitest run tests/unit/workflows.test.ts
npx vitest run
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/phase-implement.yml tests/unit/workflows.test.ts
git commit -m "feat(implement): resolve a story issue as a story, not as a spec"
```

---

### Task 6: The intake's second door

**Files:**
- Modify: `skills/start-feature/SKILL.md`
- Modify: `tests/unit/skills.test.ts`

**Interfaces:**
- Consumes: `approve-story` (built in slice 2).
- Produces: documented behaviour only.

- [ ] **Step 1: Write the failing tests**

Read `tests/unit/skills.test.ts` first and follow its existing assertion style. Add assertions that `skills/start-feature/SKILL.md`:

- documents a branch taken when the work is already a written story, which skips the brainstorming and plan-writing phases
- names `approve-story` as the command for that branch, and `approve-spec` for the other
- carries the same prohibition for `approve-story` that it carries for `approve-spec` — never run on the user's behalf
- files an issue whose body carries `Story:` and whose labels include an `epic:` label
- states that a story issue carries no `Plan:` line

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/skills.test.ts`
Expected: FAIL on each new assertion.

- [ ] **Step 3: Write the second door**

Add a section to the skill describing the story path: the user names an already-sharded story; the skill reads its `Source spec:` line, confirms that spec carries a clean approval, runs the derivation review, and asks the user to approve. It then files:

```bash
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

Include the `gh label create ... --force` fallback the existing door has, extended to the `epic:` label.

The prohibition must read as strongly as the existing one: **never run `approve-story` on the user's behalf.** `approved_by` records a human's identity against work they authorised.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/skills.test.ts && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/start-feature/SKILL.md tests/unit/skills.test.ts
git commit -m "feat(intake): a second door for work that is already a sharded story"
```

---

## Acceptance criteria covered

| AC | Task |
|---|---|
| AC-16 | 6 (the door and the issue it files) |
| AC-17 | 5 (the workflow resolves and feeds the story) |
| Parked ruling from slice 1 | 1 |
| Gate and enforcement plumbing AC-16/17 depend on | 2, 3, 4 |

AC-12, AC-13, AC-14 and AC-15 belong to slice 4.

## Notes for the executor

- `APPROVED_BY` records a human's identity. Never run `approve-story` on the user's behalf, for the same reason `approve-spec` carries that rule.
- Task 3 asks you to confirm the dashboard's repo-read helper throws on non-404 errors rather than returning null. Say which it does in your report even if no change is needed — that property is load-bearing and has been wrong three times in this repo.
- Tasks 1 and 3 touch mirrored modules. Re-copy and `cmp` in the same task, or the drift test fails in the next one.

## What slice 4 needs decided first — DECIDED 2026-09-12

**Two lists.** The panel grows a second section: approved specs in one, approved
stories in the other, and the operator chooses which kind of thing they are
starting. `SpecPair` keeps its shape and a parallel story type sits beside it,
rather than both being forced into one neutral type.

That settles the rest of slice 4's shape: `dispatchFromSpec` keeps taking
`spec_path` and `plan_path` untouched, and a sibling action takes `story_path`.
No existing pipeline is refactored to accommodate stories.

The reasoning that led there is kept below, because a future reader will want to
know which alternatives were weighed.

---

Slice 4 rests on a design decision that should be made deliberately rather than invented inside a plan.

The dashboard's picker is built on `SpecPair`, which is spec-and-plan shaped all the way through: a `specPath`, a `planPath`, a dated `YYYY-MM-DD-<topic>` slug, and a title derived from that slug. `pairSpecsAndPlans` matches specs to plans on that slug; `verifySpecPairs` re-derives approval through the spec gate; the panel renders "(no plan)" and the server action submits `spec_path` and `plan_path`.

A story has none of that shape. It has a path, no plan, an epic, an identifier like `8.1`, a title that lives in its `# Story 8.1 — Name` heading rather than in a slug, and an approval of a different kind.

Three ways to reconcile it, and they differ in what the operator sees:

1. **One list, one neutral type.** Generalise to a "startable item" both map into. One dropdown mixing specs and stories, which is simplest for you and the largest refactor.
2. **Two lists, two pipelines.** The panel grows a second section. Smallest change to existing code, and the operator chooses which kind of thing they are starting.
3. **Stories only, once adopted.** A repo using stories stops offering specs in the picker. Cleanest end state, worst migration.

That choice also settles what `dispatchFromSpec` receives, since it currently takes `spec_path` and `plan_path`. It wants a short brainstorm, not a guess.
