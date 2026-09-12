# Story-level approval — Implementation Plan (slices 1 and 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A story file can carry its own hash-bound approval record, and the dispatch gate understands it.

**Architecture:** A new `lib/story-approval.ts` module, mirrored into `dashboard/lib/story-approval.ts`, sitting beside the existing spec-approval module and importing its shared pieces. The story record is a disjoint shape from the spec record, so neither parser can read the other's file. The story hash deliberately excludes the `**Status:**` header line, because dev-agent rewrites that line as a projection and hashing it would make the first projection invalidate the approval.

**Tech Stack:** TypeScript (strict), Node crypto, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-12-story-level-approval-design.md`

## Scope of this plan

The spec's delivery order has four slices. This plan covers **slices 1 and 2 only**:

- Slice 1 — the record and the gate (AC-1, AC-4 to AC-11, AC-18, AC-19)
- Slice 2 — the approval act (AC-2, AC-3)

At the end of this plan a story can be approved and the gate will accept or refuse it correctly. Nothing dispatches a story yet, and nothing regresses: no existing code path changes behaviour.

Slices 3 and 4 (the intake door, implement resolution, the picker, status projection — AC-12 to AC-17) get their own plan once these land. They depend on decisions that are cheaper to make against working code than to guess at now.

## Global Constraints

- TypeScript strict; zero `any` without an inline justification comment.
- 100% docstring coverage on every exported symbol: what it does, its inputs, what it returns or throws. Never restate the signature.
- `dashboard/lib/story-approval.ts` must stay byte-identical to `lib/story-approval.ts`. The dashboard deploys with `rootDirectory=dashboard/`, so the copy is what ships.
- `SPEC_APPROVAL_SCHEMA_VERSION` must remain `1`. Bumping it makes every new approval refuse as `schema-too-new` on dashboards deployed before the engine rolls out.
- A read that fails for any reason other than "not found" must never be reported as absence.
- Engine tests: `tests/unit/**`, run with `npx vitest run tests/unit/<file>`.
- Never run `approve-story` on the user's behalf, for the same reason `approve-spec` carries that rule: `approved_by` records a human's identity against work they authorised.

## File Structure

| File | Responsibility |
|---|---|
| `lib/story-approval.ts` (create) | Story record shape, canonicalisation, hashing, parsing, gate |
| `dashboard/lib/story-approval.ts` (create) | Byte-identical mirror; what the dashboard ships |
| `lib/cli/approve-story.ts` (create) | The approval act: preconditions, record, status stamp |
| `tests/unit/story-approval.test.ts` (create) | Slice 1 tests |
| `tests/unit/approve-story.test.ts` (create) | Slice 2 tests |
| `tests/unit/spec-approval.test.ts` (modify) | Add the schema-version and legacy-record guards |

---

### Task 1: Story hashing and canonicalisation

**Files:**
- Create: `lib/story-approval.ts`
- Create: `tests/unit/story-approval.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `storyBodyForHashing(storyText: string): string`, `hashStory(storyText: string): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/story-approval.test.ts
import { describe, it, expect } from 'vitest';
import { storyBodyForHashing, hashStory } from '../../lib/story-approval';
import { hashSpecAndPlan } from '../../lib/spec-approval';

const STORY = [
  '# Story 8.1 — Commitment Gate Hardening',
  '',
  '**Status:** Draft',
  '**Epic:** 8 — Agent Reliability',
  '**Source spec:** `docs/superpowers/specs/2026-07-09-agent-reliability-program-design.md`',
  '',
  '## Story',
  '',
  'As a customer I want a truthful reply.',
  '',
].join('\n');

describe('storyBodyForHashing', () => {
  it('removes the status line, which dev-agent rewrites as a projection', () => {
    // Hashing the status line would make the first projection invalidate the
    // approval it was projected from, and the gate would then refuse every
    // later read of the story.
    expect(storyBodyForHashing(STORY)).not.toContain('**Status:**');
    expect(storyBodyForHashing(STORY)).toContain('**Epic:** 8 — Agent Reliability');
  });

  it('removes only the first status line', () => {
    const twice = STORY + '\n**Status:** Done\n';
    const body = storyBodyForHashing(twice);
    expect(body).toContain('**Status:** Done');
  });

  it('accepts the status spellings the conformance check accepts', () => {
    for (const line of ['**Status:** Approved', '**Status**: Approved', 'Status: Approved']) {
      const doc = `# S\n\n${line}\n\nbody\n`;
      expect(storyBodyForHashing(doc)).not.toMatch(/Status/);
    }
  });
});

describe('hashStory', () => {
  it('is unchanged by a status transition', () => {
    const draft = STORY;
    const done = STORY.replace('**Status:** Draft', '**Status:** Done');
    expect(hashStory(done)).toBe(hashStory(draft));
  });

  it('changes when any other line changes', () => {
    const edited = STORY.replace('a truthful reply', 'a different reply');
    expect(hashStory(edited)).not.toBe(hashStory(STORY));
  });

  it('does not collide with a planless spec over the same text', () => {
    // Domain separation. Without mixing the kind into the digest, a story and
    // a planless spec over identical bytes produce the same hash.
    const body = storyBodyForHashing(STORY);
    expect(hashStory(STORY)).not.toBe(hashSpecAndPlan(body, null));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/story-approval.test.ts`
Expected: FAIL — `Failed to resolve import "../../lib/story-approval"`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// lib/story-approval.ts
import { createHash } from 'node:crypto';

/**
 * Approval of a sharded story, as stored on disk beside the story file.
 *
 * A story is the unit an implement agent actually reads, so the story text is
 * what the hash must protect. Its source spec is recorded as lineage: it must
 * carry a clean approval when the story is approved, and is not consulted
 * afterwards, so one late amendment to a program spec cannot invalidate every
 * story derived from it.
 *
 * The engine writes this file (see `lib/cli/approve-story.ts`); the dashboard
 * reads it (see `dashboard/lib/story-approval.ts`, a mirrored copy kept aligned
 * by the drift test in `tests/unit/story-approval.test.ts`).
 */

/** Domain tag mixed into the digest so a story cannot collide with a spec. */
const KIND = 'story';

/**
 * Separator between the domain tag and the document.
 *
 * Written as an escape sequence, never as a literal control character in
 * source. `lib/spec-approval.ts:103` carries the same value for the same
 * reason.
 */
const SEPARATOR = '\u0000';

/**
 * Matches the story's status header in the spellings the kit's conformance
 * check accepts (`check.sh`): bare, bold-label, and bold-with-colon forms.
 */
const STATUS_LINE_RE =
  /^[ \t>-]*\*{0,2}Status\*{0,2}:?\*{0,2}:?[ \t]*(?:Draft|Approved|In ?Progress|Review|Done|Blocked)\*{0,2}[ \t]*$/im;

/**
 * Strip the status header from a story before hashing it.
 *
 * dev-agent rewrites that line as the issue moves, so it is a projection of
 * the issue state rather than part of what was approved. Including it in the
 * digest would mean the first projection invalidated the approval it came
 * from, and `storyDispatchGateDecision` would then refuse every later read.
 *
 * Only the first matching line is removed; a second one is content.
 *
 * @param storyText - Full story file contents.
 * @returns The story with its status header removed.
 */
export function storyBodyForHashing(storyText: string): string {
  return storyText.replace(STATUS_LINE_RE, '').replace(/^\n/, '');
}

/**
 * Hash the approved content of a story.
 *
 * @param storyText - Full story file contents, status header included.
 * @returns Lowercase hex sha256 over the domain tag and the canonical body.
 */
export function hashStory(storyText: string): string {
  return createHash('sha256')
    .update(KIND, 'utf8')
    .update(SEPARATOR, 'utf8')
    .update(storyBodyForHashing(storyText), 'utf8')
    .digest('hex');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/story-approval.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/story-approval.ts tests/unit/story-approval.test.ts
git commit -m "feat(approval): hash a story's content, excluding its projected status line"
```

---

### Task 2: The story approval record and its parser

**Files:**
- Modify: `lib/story-approval.ts`
- Modify: `tests/unit/story-approval.test.ts`

**Interfaces:**
- Consumes: `hashStory` from Task 1; `ReviewVerdict` from `lib/spec-approval.ts`.
- Produces: `STORY_APPROVAL_SCHEMA_VERSION: number`, `StoryApproval` interface, `StoryParseResult`, `parseStoryApproval(raw: string): StoryParseResult`, `approvalPathForStory(storyPath: string): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/unit/story-approval.test.ts
import { parseStoryApproval, approvalPathForStory } from '../../lib/story-approval';
import { parseSpecApproval } from '../../lib/spec-approval';

const STORY_PATH = 'docs/stories/epic-8-agent-reliability/8.1-gate-hardening.md';
const SPEC_PATH = 'docs/superpowers/specs/2026-07-09-agent-reliability-program-design.md';

/** A well-formed story approval, overridable field by field. */
function record(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    kind: 'story',
    story_path: STORY_PATH,
    story_sha256: 'a'.repeat(64),
    source_spec_path: SPEC_PATH,
    source_spec_sha256: 'b'.repeat(64),
    review_verdict: 'ok',
    review_rounds: 1,
    approved_by: 'ali@example.com',
    approved_at: '2026-09-12T10:00:00.000Z',
    ...over,
  });
}

describe('approvalPathForStory', () => {
  it('names the artifact beside the story', () => {
    expect(approvalPathForStory(STORY_PATH)).toBe(
      'docs/stories/epic-8-agent-reliability/8.1-gate-hardening.approval.json',
    );
  });
});

describe('parseStoryApproval', () => {
  it('accepts a well-formed record', () => {
    const parsed = parseStoryApproval(record());
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ['kind', { kind: 'spec' }],
    ['story_path', { story_path: '' }],
    ['story_sha256', { story_sha256: 'not-a-digest' }],
    ['source_spec_path', { source_spec_path: '' }],
    ['source_spec_sha256', { source_spec_sha256: 'nope' }],
    ['review_verdict', { review_verdict: 'maybe' }],
    ['review_rounds', { review_rounds: 0 }],
  ])('rejects a bad %s', (field, over) => {
    const parsed = parseStoryApproval(record(over));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(field);
  });

  it('rejects text that is not JSON', () => {
    const parsed = parseStoryApproval('{ truncated');
    expect(parsed.ok).toBe(false);
  });

  it('cannot read a spec approval, and the spec parser cannot read this one', () => {
    // The two shapes are disjoint by field name, which is what makes a story
    // record unable to authorise a spec dispatch or the reverse.
    const specRecord = JSON.stringify({
      schema_version: 1,
      spec_path: SPEC_PATH,
      plan_path: null,
      spec_sha256: 'c'.repeat(64),
      review_verdict: 'ok',
      review_rounds: 1,
      approved_by: 'ali@example.com',
      approved_at: '2026-09-12T10:00:00.000Z',
    });
    expect(parseStoryApproval(specRecord).ok).toBe(false);
    expect(parseSpecApproval(record()).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/story-approval.test.ts`
Expected: FAIL — `parseStoryApproval is not exported`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// append to lib/story-approval.ts
import type { ReviewVerdict } from './spec-approval';

/** Schema version of the story approval artifact; bump on a breaking change. */
export const STORY_APPROVAL_SCHEMA_VERSION = 1;

/** A recorded human approval of a sharded story, as stored on disk. */
export interface StoryApproval {
  /** Schema version of this record. */
  schema_version: number;
  /** Discriminator. Always `story`; a spec record has no such field. */
  kind: 'story';
  /** Repo-relative path of the story that was approved. */
  story_path: string;
  /** sha256 over the story's canonical body at approval time. */
  story_sha256: string;
  /** Repo-relative path of the spec this story was derived from. */
  source_spec_path: string;
  /** That spec's hash at approval time. Evidence of lineage, not a constraint. */
  source_spec_sha256: string;
  /** The derivation review's verdict the approval was given against. */
  review_verdict: ReviewVerdict;
  /** How many review-and-correct rounds it took to reach that verdict. */
  review_rounds: number;
  /** Who approved, for the audit trail (git identity of the intake session). */
  approved_by: string;
  /** ISO-8601 timestamp of the approval. */
  approved_at: string;
}

/** Result of reading a story approval artifact. */
export type StoryParseResult =
  | { ok: true; approval: StoryApproval }
  | { ok: false; error: string };

const VERDICTS: readonly string[] = ['ok', 'concerns', 'blocker'];
const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Name the approval artifact that sits beside a story.
 *
 * @param storyPath - Repo-relative path to the story.
 * @returns The same path with `.md` replaced by `.approval.json`.
 */
export function approvalPathForStory(storyPath: string): string {
  return `${storyPath.replace(/\.md$/, '')}.approval.json`;
}

/**
 * Parse and validate a story approval artifact's JSON text.
 *
 * Fails closed on anything it cannot fully understand. A half-read approval is
 * not an approval, and the `kind` check is what stops a spec record being read
 * through this path.
 *
 * @param raw - Raw file contents.
 * @returns The parsed approval, or the reason it was rejected.
 */
export function parseStoryApproval(raw: string): StoryParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'expected a JSON object' };
  }
  const o = value as Record<string, unknown>;

  if (o.kind !== 'story') {
    return { ok: false, error: "kind must be 'story'" };
  }
  if (!Number.isInteger(o.schema_version) || (o.schema_version as number) < 1) {
    return { ok: false, error: 'schema_version must be a positive integer' };
  }
  for (const key of ['story_path', 'source_spec_path', 'approved_by', 'approved_at'] as const) {
    const v = o[key];
    if (typeof v !== 'string' || v.trim() === '') {
      return { ok: false, error: `${key} must be a non-empty string` };
    }
  }
  for (const key of ['story_sha256', 'source_spec_sha256'] as const) {
    if (typeof o[key] !== 'string' || !DIGEST_RE.test(o[key] as string)) {
      return { ok: false, error: `${key} must be a 64-character lowercase hex digest` };
    }
  }
  if (typeof o.review_verdict !== 'string' || !VERDICTS.includes(o.review_verdict)) {
    return { ok: false, error: `review_verdict must be one of ${VERDICTS.join(', ')}` };
  }
  if (!Number.isInteger(o.review_rounds) || (o.review_rounds as number) < 1) {
    return { ok: false, error: 'review_rounds must be an integer >= 1' };
  }
  return { ok: true, approval: o as unknown as StoryApproval };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/story-approval.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/story-approval.ts tests/unit/story-approval.test.ts
git commit -m "feat(approval): story approval record, disjoint from the spec record"
```

---

### Task 3: The story dispatch gate

**Files:**
- Modify: `lib/story-approval.ts`
- Modify: `tests/unit/story-approval.test.ts`

**Interfaces:**
- Consumes: `hashStory`, `parseStoryApproval`, `approvalPathForStory`; `DispatchGateDecision`, `GateReason`, `resolveRefusal` from `lib/spec-approval.ts`.
- Produces: `storyDispatchGateDecision(input: { approvalRaw: string | null; currentStoryHash: string; storyPath: string; overrideRequested?: boolean }): DispatchGateDecision`.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/unit/story-approval.test.ts
import { storyDispatchGateDecision, hashStory as h } from '../../lib/story-approval';

const OK_HASH = h(STORY);

/** A record whose hash matches STORY. */
const approved = (over: Record<string, unknown> = {}) =>
  record({ story_sha256: OK_HASH, ...over });

describe('storyDispatchGateDecision', () => {
  it('allows a story that still matches its approval', () => {
    const d = storyDispatchGateDecision({
      approvalRaw: approved(),
      currentStoryHash: OK_HASH,
      storyPath: STORY_PATH,
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('ok');
  });

  it('refuses when no approval was recorded', () => {
    const d = storyDispatchGateDecision({
      approvalRaw: null,
      currentStoryHash: OK_HASH,
      storyPath: STORY_PATH,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('missing');
    expect(d.message).toContain('8.1-gate-hardening.approval.json');
  });

  it('refuses a record it cannot read', () => {
    const d = storyDispatchGateDecision({
      approvalRaw: '{ truncated',
      currentStoryHash: OK_HASH,
      storyPath: STORY_PATH,
    });
    expect(d.reason).toBe('malformed');
  });

  it('refuses a schema newer than this code understands', () => {
    const d = storyDispatchGateDecision({
      approvalRaw: approved({ schema_version: 99 }),
      currentStoryHash: OK_HASH,
      storyPath: STORY_PATH,
    });
    expect(d.reason).toBe('schema-too-new');
  });

  it('refuses a verdict that is not ok', () => {
    const d = storyDispatchGateDecision({
      approvalRaw: approved({ review_verdict: 'concerns' }),
      currentStoryHash: OK_HASH,
      storyPath: STORY_PATH,
    });
    expect(d.reason).toBe('unclean-verdict');
  });

  it('refuses an approval that names a different story', () => {
    const d = storyDispatchGateDecision({
      approvalRaw: approved({ story_path: 'docs/stories/epic-8/8.2-other.md' }),
      currentStoryHash: OK_HASH,
      storyPath: STORY_PATH,
    });
    expect(d.reason).toBe('path-mismatch');
  });

  it('refuses a story edited after approval', () => {
    const d = storyDispatchGateDecision({
      approvalRaw: approved(),
      currentStoryHash: h(STORY.replace('truthful', 'different')),
      storyPath: STORY_PATH,
    });
    expect(d.reason).toBe('spec-changed');
  });

  it('allows a story whose status line moved on', () => {
    // The projection must not invalidate the approval it was projected from.
    const d = storyDispatchGateDecision({
      approvalRaw: approved(),
      currentStoryHash: h(STORY.replace('**Status:** Draft', '**Status:** Review')),
      storyPath: STORY_PATH,
    });
    expect(d.allow).toBe(true);
  });

  it('does not consult the source spec', () => {
    // The asymmetry: the spec was a precondition at approval time and is
    // lineage afterwards. A spec amended later must not kill a running story.
    const d = storyDispatchGateDecision({
      approvalRaw: approved({ source_spec_sha256: 'f'.repeat(64) }),
      currentStoryHash: OK_HASH,
      storyPath: STORY_PATH,
    });
    expect(d.allow).toBe(true);
  });

  it('lets the override label through, on the record', () => {
    const d = storyDispatchGateDecision({
      approvalRaw: null,
      currentStoryHash: OK_HASH,
      storyPath: STORY_PATH,
      overrideRequested: true,
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('override');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/story-approval.test.ts`
Expected: FAIL — `storyDispatchGateDecision is not exported`.

- [ ] **Step 3: Add `path-mismatch` to `GateReason`, then implement**

First widen the shared reason union in **both** copies of the spec-approval module:

```typescript
// lib/spec-approval.ts — add to the GateReason union
  | 'path-mismatch'
```

Then append the gate. Note the import goes at the top of the file with the
others, not at the append point:

```typescript
// lib/story-approval.ts — add to the existing import from './spec-approval'
import { resolveRefusal, type DispatchGateDecision, type GateReason } from './spec-approval';

/**
 * Decide whether a story may be dispatched.
 *
 * Checks the approval exists, is readable, is a schema this code understands,
 * carries a clean verdict, names this story, and still matches its text. It
 * deliberately does not read the source spec: the spec was a precondition when
 * the story was approved, and consulting it here would let one late amendment
 * invalidate every story derived from it.
 *
 * @param input.approvalRaw - The artifact's contents, or null when it is
 *   genuinely absent. A read that failed for any other reason must not be
 *   passed as null — the caller refuses instead.
 * @param input.currentStoryHash - `hashStory` over the story as it is now.
 * @param input.storyPath - Repo-relative path the issue names.
 * @param input.overrideRequested - Whether the override label is present.
 * @returns Whether to dispatch, why, and a message for the operator.
 */
export function storyDispatchGateDecision(input: {
  approvalRaw: string | null;
  currentStoryHash: string;
  storyPath: string;
  overrideRequested?: boolean;
}): DispatchGateDecision {
  const { approvalRaw, currentStoryHash, storyPath, overrideRequested } = input;
  const at = approvalPathForStory(storyPath);

  const refuse = (reason: GateReason, message: string): DispatchGateDecision =>
    resolveRefusal(reason, message, overrideRequested);

  if (approvalRaw === null) {
    return refuse(
      'missing',
      `no approval recorded at ${at}. Stories are approved in the Claude Code intake ` +
        'session, after the derivation review comes back clean. The dashboard starts ' +
        'approved work; it does not approve it.',
    );
  }

  const parsed = parseStoryApproval(approvalRaw);
  if (!parsed.ok) {
    return refuse(
      'malformed',
      `the approval at ${at} could not be read (${parsed.error}). Re-run the intake ` +
        'session to record a valid approval.',
    );
  }
  const approval = parsed.approval;

  if (approval.schema_version > STORY_APPROVAL_SCHEMA_VERSION) {
    return refuse(
      'schema-too-new',
      `the approval declares schema version ${approval.schema_version}, but this code ` +
        `understands up to ${STORY_APPROVAL_SCHEMA_VERSION}. Upgrade rather than guessing ` +
        'at fields it does not know.',
    );
  }
  if (approval.review_verdict !== 'ok') {
    return refuse(
      'unclean-verdict',
      `the approval was recorded against a '${approval.review_verdict}' derivation review. ` +
        'Correct the story, re-run the review until it is clean, and approve that result.',
    );
  }
  if (approval.story_path !== storyPath) {
    return refuse(
      'path-mismatch',
      `the approval at ${at} covers ${approval.story_path}, but the issue names ${storyPath}.`,
    );
  }
  if (approval.story_sha256 !== currentStoryHash) {
    return refuse(
      'spec-changed',
      'the story changed after approval, so the approval no longer covers what would be ' +
        'built. Re-run the review and approve the current text. (Its status line is ' +
        'excluded from the hash, so a status change is not what caused this.)',
    );
  }

  return { allow: true, reason: 'ok', message: `approved by ${approval.approved_by}` };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/story-approval.test.ts`
Expected: PASS, 26 tests.

- [ ] **Step 5: Run the full engine suite**

Run: `npx vitest run`
Expected: PASS. The `GateReason` widening is additive; nothing should regress.

- [ ] **Step 6: Commit**

```bash
git add lib/spec-approval.ts lib/story-approval.ts tests/unit/story-approval.test.ts
git commit -m "feat(approval): story dispatch gate, which does not consult the source spec"
```

---

### Task 4: The dashboard mirror and its drift test

**Files:**
- Create: `dashboard/lib/story-approval.ts`
- Modify: `tests/unit/story-approval.test.ts`
- Modify: `dashboard/lib/spec-approval.ts` (the `GateReason` widening from Task 3)

**Interfaces:**
- Consumes: everything from Tasks 1 to 3.
- Produces: nothing new — an identical copy.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/unit/story-approval.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('dashboard mirror', () => {
  it('is byte-identical to the engine copy', () => {
    // The dashboard deploys with rootDirectory=dashboard/, which excludes the
    // engine's lib/. The copy is what ships; this test is what keeps a fix to
    // one of them from silently missing the other.
    const root = resolve(__dirname, '../..');
    expect(readFileSync(resolve(root, 'dashboard/lib/story-approval.ts'), 'utf8')).toBe(
      readFileSync(resolve(root, 'lib/story-approval.ts'), 'utf8'),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/story-approval.test.ts -t "byte-identical"`
Expected: FAIL — `ENOENT: dashboard/lib/story-approval.ts`.

- [ ] **Step 3: Copy both modules across**

```bash
cp lib/story-approval.ts dashboard/lib/story-approval.ts
cp lib/spec-approval.ts dashboard/lib/spec-approval.ts
```

- [ ] **Step 4: Run the tests and the dashboard typecheck**

Run: `npx vitest run tests/unit/story-approval.test.ts`
Expected: PASS, 27 tests.

Run: `cd dashboard && npx tsc --noEmit && npx vitest run && cd ..`
Expected: PASS. The existing spec-approval drift test must also still pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/story-approval.ts dashboard/lib/spec-approval.ts tests/unit/story-approval.test.ts
git commit -m "feat(approval): mirror the story module into the dashboard, with a drift test"
```

---

### Task 5: Guard the spec schema version and legacy records

**Files:**
- Modify: `tests/unit/spec-approval.test.ts`

**Interfaces:**
- Consumes: `SPEC_APPROVAL_SCHEMA_VERSION`, `parseSpecApproval`.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/unit/spec-approval.test.ts
describe('rollout compatibility', () => {
  it('keeps the spec schema version at 1', () => {
    // Bumping it makes every newly written approval refuse as schema-too-new
    // on any dashboard deployed before the engine rolls out.
    expect(SPEC_APPROVAL_SCHEMA_VERSION).toBe(1);
  });

  it('still reads an approval written before the kind field existed', () => {
    const legacy = JSON.stringify({
      schema_version: 1,
      spec_path: 'docs/superpowers/specs/2026-05-01-foo-design.md',
      plan_path: null,
      spec_sha256: 'd'.repeat(64),
      review_verdict: 'ok',
      review_rounds: 1,
      approved_by: 'ali@example.com',
      approved_at: '2026-05-01T00:00:00.000Z',
    });
    expect(parseSpecApproval(legacy).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/unit/spec-approval.test.ts`
Expected: PASS immediately. These are guards against a future change, not a
change in behaviour — note that in the commit so a reader does not expect red.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/spec-approval.test.ts
git commit -m "test(approval): guard the spec schema version and pre-kind records"
```

---

### Task 6: Build a story approval record, with its preconditions

**Files:**
- Create: `lib/cli/approve-story.ts`
- Create: `tests/unit/approve-story.test.ts`

**Interfaces:**
- Consumes: `hashStory`, `approvalPathForStory`, `StoryApproval`, `STORY_APPROVAL_SCHEMA_VERSION`; `parseSpecApproval`, `approvalPathForSpec` from `lib/spec-approval.ts`.
- Produces: `ApproveStoryInput` interface, `buildStoryApproval(input: ApproveStoryInput): { approval: StoryApproval; outPath: string }`, `sourceSpecOf(storyText: string): string | null`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/approve-story.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildStoryApproval, sourceSpecOf } from '../../lib/cli/approve-story';
import { hashSpecAndPlan } from '../../lib/spec-approval';

const STORY_REL = 'docs/stories/epic-8/8.1-gate-hardening.md';
const SPEC_REL = 'docs/superpowers/specs/2026-07-09-program-design.md';
const SPEC_TEXT = '# Program\n\n- [ ] AC-1: works.\n';

let root: string;

/** Write a file under the temp repo, creating parents. */
function put(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

/** A story citing the spec above. */
function story(sourceLine = `**Source spec:** \`${SPEC_REL}\``): string {
  return `# Story 8.1\n\n**Status:** Draft\n${sourceLine}\n\n## Story\n\nBody.\n`;
}

/** A clean spec approval for SPEC_REL. */
function specApproval(): string {
  return JSON.stringify({
    schema_version: 1,
    spec_path: SPEC_REL,
    plan_path: null,
    spec_sha256: hashSpecAndPlan(SPEC_TEXT, null),
    review_verdict: 'ok',
    review_rounds: 1,
    approved_by: 'ali@example.com',
    approved_at: '2026-07-09T00:00:00.000Z',
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'approve-story-'));
  put(SPEC_REL, SPEC_TEXT);
  put(SPEC_REL.replace(/\.md$/, '.approval.json'), specApproval());
  put(STORY_REL, story());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const input = (over: Record<string, unknown> = {}) => ({
  storyPath: STORY_REL,
  reviewVerdict: 'ok' as const,
  reviewRounds: 1,
  approvedBy: 'ali@example.com',
  repoRoot: root,
  ...over,
});

describe('sourceSpecOf', () => {
  it('reads the spec path out of the story header', () => {
    expect(sourceSpecOf(story())).toBe(SPEC_REL);
  });

  it('returns null when the story cites no spec', () => {
    expect(sourceSpecOf('# Story\n\n**Status:** Draft\n\nBody.\n')).toBeNull();
  });
});

describe('buildStoryApproval', () => {
  it('records the story hash and the spec lineage', () => {
    const { approval, outPath } = buildStoryApproval(input());
    expect(approval.kind).toBe('story');
    expect(approval.story_path).toBe(STORY_REL);
    expect(approval.source_spec_path).toBe(SPEC_REL);
    expect(approval.source_spec_sha256).toBe(hashSpecAndPlan(SPEC_TEXT, null));
    expect(outPath).toBe('docs/stories/epic-8/8.1-gate-hardening.approval.json');
  });

  it('refuses a story with no Source spec line', () => {
    put(STORY_REL, '# Story\n\n**Status:** Draft\n\nBody.\n');
    expect(() => buildStoryApproval(input())).toThrow(/Source spec/);
  });

  it('refuses when the source spec has no approval', () => {
    rmSync(join(root, SPEC_REL.replace(/\.md$/, '.approval.json')));
    expect(() => buildStoryApproval(input())).toThrow(/no approval/);
  });

  it('refuses when the source spec approval is unclean', () => {
    put(
      SPEC_REL.replace(/\.md$/, '.approval.json'),
      specApproval().replace('"ok"', '"concerns"'),
    );
    expect(() => buildStoryApproval(input())).toThrow(/concerns/);
  });

  it('refuses a derivation verdict that is not ok', () => {
    // Mirrors buildApproval: a story the reviewer still has something to say
    // about cannot even produce an artifact to argue about later.
    expect(() => buildStoryApproval(input({ reviewVerdict: 'concerns' }))).toThrow(
      /refusing to record/,
    );
  });

  it('refuses when the story is already approved at this hash', () => {
    const { approval, outPath } = buildStoryApproval(input());
    put(outPath, JSON.stringify(approval));
    expect(() => buildStoryApproval(input())).toThrow(/already approved/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/approve-story.test.ts`
Expected: FAIL — `Failed to resolve import "../../lib/cli/approve-story"`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// lib/cli/approve-story.ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  approvalPathForSpec,
  parseSpecApproval,
  type ReviewVerdict,
} from '../spec-approval';
import {
  approvalPathForStory,
  hashStory,
  parseStoryApproval,
  STORY_APPROVAL_SCHEMA_VERSION,
  type StoryApproval,
} from '../story-approval';

/**
 * Reading the spec a story was sharded from.
 *
 * The line is written by `/shard` into the story header and is load-bearing:
 * it is how the approval act finds the design gate this story inherits from.
 */
const SOURCE_SPEC_RE = /^\s*\*{0,2}Source spec\*{0,2}:?\*{0,2}:?\s*`?([^`\s]+\.md)`?\s*$/im;

/** Everything the approval act needs, already resolved. */
export interface ApproveStoryInput {
  /** Repo-relative path to the story being approved. */
  storyPath: string;
  /** Verdict of the derivation review. */
  reviewVerdict: ReviewVerdict;
  /** How many rounds the derivation review took. */
  reviewRounds: number;
  /** Git identity of the approving human. */
  approvedBy: string;
  /** Absolute path to the repository root. */
  repoRoot: string;
}

/**
 * Pull the source spec path out of a story's header.
 *
 * @param storyText - Full story contents.
 * @returns The repo-relative spec path, or null when the story cites none.
 */
export function sourceSpecOf(storyText: string): string | null {
  return storyText.match(SOURCE_SPEC_RE)?.[1] ?? null;
}

/**
 * Build the approval record for a story, enforcing every precondition.
 *
 * The source spec must already carry a clean approval — that is the design
 * gate this story inherits. It is checked here and never again: dispatch reads
 * the story alone, so a later amendment to the spec cannot invalidate stories
 * already approved against it.
 *
 * @param input - Resolved approval inputs.
 * @returns The record and the repo-relative path to write it to.
 * @throws If the story or spec is missing, the story cites no spec, the spec's
 *   approval is absent or unclean, the derivation verdict is not `ok`, or the
 *   story is already approved at its current hash.
 */
export function buildStoryApproval(input: ApproveStoryInput): {
  approval: StoryApproval;
  outPath: string;
} {
  const { storyPath, reviewVerdict, reviewRounds, approvedBy, repoRoot } = input;

  if (reviewVerdict !== 'ok') {
    throw new Error(
      `refusing to record an approval against a '${reviewVerdict}' derivation review — ` +
        'correct the story, re-run the review until it comes back clean, and approve that ' +
        'result. Design content the source spec does not carry belongs in the spec.',
    );
  }
  if (!Number.isInteger(reviewRounds) || reviewRounds < 1) {
    throw new Error(`REVIEW_ROUNDS must be an integer >= 1, got: ${reviewRounds}`);
  }

  const storyAbs = resolve(repoRoot, storyPath);
  if (!existsSync(storyAbs)) throw new Error(`story not found: ${storyPath}`);
  const storyText = readFileSync(storyAbs, 'utf8');

  const specPath = sourceSpecOf(storyText);
  if (specPath === null) {
    throw new Error(
      `${storyPath} has no \`Source spec:\` line. A story is approved as a derivation of an ` +
        'already-approved spec; without that line there is nothing to derive from.',
    );
  }

  const specAbs = resolve(repoRoot, specPath);
  if (!existsSync(specAbs)) throw new Error(`source spec not found: ${specPath}`);

  const specApprovalPath = approvalPathForSpec(specPath);
  const specApprovalAbs = resolve(repoRoot, specApprovalPath);
  if (!existsSync(specApprovalAbs)) {
    throw new Error(
      `no approval recorded for the source spec at ${specApprovalPath}. Approve the spec ` +
        'before approving stories derived from it.',
    );
  }
  const specApproval = parseSpecApproval(readFileSync(specApprovalAbs, 'utf8'));
  if (!specApproval.ok) {
    throw new Error(`the source spec's approval could not be read: ${specApproval.error}`);
  }
  if (specApproval.approval.review_verdict !== 'ok') {
    throw new Error(
      `the source spec was approved against a '${specApproval.approval.review_verdict}' ` +
        'review, which authorises nothing. Correct the spec and re-approve it first.',
    );
  }

  const storyHash = hashStory(storyText);
  const outPath = approvalPathForStory(storyPath);
  const outAbs = resolve(repoRoot, outPath);
  if (existsSync(outAbs)) {
    const existing = parseStoryApproval(readFileSync(outAbs, 'utf8'));
    if (existing.ok && existing.approval.story_sha256 === storyHash) {
      throw new Error(
        `${storyPath} is already approved at its current text (${outPath}). Edit the story ` +
          'or delete the stale record; re-approving unchanged text records nothing new.',
      );
    }
  }

  const approval: StoryApproval = {
    schema_version: STORY_APPROVAL_SCHEMA_VERSION,
    kind: 'story',
    story_path: storyPath,
    story_sha256: storyHash,
    source_spec_path: specPath,
    // Copied from the spec's own approval rather than recomputed. It is
    // defined as "the spec's hash at approval time", which is precisely what
    // that record already holds — and recomputing it would mean reading the
    // plan, which throws when a plan named at approval time has since moved.
    source_spec_sha256: specApproval.approval.spec_sha256,
    review_verdict: reviewVerdict,
    review_rounds: reviewRounds,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
  };
  return { approval, outPath };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/approve-story.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/cli/approve-story.ts tests/unit/approve-story.test.ts
git commit -m "feat(approval): build a story approval, refusing every precondition failure"
```

---

### Task 7: Stamp the status line

**Files:**
- Modify: `lib/cli/approve-story.ts`
- Modify: `tests/unit/approve-story.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `stampStatus(storyText: string, status: string): string`.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to tests/unit/approve-story.test.ts
import { stampStatus } from '../../lib/cli/approve-story';
import { hashStory } from '../../lib/story-approval';

describe('stampStatus', () => {
  it('replaces the status in place', () => {
    expect(stampStatus(story(), 'Approved')).toContain('**Status:** Approved');
    expect(stampStatus(story(), 'Approved')).not.toContain('**Status:** Draft');
  });

  it('leaves every other line untouched', () => {
    const before = story();
    const after = stampStatus(before, 'Approved');
    expect(hashStory(after)).toBe(hashStory(before));
  });

  it('is idempotent', () => {
    const once = stampStatus(story(), 'Approved');
    expect(stampStatus(once, 'Approved')).toBe(once);
  });

  it('throws when the story has no status line to stamp', () => {
    // Silently appending one would invent a header the template owns.
    expect(() => stampStatus('# Story\n\nBody.\n', 'Approved')).toThrow(/no \*\*Status:\*\*/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/approve-story.test.ts -t stampStatus`
Expected: FAIL — `stampStatus is not exported`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// append to lib/cli/approve-story.ts

/**
 * Matches the story's status header in the spellings the kit's conformance
 * check accepts. Kept deliberately in step with `storyBodyForHashing`.
 */
const STATUS_LINE_RE =
  /^([ \t>-]*\*{0,2}Status\*{0,2}:?\*{0,2}:?[ \t]*)(?:Draft|Approved|In ?Progress|Review|Done|Blocked)(\*{0,2}[ \t]*)$/im;

/**
 * Rewrite a story's status header.
 *
 * The line is a projection of the issue state, which is why `hashStory`
 * excludes it: stamping it must not invalidate the approval it accompanies.
 *
 * @param storyText - Full story contents.
 * @param status - One of the lifecycle values the conformance check accepts.
 * @returns The story with its status header replaced.
 * @throws When the story carries no status header, rather than inventing one.
 */
export function stampStatus(storyText: string, status: string): string {
  if (!STATUS_LINE_RE.test(storyText)) {
    throw new Error(
      'the story has no **Status:** line to stamp. It is a template field; add it rather ' +
        'than letting this invent one.',
    );
  }
  return storyText.replace(STATUS_LINE_RE, `$1${status}$2`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/approve-story.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/cli/approve-story.ts tests/unit/approve-story.test.ts
git commit -m "feat(approval): stamp a story's status without disturbing its hash"
```

---

### Task 8: The CLI entry point

**Files:**
- Modify: `lib/cli/approve-story.ts`
- Modify: `tests/unit/approve-story.test.ts`

**Interfaces:**
- Consumes: `buildStoryApproval`, `stampStatus`.
- Produces: `writeApproval(input: ApproveStoryInput): { outPath: string; storyPath: string }`, plus a `main()` guarded by `import.meta.url`.

- [ ] **Step 1: Write the failing test**

```typescript
// append to tests/unit/approve-story.test.ts
import { readFileSync as read } from 'node:fs';
import { writeApproval } from '../../lib/cli/approve-story';
import { parseStoryApproval } from '../../lib/story-approval';

describe('writeApproval', () => {
  it('writes the record and stamps the story together', () => {
    const { outPath } = writeApproval(input());
    const record = parseStoryApproval(read(join(root, outPath), 'utf8'));
    expect(record.ok).toBe(true);
    expect(read(join(root, STORY_REL), 'utf8')).toContain('**Status:** Approved');
  });

  it('writes nothing when a precondition fails', () => {
    // Neither file is written without the other.
    put(STORY_REL, '# Story\n\n**Status:** Draft\n\nBody.\n');
    expect(() => writeApproval(input())).toThrow(/Source spec/);
    expect(existsSync(join(root, approvalPathForStory(STORY_REL)))).toBe(false);
    expect(read(join(root, STORY_REL), 'utf8')).toContain('**Status:** Draft');
  });
});
```

Add `import { existsSync } from 'node:fs';` and `import { approvalPathForStory } from '../../lib/story-approval';` to the test file's imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/approve-story.test.ts -t writeApproval`
Expected: FAIL — `writeApproval is not exported`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// append to lib/cli/approve-story.ts
import { writeFileSync } from 'node:fs';

/**
 * Stamp the story and record its approval, in that order.
 *
 * `buildStoryApproval` throws before anything is written, so a refused
 * approval leaves both files untouched — the story is never stamped Approved
 * without a record to back it.
 *
 * The order of the two writes below is load-bearing, not stylistic: the
 * story is stamped FIRST and the record written SECOND because that is the
 * direction that recovers if the second write throws. Stamp-then-record
 * leaves, at worst, a stamped story with no record — the dispatch gate
 * refuses that (fails closed), and a retry succeeds, because `hashStory`
 * excludes the status line, so the story's hash is unchanged and no record
 * yet exists to trip the "already approved" guard. Record-then-stamp is the
 * direction that cannot be recovered: a failure after the record lands but
 * before the stamp produces a recorded-but-unstamped story, and re-running
 * is refused by that same guard, with no way to complete the operation short
 * of hand-editing one of the two files.
 *
 * @param input - Resolved approval inputs.
 * @returns Where the record was written and which story was stamped.
 * @throws Whatever `buildStoryApproval` or `stampStatus` throws.
 */
export function writeApproval(input: ApproveStoryInput): {
  outPath: string;
  storyPath: string;
} {
  const { approval, outPath } = buildStoryApproval(input);
  const storyAbs = resolve(input.repoRoot, input.storyPath);
  const stamped = stampStatus(readFileSync(storyAbs, 'utf8'), 'Approved');

  writeFileSync(storyAbs, stamped, 'utf8');
  writeFileSync(resolve(input.repoRoot, outPath), `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  return { outPath, storyPath: input.storyPath };
}

/**
 * Entry point. Reads the same environment-variable shape as `approve-spec`.
 *
 * @throws If a required variable is missing or a precondition fails.
 */
function main(): void {
  const storyPath = process.env.STORY_PATH;
  if (!storyPath) throw new Error('STORY_PATH is required');
  const verdict = (process.env.REVIEW_VERDICT ?? '') as ReviewVerdict;
  const rounds = Number.parseInt(process.env.REVIEW_ROUNDS ?? '', 10);
  const approvedBy = process.env.APPROVED_BY ?? '';
  if (!approvedBy) throw new Error('APPROVED_BY is required');

  const { outPath } = writeApproval({
    storyPath,
    reviewVerdict: verdict,
    reviewRounds: rounds,
    approvedBy,
    repoRoot: process.cwd(),
  });
  console.log(`recorded ${outPath} and stamped ${storyPath} Approved`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/approve-story.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Run everything**

Run: `npx vitest run && cd dashboard && npx tsc --noEmit && npx vitest run && cd ..`
Expected: PASS throughout.

- [ ] **Step 6: Commit**

```bash
git add lib/cli/approve-story.ts tests/unit/approve-story.test.ts
git commit -m "feat(approval): approve-story CLI — one act, both records"
```

---

## Acceptance criteria covered by this plan

| AC | Task |
|---|---|
| AC-1 | 6 |
| AC-2 | 6 |
| AC-3 | 8 |
| AC-4 | 3 (does not consult the source spec) |
| AC-5 | 3 (story edited after approval) |
| AC-6 | 1 and 3 (status line excluded; status change still allowed) |
| AC-7 | 3 (missing record refused regardless of the status line) |
| AC-8 | 2 (parsers reject each other's records) |
| AC-9 | 1 (domain separation) |
| AC-10 | 3 (each check, its own reason) |
| AC-11 | 3 (documented contract: a failed read is not `null`) |
| AC-18 | 4 |
| AC-19 | 5 |

AC-12 to AC-17 belong to slices 3 and 4 and are out of scope here.

## Notes for the executor

- `APPROVED_BY` records a human's identity. Never run this CLI on the user's behalf, for the same reason `approve-spec` carries that rule.
- Task 3 widens `GateReason` with `path-mismatch`. That union lives in both copies of the spec-approval module; Task 4 is where the copy is re-synced, so the drift test will be red between Task 3 and Task 4. That is expected.
- AC-11's contract is enforced by the caller, not the gate: `approvalRaw: null` means "genuinely absent". A caller that swallows a read error into `null` violates it, and slices 3 and 4 are where those callers get written.
