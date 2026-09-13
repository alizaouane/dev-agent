# Story-level approval — Implementation Plan (slice 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An approved story appears in the dashboard's picker as a startable item, dispatches from there, and has its status line written by dev-agent as the issue moves — and the derivation review the intake already invokes actually exists.

**Architecture:** Two lists, not one. `SpecPair` keeps its shape and a parallel `StoryItem` sits beside it, with its own lister, its own verifier and its own server action. Nothing on the spec path is refactored to accommodate stories. Stories are found by one recursive git-tree call rather than a `getContent` per epic directory, from a directory the consumer's own config names. The status line is written by a CLI that shares `stampStatus` with `approve-story`, so the grammar stays in one place.

**Tech Stack:** TypeScript (strict), Next.js server actions, GitHub Actions YAML, vitest, `js-yaml`, `@octokit/rest`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-12-story-level-approval-design.md`

## Scope of this plan

Slice 4: **AC-12, AC-13**, and **AC-15 in the two places a transition exists**.

**AC-14 was delivered in slice 3's pull request, not here.** Its review found
that the shipped story door invoked a derivation-review mode that did not
exist, rated it a blocker, and it was — the door could not reach the clean
verdict it waits for. Task 1 below is kept for the record, marked done, and
carries no work. Start at Task 2.

Slices 1 to 3 are merged or in flight. At the end of this plan a story with a recorded approval is visible and startable from the repo page, and its status line moves to `InProgress` when implement starts and `Review` when the pull request opens.

**AC-15's `Done` stamp is built but not wired, and that is deliberate.** Nothing in this repo sets `state:done`. `phase-promote-to-prod.yml:118` reports that promotion is unimplemented and exits 1, and no other workflow flips an issue to done. The CLI in Task 10 handles `Done` exactly as it handles the other two; Task 11 wires the two transitions that exist. Wiring the third is one line in the promotion phase on the day that phase is built, and it is named in that phase's own backlog rather than faked here. Do not invent a `state:done` transition to satisfy the criterion.

## Decisions taken before this plan was written

Recorded so the executor does not re-open them, and so a later reader can see what was weighed.

1. **Two lists.** Decided at the end of the slice 3 plan. The panel grows a second section. `dispatchFromSpec` is untouched and `dispatchFromStory` sits beside it.
2. **`stories_dir` is optional in the schema, with a default.** Making it required would fail config parsing in every consumer repo that predates the key — which is all of them. `z.string().min(1).default('docs/stories')`, and absent from the JSON schema's `required` list.
3. **The dashboard starts reading the consumer's `.dev-agent.yml`.** It never has: `list-spec-plan-files.ts` hardcodes its directories. AC-13 requires the picker to resolve stories from `artifacts.stories_dir`, so Task 3 adds a small reader. A config that is absent yields the default. A config that cannot be read, or can be read but not honoured, marks the listing short rather than silently listing a different directory.
4. **Sort ascending by epic then story number, numerically.** Specs sort newest-first because a spec from March is history. A story list is a work queue: 8.1 comes before 8.2, and 8.9 before 8.10. String comparison gets that last pair wrong, so the comparison is segment-wise numeric.
5. **The working-tree identity check compares a story's hashed body, not its bytes.** `phase-implement.yml:524` runs `cmp -s` between the base copy and the branch copy. Once dev-agent stamps the status line that comparison fails on a difference the approval deliberately ignores. The fix is to compare exactly what the approval binds, via a CLI that reuses `storyBodyForHashing` — not a fourth hand-written copy of the status-line grammar in bash.
6. **The status stamp is pushed to the base branch, not committed on the agent branch.** The story's status is a projection of issue state, and the issue is a fact about the repository rather than about one pull request. Stamping on the agent branch would put the projection inside a diff a reviewer has to read, and would leave `Done` unreachable once the branch is deleted.

## Global Constraints

- TypeScript strict; zero `any` without an inline justification comment.
- 100% docstring coverage on every exported symbol: what it does, its inputs, what it returns or throws. Never restate the signature.
- `dashboard/lib/story-approval.ts` must stay byte-identical to `lib/story-approval.ts`; same for the two `spec-approval.ts` copies. The dashboard deploys with `rootDirectory=dashboard/`, so the copies are what ship. Re-copy and verify with `cmp` in the same task that edits either. **No task in this plan needs to edit either file.** If you find yourself about to, stop and say why.
- `SPEC_APPROVAL_SCHEMA_VERSION` and `STORY_APPROVAL_SCHEMA_VERSION` both stay at `1`.
- A read that fails for any reason other than "not found" must never be reported as absence. A listing that hit a limit must never be reported as complete.
- Never write a literal control character into source — escape sequences only.
- Engine tests: `tests/unit/**`, run with `npx vitest run tests/unit/<file>`. Dashboard tests: `dashboard/__tests__/**`, run from `dashboard/` with `npx vitest run __tests__/<path>`.
- Server-side dashboard modules start with `import 'server-only';`.
- Every reader of a story path canonicalises it with `canonicalStoryPath` from `lib/story-approval.ts` (shipped in slice 3's PR, #164). `approve-story` records the path without a leading `./`; a reader that keeps the caller's spelling refuses a correctly approved story for ever on a path mismatch. Paths that come from the git-tree listing are already canonical; paths from a form field, an env variable or an issue body are not.
- A `"use server"` module may only export async functions. Constants and sync helpers live in a sibling module.

## File Structure

| File | Responsibility |
|---|---|
| `skills/spec-review/SKILL.md` (modify) | Declare the derivation-review mode |
| `skills/spec-review/derivation-checklist.md` (create) | The checks that mode runs |
| `lib/schema.ts`, `schema/dev-agent.schema.yml`, `schema/defaults.yml`, `dashboard/lib/wire-up-template.ts` (modify) | `artifacts.stories_dir` |
| `dashboard/lib/dashboard/read-artifacts-config.ts` (create) | Resolve `stories_dir` from the consumer's config |
| `dashboard/lib/dashboard/list-story-files.ts` (create) | One recursive git-tree listing of the story tree |
| `dashboard/lib/story-items.ts` (create) | The picker's story type, its title, and its order |
| `dashboard/lib/verify-story-items.ts` (create) | Re-derive `approved` through the real story gate |
| `dashboard/lib/find-story-issue.ts` (create) | Find the issue a story was filed under |
| `dashboard/lib/find-spec-issue.ts` (modify) | Widen two helpers so both issue kinds share them |
| `dashboard/lib/actions.ts` (modify) | `dispatchFromStory` |
| `dashboard/components/start-from-spec-panel.tsx` (modify) | The second section |
| `dashboard/app/repos/[name]/page.tsx` (modify) | Wire the story listing through |
| `lib/cli/stamp-story-status.ts` (create) | Write the status line |
| `lib/cli/compare-approved-text.ts` (create) | Identity check that ignores what the approval ignores |
| `.github/workflows/phase-implement.yml` (modify) | Stamp `InProgress` and `Review`; use the new comparison |

## Task dependency order

Task 1 is already done. Task 2 is independent of everything. Tasks 3 to 9 are a chain: each consumes the one before. Tasks 10 and 11 are independent of 3 to 9 and depend on nothing in this plan except each other. An executor short on time can stop cleanly after Task 9 or after Task 11.

---

### Task 1: The derivation-review mode the intake already invokes (AC-14) — DONE IN SLICE 3

**Do not execute this task.** It shipped in slice 3's pull request
(`feat(spec-review): the derivation mode the story door invokes`), because
that PR's review found the shipped door invoking a mode that did not exist and
correctly called it a blocker on the door itself. `skills/spec-review/SKILL.md`
carries the mode, `skills/spec-review/derivation-checklist.md` carries its
checks, and four tests in `tests/unit/skills.test.ts` cover it. The
specification below is kept so the decision behind D1.3 stays readable.

<details>
<summary>Original task text</summary>


`skills/start-feature/SKILL.md:188` tells the agent to "invoke `dev-agent:spec-review`'s derivation-review mode". That mode does not exist. `skills/spec-review/SKILL.md` documents one mode, which takes a `spec_path` and a `plan_path`, cross-checks Files to Touch against the default branch, and cross-checks acceptance criteria against plan tasks. A story has no plan, so the shipped intake references something that cannot run.

The mode's distinguishing rule is the one AC-14 names: **design content in the story that is absent from its source spec is a `blocker`, not a note.** The operating model is that the user approves a reviewer's verdict rather than reading the document, so a finding nobody reads is not a gate. The remedy is to push the content up into the spec, re-approve the spec, and approve the story against it.

**Files:**
- Modify: `skills/spec-review/SKILL.md`
- Create: `skills/spec-review/derivation-checklist.md`
- Test: `tests/unit/skills.test.ts`

**Interfaces:**
- Consumes: nothing from this plan.
- Produces: nothing other tasks read. `start-feature` Phase S.1 is the only caller.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/skills.test.ts`:

```ts
describe('spec-review derivation mode', () => {
  const root = resolve(__dirname, '../..');
  const skill = readFileSync(resolve(root, 'skills/spec-review/SKILL.md'), 'utf8');
  const mode = skill.slice(skill.indexOf('## Derivation-review mode'));

  it('declares the mode start-feature Phase S.1 invokes', () => {
    // Phase S.1 names this mode by name. Without it the shipped intake
    // invokes something that does not exist, and the reviewer falls back to
    // the spec-mode checklist — which demands a plan a story does not have.
    expect(skill).toContain('## Derivation-review mode');
    expect(mode).toContain('story_path');
    expect(mode).toContain('source_spec_path');
  });

  it('makes design content absent from the source spec a blocker', () => {
    // AC-14. A `concerns` verdict is not a gate here: buildStoryApproval
    // refuses anything that is not `ok`, so the verdict word is the whole
    // mechanism. Downgrading this finding to a note would let a story carry
    // unreviewed design into implementation.
    const rule = mode.slice(mode.indexOf('absent from'));
    expect(rule).not.toBe('');
    expect(mode).toMatch(/absent from (the |its )?source spec[^.]*blocker/i);
  });

  it('does not ask a story for a plan', () => {
    // The spec-mode checklist cross-checks acceptance criteria against plan
    // tasks. A story has no plan, so a mode that inherited that check would
    // emit a blocker on every story.
    expect(mode).not.toContain('plan_path');
  });

  it('ships the checklist the mode loads', () => {
    expect(existsSync(resolve(root, 'skills/spec-review/derivation-checklist.md'))).toBe(true);
  });
});
```

`readFileSync`, `existsSync` and `resolve` are already imported at the top of that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/skills.test.ts -t "derivation mode"`
Expected: FAIL. The first assertion fails on the missing header, and `indexOf` returning `-1` makes `mode` the whole file.

- [ ] **Step 3: Write the checklist**

Create `skills/spec-review/derivation-checklist.md`:

```markdown
# Derivation review checklist

Run against a sharded story and the spec it was sharded from. Every check
gets a verdict of `pass`, `concern` or `fail`, and a one-sentence note citing
the section it came from.

## D1 — Faithfulness

- **D1.1** Every acceptance criterion in the story traces to a statement in the
  source spec. `fail` on any that does not.
- **D1.2** No acceptance criterion contradicts the source spec. `fail` on a
  contradiction, `concern` on a narrowing the spec did not ask for.
- **D1.3** The story introduces no design content — no architecture, no data
  shape, no interface, no dependency, no policy — that is absent from the
  source spec. **`fail`**, always. This is the check the whole mode exists
  for: the remedy is to push the content up into the spec, re-approve the
  spec, and approve the story against it. Do not record it as a `concern`,
  and do not accept "it is obviously implied".

## D2 — Testability

- **D2.1** Every acceptance criterion states an observable outcome. `fail` on
  one that cannot be checked without reading the implementation.
- **D2.2** Each criterion is a `- [ ]` checkbox bullet, so `extractAcceptanceCriteria`
  can see it. `fail` otherwise.

## D3 — Resolvability

- **D3.1** Every path in the story's Files to Touch section resolves on the
  default branch, by the same Create / Modify / Tests rules the spec mode
  applies. `fail` on a mismatch.
- **D3.2** The story's `Source spec:` line names a path that exists on the
  default branch. `fail` otherwise.

## D4 — Size

- **D4.1** The story is deliverable in one pull request. `concern` when it
  reads like two.
```

- [ ] **Step 4: Write the mode into the skill**

Insert a `## Derivation-review mode` section into `skills/spec-review/SKILL.md`, after `## Inputs` and before `## Process`. Rewrite the `## Inputs` heading to `## Inputs (spec mode)` so the two input lists cannot be confused.

```markdown
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
spec, and asking a story for one would emit a blocker on every story.

### Process

1. Read the story and the source spec in full, in that order, with fresh
   context.
2. Load `{skill-root}/derivation-checklist.md` and run every check in it.
3. Emit a verdict by the same rule the spec mode uses: any `fail` is a
   `blocker`, any `concern` with no `fail` is `concerns`, otherwise `ok`.

**Design content in the story that is absent from the source spec is a
blocker.** Not a note, not a `concern`. The user approves a verdict rather
than reading the document, so a finding that only appears in prose is not a
gate at all. `buildStoryApproval` refuses any verdict that is not `ok`, which
makes the verdict word the entire mechanism. The remedy is to amend the spec,
re-approve it, and approve the story against the amended spec.

### Output

Write `.dev-agent/derivation-review.json` in the consumer repo, in the same
shape the spec mode writes, minus `plan_path`, `ac_plan_gaps` and
`files_to_touch.create_conflicts`:

```json
{
  "verdict": "ok" | "concerns" | "blocker",
  "story_path": "<path>",
  "source_spec_path": "<path>",
  "checks": [
    { "id": "D1.1", "verdict": "pass" | "concern" | "fail", "note": "<one sentence>" }
  ],
  "summary": "<markdown — 3-10 lines>"
}
```

Print the verdict word on the final line of stdout, as the spec mode does.
Phase S.1 reads that line and loops until it is `ok`.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/skills.test.ts`
Expected: PASS, including the tests that were already there.

- [ ] **Step 6: Commit**

```bash
git add skills/spec-review/SKILL.md skills/spec-review/derivation-checklist.md tests/unit/skills.test.ts
git commit -m "feat(spec-review): the derivation mode the intake already invokes"
```

---

</details>

### Task 2: `artifacts.stories_dir`

There is no config key that locates a story. `lib/schema.ts` defines `specs_dir`, `plans_dir`, `status_file` and `runbooks_dir`, and stories live under none of them.

The key is **optional with a default**. Every consumer repo's `.dev-agent.yml` predates it, and a required key would fail config parsing in all of them — which `phase-implement.yml` treats as a hard error before it does anything else.

**Files:**
- Modify: `lib/schema.ts` (the `artifacts` object)
- Modify: `schema/dev-agent.schema.yml`
- Modify: `schema/defaults.yml`
- Modify: `dashboard/lib/wire-up-template.ts`
- Test: `tests/unit/schema.test.ts`

**Interfaces:**
- Produces: `config.artifacts.stories_dir: string`, always present after parsing.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/schema.test.ts`:

```ts
describe('artifacts.stories_dir', () => {
  it('defaults for a config written before the key existed', () => {
    // Every consumer repo's config predates this key. A required key would
    // fail the parse that phase-implement runs before it does anything else,
    // which would take every wired repo down at once.
    const parsed = devAgentConfigSchema.parse(validSample);
    expect(parsed.artifacts.stories_dir).toBe('docs/stories');
  });

  it('keeps an explicit value', () => {
    const parsed = devAgentConfigSchema.parse({
      ...validSample,
      artifacts: { ...validSample.artifacts, stories_dir: 'docs/work/stories' },
    });
    expect(parsed.artifacts.stories_dir).toBe('docs/work/stories');
  });

  it('rejects an empty value rather than silently defaulting', () => {
    // An empty string would list the repository root. Refusing is the only
    // honest answer: the operator asked for a directory and named none.
    expect(() =>
      devAgentConfigSchema.parse({
        ...validSample,
        artifacts: { ...validSample.artifacts, stories_dir: '' },
      }),
    ).toThrow();
  });
});
```

`validSample` is the existing fixture at the top of that file, and the schema is exported as `devAgentConfigSchema` (lower-case `d`). Reuse both rather than introducing a second fixture.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/schema.test.ts -t "stories_dir"`
Expected: FAIL with `expected undefined to be 'docs/stories'`.

- [ ] **Step 3: Add the key in all four places**

`lib/schema.ts`, inside the `artifacts` object, after `plans_dir`:

```ts
    /**
     * Where sharded story files live, as a repo-relative directory.
     *
     * Optional with a default because every consumer config predates the key,
     * and a required key would fail the parse `phase-implement` runs before
     * anything else. Stories nest one level deeper than specs — the epic
     * directory — so consumers point this at the tree, not at one epic.
     */
    stories_dir: z.string().min(1).default('docs/stories'),
```

`schema/dev-agent.schema.yml`, in `artifacts.properties` (and **not** in `required`):

```yaml
      stories_dir: { type: string }
```

`schema/defaults.yml`, in `artifacts`:

```yaml
  # Sharded story files, one directory per epic beneath this one.
  stories_dir: docs/stories
```

`dashboard/lib/wire-up-template.ts`, in the `artifacts` block of the template it emits:

```yaml
  stories_dir: docs/stories
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/schema.test.ts tests/unit/schema-files.test.ts tests/unit/types.test.ts`
Expected: PASS. `schema-files.test.ts` holds the YAML schema against the zod schema; if it fails, the two are out of step and the YAML is what needs fixing.

- [ ] **Step 5: Run the dashboard's wire-up test**

Run, from `dashboard/`: `npx vitest run __tests__ -t "wire-up"`
Expected: PASS. If a test pins the template verbatim, update it.

- [ ] **Step 6: Commit**

```bash
git add lib/schema.ts schema/dev-agent.schema.yml schema/defaults.yml dashboard/lib/wire-up-template.ts tests/unit/schema.test.ts
git commit -m "feat(config): artifacts.stories_dir, optional with a default"
```

---

### Task 3: Resolve `stories_dir` from the consumer's config (AC-13)

The dashboard has never read a consumer's `.dev-agent.yml`. AC-13 requires the picker to resolve stories from `artifacts.stories_dir`, so it starts now, in one small module with one job.

The three outcomes are different facts and must stay different. A config that is **absent** means the repo has not been wired for stories and the default applies. A config that **cannot be read** — a rate limit, a revoked token — is not a config that says `docs/stories`. A config that **can be read but not honoured** — unparseable YAML, a non-string value — is worse than either, because listing a different directory from the one configured is the same lie as a short list wearing a different hat.

**Files:**
- Create: `dashboard/lib/dashboard/read-artifacts-config.ts`
- Test: `dashboard/__tests__/lib/dashboard/read-artifacts-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ArtifactsConfig { storiesDir: string; unreadable: boolean }
  export async function readArtifactsConfig(
    octokit: Octokit, owner: string, repo: string, ref: string,
  ): Promise<ArtifactsConfig>
  ```
  `storiesDir` is always a usable directory with no trailing slash. `unreadable` true means what came back may not reflect the repo.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/__tests__/lib/dashboard/read-artifacts-config.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { readArtifactsConfig } from '@/lib/dashboard/read-artifacts-config';

const getContent = vi.fn();
const octokit = { repos: { getContent } } as unknown as Octokit;

/** A getContent response carrying `yaml` as the file's text. */
function file(yaml: string) {
  return { data: { content: Buffer.from(yaml, 'utf8').toString('base64') } };
}

/** An Octokit-shaped error with a status. */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => vi.clearAllMocks());

describe('readArtifactsConfig', () => {
  it('reads the configured directory', async () => {
    getContent.mockResolvedValue(file('artifacts:\n  stories_dir: docs/work/stories\n'));
    expect(await readArtifactsConfig(octokit, 'o', 'r', 'main')).toEqual({
      storiesDir: 'docs/work/stories',
      unreadable: false,
    });
  });

  it('defaults when the config has no stories_dir', async () => {
    getContent.mockResolvedValue(file('artifacts:\n  specs_dir: docs/specs\n'));
    expect(await readArtifactsConfig(octokit, 'o', 'r', 'main')).toEqual({
      storiesDir: 'docs/stories',
      unreadable: false,
    });
  });

  it('defaults, readably, when there is no config at all', async () => {
    getContent.mockRejectedValue(httpError(404));
    expect(await readArtifactsConfig(octokit, 'o', 'r', 'main')).toEqual({
      storiesDir: 'docs/stories',
      unreadable: false,
    });
  });

  it('marks itself unreadable when the read fails for any other reason', async () => {
    // A rate-limited read is not a repo configured for docs/stories. Folding
    // the two together is how an outage becomes a decision nobody made.
    getContent.mockRejectedValue(httpError(403));
    expect(await readArtifactsConfig(octokit, 'o', 'r', 'main')).toEqual({
      storiesDir: 'docs/stories',
      unreadable: true,
    });
  });

  it('marks itself unreadable when the config cannot be parsed', async () => {
    getContent.mockResolvedValue(file('artifacts: [this is not\n  a mapping\n'));
    expect((await readArtifactsConfig(octokit, 'o', 'r', 'main')).unreadable).toBe(true);
  });

  it('marks itself unreadable when stories_dir is present but unusable', async () => {
    // We could read it and cannot honour it. Listing docs/stories anyway
    // would report a directory the operator did not configure as if they had.
    getContent.mockResolvedValue(file('artifacts:\n  stories_dir: 17\n'));
    const result = await readArtifactsConfig(octokit, 'o', 'r', 'main');
    expect(result).toEqual({ storiesDir: 'docs/stories', unreadable: true });
  });

  it('strips a trailing slash so path prefixes compose', async () => {
    getContent.mockResolvedValue(file('artifacts:\n  stories_dir: docs/stories/\n'));
    expect((await readArtifactsConfig(octokit, 'o', 'r', 'main')).storiesDir).toBe('docs/stories');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run, from `dashboard/`: `npx vitest run __tests__/lib/dashboard/read-artifacts-config.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

```ts
import 'server-only';

import type { Octokit } from '@octokit/rest';
import { load } from 'js-yaml';

/**
 * Where stories live when the consumer has not said, or has said something
 * we cannot use. Matches `schema/defaults.yml`.
 */
const DEFAULT_STORIES_DIR = 'docs/stories';

/** What the consumer's config says about where artifacts live. */
export interface ArtifactsConfig {
  /** Repo-relative story directory, with no trailing slash. Always usable. */
  storiesDir: string;
  /**
   * True when this does not necessarily reflect the repo — the config could
   * not be read, could not be parsed, or named a value we cannot honour.
   * Callers surface it; nothing here decides what to do about it.
   */
  unreadable: boolean;
}

/**
 * Read `artifacts.stories_dir` from a consumer's `.dev-agent.yml`.
 *
 * Three outcomes, kept apart on purpose. An absent config is a repo that has
 * not been wired for stories, and the default applies. A read that failed for
 * any other reason is not an absent config: reporting it as one would list the
 * default directory and call the result complete. A config we could read but
 * not honour is the same failure wearing a different hat — the operator named
 * a directory and we would be listing a different one.
 *
 * @param octokit - Authenticated client for the consumer repo.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param ref - Branch to read the config from.
 * @returns The directory to list, and whether that answer is trustworthy.
 */
export async function readArtifactsConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<ArtifactsConfig> {
  let text: string;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: '.dev-agent.yml', ref });
    if (Array.isArray(data) || !('content' in data)) {
      return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };
    }
    text = Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    const absent = (err as { status?: number }).status === 404;
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: !absent };
  }

  let parsed: unknown;
  try {
    parsed = load(text);
  } catch {
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };
  }

  const artifacts = (parsed as { artifacts?: unknown } | null)?.artifacts;
  if (artifacts === undefined || artifacts === null) {
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: false };
  }
  if (typeof artifacts !== 'object') {
    return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };
  }

  const raw = (artifacts as { stories_dir?: unknown }).stories_dir;
  // Absent is the documented default and reads cleanly. Present-but-unusable
  // is not: we would be listing a directory the operator did not name.
  if (raw === undefined) return { storiesDir: DEFAULT_STORIES_DIR, unreadable: false };
  if (typeof raw !== 'string') return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };

  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return { storiesDir: DEFAULT_STORIES_DIR, unreadable: true };
  return { storiesDir: trimmed, unreadable: false };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run, from `dashboard/`: `npx vitest run __tests__/lib/dashboard/read-artifacts-config.test.ts`
Expected: PASS, seven tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/dashboard/read-artifacts-config.ts dashboard/__tests__/lib/dashboard/read-artifacts-config.test.ts
git commit -m "feat(dashboard): read the consumer's configured stories directory"
```

---

### Task 4: List the story tree in one call (AC-13)

`listFilesInDir` is one `getContent` per directory and ORs `unreadable` across all of them. Stories nest one level deeper — `docs/stories/epic-8-agent-reliability/8.1-slug.md` — so recursing with that primitive is N+1 calls, and one unreadable epic marks the whole list short. The git tree API returns the whole subtree in one request.

That API has its own way of lying: a large repository comes back with `truncated: true` and a partial tree. **A truncated tree is a short list, and this module says so.** That is the same rule the rest of this feature applies to a failed read.

**Files:**
- Create: `dashboard/lib/dashboard/list-story-files.ts`
- Test: `dashboard/__tests__/lib/dashboard/list-story-files.test.ts`

**Interfaces:**
- Consumes: `storiesDir` from Task 3.
- Produces:
  ```ts
  export interface StoryListing {
    stories: string[];
    approvals: string[];
    blobShas: Record<string, string>;
    unreadable: boolean;
  }
  export async function listStoryFiles(
    octokit: Octokit, owner: string, repo: string, ref: string, storiesDir: string,
  ): Promise<StoryListing>
  ```

- [ ] **Step 1: Write the failing tests**

Create `dashboard/__tests__/lib/dashboard/list-story-files.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { listStoryFiles } from '@/lib/dashboard/list-story-files';

const getTree = vi.fn();
const octokit = { git: { getTree } } as unknown as Octokit;

/** A git-tree response over `paths`, with a deterministic blob sha each. */
function tree(paths: string[], truncated = false) {
  return {
    data: {
      truncated,
      tree: paths.map((path, i) => ({ path, type: 'blob', sha: `sha${i}` })),
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('listStoryFiles', () => {
  it('finds stories nested under epic directories', async () => {
    getTree.mockResolvedValue(
      tree([
        'docs/stories/epic-8-agent-reliability/8.1-gate.md',
        'docs/stories/epic-8-agent-reliability/8.1-gate.approval.json',
        'docs/stories/epic-9-costs/9.1-caps.md',
        'README.md',
      ]),
    );
    const result = await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories');
    expect(result.stories).toEqual([
      'docs/stories/epic-8-agent-reliability/8.1-gate.md',
      'docs/stories/epic-9-costs/9.1-caps.md',
    ]);
    expect(result.approvals).toEqual([
      'docs/stories/epic-8-agent-reliability/8.1-gate.approval.json',
    ]);
    expect(result.unreadable).toBe(false);
  });

  it('makes exactly one call however deep the tree is', async () => {
    // The reason this module exists. A getContent-per-directory lister is
    // N+1 calls and marks the whole list short when one epic fails.
    getTree.mockResolvedValue(tree(['docs/stories/epic-1-a/1.1-x.md']));
    await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories');
    expect(getTree).toHaveBeenCalledTimes(1);
  });

  it('reports a truncated tree as short, not as complete', async () => {
    // GitHub truncates large trees silently. A partial list rendered as the
    // whole list is the truncation-as-absence failure this project keeps
    // closing: an approved story simply would not appear, with no signal.
    getTree.mockResolvedValue(tree(['docs/stories/epic-1-a/1.1-x.md'], true));
    const result = await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories');
    expect(result.stories).toEqual(['docs/stories/epic-1-a/1.1-x.md']);
    expect(result.unreadable).toBe(true);
  });

  it('treats an absent tree as empty and readable', async () => {
    getTree.mockRejectedValue(Object.assign(new Error('no'), { status: 404 }));
    expect(await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories')).toEqual({
      stories: [],
      approvals: [],
      blobShas: {},
      unreadable: false,
    });
  });

  it('treats any other failure as unreadable', async () => {
    getTree.mockRejectedValue(Object.assign(new Error('rate limit'), { status: 403 }));
    expect((await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories')).unreadable).toBe(true);
  });

  it('does not match a sibling directory that shares the prefix', async () => {
    // `docs/stories-archive/` starts with `docs/stories`. Without the
    // separator it would be listed as if it were the configured tree, and
    // an archived story would be offered as startable work.
    getTree.mockResolvedValue(
      tree(['docs/stories-archive/epic-1-a/1.1-old.md', 'docs/stories/epic-1-a/1.1-new.md']),
    );
    const result = await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories');
    expect(result.stories).toEqual(['docs/stories/epic-1-a/1.1-new.md']);
  });

  it('ignores trees and submodule entries', async () => {
    getTree.mockResolvedValue({
      data: {
        truncated: false,
        tree: [
          { path: 'docs/stories/epic-1-a', type: 'tree', sha: 'a' },
          { path: 'docs/stories/epic-1-a/1.1-x.md', type: 'blob', sha: 'b' },
        ],
      },
    });
    const result = await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories');
    expect(result.stories).toEqual(['docs/stories/epic-1-a/1.1-x.md']);
    expect(result.blobShas).toEqual({ 'docs/stories/epic-1-a/1.1-x.md': 'b' });
  });

  it('honours a configured directory that is not the default', async () => {
    getTree.mockResolvedValue(tree(['docs/work/stories/epic-1-a/1.1-x.md']));
    const result = await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/work/stories');
    expect(result.stories).toEqual(['docs/work/stories/epic-1-a/1.1-x.md']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run, from `dashboard/`: `npx vitest run __tests__/lib/dashboard/list-story-files.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

```ts
import 'server-only';

import type { Octokit } from '@octokit/rest';

/** Every story and approval artifact under the configured tree. */
export interface StoryListing {
  /** Repo-relative paths to story markdown files. */
  stories: string[];
  /** Repo-relative paths to the `.approval.json` files beside them. */
  approvals: string[];
  /** Path to git blob SHA, so the verifier can skip unchanged files. */
  blobShas: Record<string, string>;
  /**
   * True when this listing may be short — the read failed for a reason other
   * than the tree being absent, or the tree came back truncated.
   */
  unreadable: boolean;
}

/**
 * List the story tree on `ref` in a single recursive call.
 *
 * One call, not one per epic directory. The per-directory lister the spec
 * picker uses ORs its `unreadable` flag across every directory it touched, so
 * recursing epics with it would be N+1 requests and one unreadable epic would
 * mark the entire list short.
 *
 * A truncated tree is reported as short. GitHub truncates large trees without
 * erroring, so a partial list is exactly the shape of a complete one — and an
 * approved story missing from the picker for that reason would be invisible.
 *
 * @param octokit - Authenticated client for the consumer repo.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param ref - Branch or commit to read the tree at.
 * @param storiesDir - Repo-relative story directory, without a trailing slash.
 * @returns The story paths, the approval paths beside them, their blob SHAs,
 *   and whether the listing can be trusted to be complete.
 */
export async function listStoryFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  storiesDir: string,
): Promise<StoryListing> {
  let entries: { path?: string; type?: string; sha?: string }[];
  let truncated: boolean;
  try {
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: '1',
    });
    entries = data.tree ?? [];
    truncated = data.truncated === true;
  } catch (err) {
    const absent = (err as { status?: number }).status === 404;
    return { stories: [], approvals: [], blobShas: {}, unreadable: !absent };
  }

  // The separator is load-bearing: without it `docs/stories-archive` matches
  // a `docs/stories` configuration and archived work is offered as startable.
  const prefix = `${storiesDir}/`;
  const stories: string[] = [];
  const approvals: string[] = [];
  const blobShas: Record<string, string> = {};

  for (const entry of entries) {
    const path = entry.path;
    if (entry.type !== 'blob' || typeof path !== 'string' || !path.startsWith(prefix)) continue;
    if (path.endsWith('.md')) stories.push(path);
    else if (path.endsWith('.approval.json')) approvals.push(path);
    else continue;
    // Only a real SHA goes in. A missing one makes the verifier read the file
    // rather than key a cache entry on a value that does not describe it.
    if (typeof entry.sha === 'string' && entry.sha !== '') blobShas[path] = entry.sha;
  }

  return { stories, approvals, blobShas, unreadable: truncated };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run, from `dashboard/`: `npx vitest run __tests__/lib/dashboard/list-story-files.test.ts`
Expected: PASS, eight tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/dashboard/list-story-files.ts dashboard/__tests__/lib/dashboard/list-story-files.test.ts
git commit -m "feat(dashboard): list the story tree in one recursive call"
```

---

### Task 5: The picker's story type, its title and its order (AC-12)

`SpecPair` is spec-and-plan shaped all the way through: a `specPath`, a `planPath`, a dated `YYYY-MM-DD-<topic>` slug, a title derived from that slug. `titleFromSlug` on `8.1-commitment-gate-hardening.md` strips no date, so it yields "8.1 commitment gate hardening" with a junk sort position. A story needs its own type.

Ordering is ascending by epic, then by story number compared **numerically segment by segment**. A story list is a work queue rather than a history, so 8.1 comes before 8.2 — and 8.9 before 8.10, which string comparison gets backwards.

**Files:**
- Create: `dashboard/lib/story-items.ts`
- Test: `dashboard/__tests__/lib/story-items.test.ts`

**Interfaces:**
- Consumes: `stories` and `approvals` from Task 4.
- Produces:
  ```ts
  export interface StoryItem {
    storyPath: string;
    key: string;
    epic: number | null;
    storyNumber: string | null;
    title: string;
    approved: boolean;
    unverified?: boolean;
  }
  export function epicOf(path: string): number | null
  export function storyNumberOf(path: string): string | null
  export function storyTitleOf(path: string): string
  export function toStoryItems(stories: string[], approvalPaths?: string[]): StoryItem[]
  ```
  This module is pure and has no `server-only` import — the panel is a client component and imports `StoryItem` as a type, exactly as it does `SpecPair`.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/__tests__/lib/story-items.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { epicOf, storyNumberOf, storyTitleOf, toStoryItems } from '@/lib/story-items';

const EPIC8 = 'docs/stories/epic-8-agent-reliability';

describe('epicOf', () => {
  it('reads the number out of the epic directory', () => {
    expect(epicOf(`${EPIC8}/8.1-gate.md`)).toBe(8);
  });

  it('is null for a story outside an epic directory', () => {
    // Not an error: such a story still lists, it just sorts last. The intake
    // refuses to file one, so this is for stories written by hand.
    expect(epicOf('docs/stories/loose.md')).toBeNull();
  });
});

describe('storyNumberOf', () => {
  it('reads the identifier off the filename', () => {
    expect(storyNumberOf(`${EPIC8}/8.1-gate.md`)).toBe('8.1');
  });

  it('handles a three-part identifier', () => {
    expect(storyNumberOf(`${EPIC8}/8.1.2-gate.md`)).toBe('8.1.2');
  });

  it('is null when the filename does not start with one', () => {
    expect(storyNumberOf(`${EPIC8}/gate-hardening.md`)).toBeNull();
  });
});

describe('storyTitleOf', () => {
  it('reads as a story identifier and a name', () => {
    expect(storyTitleOf(`${EPIC8}/8.1-commitment-gate-hardening.md`)).toBe(
      '8.1 — Commitment gate hardening',
    );
  });

  it('falls back to the filename when there is no identifier', () => {
    expect(storyTitleOf(`${EPIC8}/gate-hardening.md`)).toBe('Gate hardening');
  });
});

describe('toStoryItems', () => {
  it('marks a story approved when the artifact sits beside it', () => {
    const items = toStoryItems([`${EPIC8}/8.1-gate.md`], [`${EPIC8}/8.1-gate.approval.json`]);
    expect(items[0].approved).toBe(true);
  });

  it('does not match an approval belonging to a different story', () => {
    const items = toStoryItems([`${EPIC8}/8.1-gate.md`], [`${EPIC8}/8.2-other.approval.json`]);
    expect(items[0].approved).toBe(false);
  });

  it('sorts 8.9 before 8.10', () => {
    // The whole reason the comparison is numeric. localeCompare puts 8.10
    // first, so the next story to pick up would be the wrong one.
    const items = toStoryItems([`${EPIC8}/8.10-later.md`, `${EPIC8}/8.9-earlier.md`]);
    expect(items.map((i) => i.storyNumber)).toEqual(['8.9', '8.10']);
  });

  it('sorts by epic before story number', () => {
    const items = toStoryItems([
      'docs/stories/epic-9-costs/9.1-a.md',
      `${EPIC8}/8.2-b.md`,
      `${EPIC8}/8.1-c.md`,
    ]);
    expect(items.map((i) => i.storyNumber)).toEqual(['8.1', '8.2', '9.1']);
  });

  it('puts stories with no epic last, in path order', () => {
    const items = toStoryItems(['docs/stories/zz.md', 'docs/stories/aa.md', `${EPIC8}/8.1-c.md`]);
    expect(items.map((i) => i.storyPath)).toEqual([
      `${EPIC8}/8.1-c.md`,
      'docs/stories/aa.md',
      'docs/stories/zz.md',
    ]);
  });

  it('keys on the path, which is unique', () => {
    const items = toStoryItems([`${EPIC8}/8.1-gate.md`]);
    expect(items[0].key).toBe(`${EPIC8}/8.1-gate.md`);
  });

  it('leaves an approval file out of the story list', () => {
    // Defence in depth: the lister already splits them, but a caller passing
    // the raw tree must not produce a startable item for an artifact.
    const items = toStoryItems([`${EPIC8}/8.1-gate.md`]);
    expect(items).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run, from `dashboard/`: `npx vitest run __tests__/lib/story-items.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

```ts
/**
 * The picker's story type, and the ordering a work queue wants.
 *
 * `SpecPair` is spec-and-plan shaped throughout — a plan path, a dated
 * `YYYY-MM-DD-<topic>` slug, a title derived from that slug. A story has none
 * of it: no plan, an epic, an identifier like `8.1`, and a name that lives in
 * the filename after that identifier. Forcing both into one neutral type was
 * considered and rejected; a parallel type is the smaller change and keeps the
 * spec path untouched.
 */

/** One story the picker can offer, and whether work can start on it. */
export interface StoryItem {
  /** Repo-relative path to the story. */
  storyPath: string;
  /** Stable identity for the picker. The story path, which is unique. */
  key: string;
  /** Epic number from the containing directory, or null when there isn't one. */
  epic: number | null;
  /** Identifier from the filename, like `8.1`, or null when absent. */
  storyNumber: string | null;
  /** Human title for the issue and the dropdown. */
  title: string;
  /** True when the dispatch gate would let work start. */
  approved: boolean;
  /**
   * True when verification could not be completed — a read that failed for a
   * reason other than the file being absent. Not approved, but not known to be
   * unapproved either, and saying so beats rendering an outage as a decision.
   */
  unverified?: boolean;
}

/** Filename identifier prefix, like `8.1` or `8.1.2`, at the start of a basename. */
const NUMBER_PREFIX = /^(\d+(?:\.\d+)*)-/;

/** Epic directory, like `epic-8-agent-reliability`. */
const EPIC_DIR = /^epic-(\d+)(?:-|$)/;

/**
 * Read the epic number out of a story's containing directory.
 *
 * @param path - Repo-relative story path.
 * @returns The epic number, or null when the story is not in an epic directory.
 */
export function epicOf(path: string): number | null {
  const segments = path.split('/');
  const dir = segments[segments.length - 2] ?? '';
  const match = EPIC_DIR.exec(dir);
  return match ? Number(match[1]) : null;
}

/**
 * Read the story identifier off a story's filename.
 *
 * @param path - Repo-relative story path.
 * @returns The identifier, like `8.1`, or null when the filename has none.
 */
export function storyNumberOf(path: string): string | null {
  const base = (path.split('/').pop() ?? path).replace(/\.md$/, '');
  return NUMBER_PREFIX.exec(base)?.[1] ?? null;
}

/**
 * Turn a story path into something readable in a dropdown.
 *
 * The identifier is kept and set off from the name, because two stories in one
 * epic often differ only by it. `titleFromSlug` cannot be reused: it strips a
 * `YYYY-MM-DD-` prefix a story does not have and leaves the identifier glued
 * to the first word.
 *
 * @param path - Repo-relative story path.
 * @returns `8.1 — Commitment gate hardening`, or just the name when there is
 *   no identifier.
 */
export function storyTitleOf(path: string): string {
  const base = (path.split('/').pop() ?? path).replace(/\.md$/, '');
  const number = storyNumberOf(path);
  const rest = (number === null ? base : base.slice(number.length + 1)).replace(/-/g, ' ').trim();
  const name = rest === '' ? base : rest.charAt(0).toUpperCase() + rest.slice(1);
  return number === null ? name : `${number} — ${name}`;
}

/**
 * Compare two story identifiers segment by segment, numerically.
 *
 * String comparison puts `8.10` before `8.9`, which would offer the wrong
 * story as the next one to pick up.
 *
 * @param a - Identifier, or null.
 * @param b - Identifier, or null.
 * @returns Negative, zero or positive, with null sorting last.
 */
function compareStoryNumbers(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Build the picker's story list, in the order a work queue wants.
 *
 * Ascending: 8.1 before 8.2, epic 8 before epic 9. Specs sort newest-first
 * because an old spec is history; the oldest unstarted story is the next piece
 * of work, so stories sort the other way.
 *
 * `approved` here means only that an artifact sits beside the story. The gate
 * decides for real, and `verifyStoryItems` re-derives this field by running it.
 *
 * @param stories - Repo-relative story paths.
 * @param approvalPaths - Repo-relative `.approval.json` paths found beside them.
 * @returns One item per story, epic and story number ascending.
 */
export function toStoryItems(stories: string[], approvalPaths: string[] = []): StoryItem[] {
  const approved = new Set(approvalPaths);
  return stories
    .map((storyPath) => ({
      storyPath,
      key: storyPath,
      epic: epicOf(storyPath),
      storyNumber: storyNumberOf(storyPath),
      title: storyTitleOf(storyPath),
      // Derived, not matched loosely, so this stays in step with the gate,
      // which reads exactly this file.
      approved: approved.has(`${storyPath.replace(/\.md$/, '')}.approval.json`),
    }))
    .sort((a, b) => {
      if (a.epic !== b.epic) {
        if (a.epic === null) return 1;
        if (b.epic === null) return -1;
        return a.epic - b.epic;
      }
      const byNumber = compareStoryNumbers(a.storyNumber, b.storyNumber);
      return byNumber !== 0 ? byNumber : a.storyPath.localeCompare(b.storyPath);
    });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run, from `dashboard/`: `npx vitest run __tests__/lib/story-items.test.ts`
Expected: PASS, twelve tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/story-items.ts dashboard/__tests__/lib/story-items.test.ts
git commit -m "feat(dashboard): the picker's story type, title and order"
```

---

### Task 6: Verify story items through the real gate (AC-12)

The picker's `approved` flag is not set by the lister. `verifySpecPairs` re-derives it by running `dispatchGateDecision` against the real files, because a stale approval passes a filename check and fails the gate — putting back the round-trip failure the picker exists to remove. A story needs the same treatment through `storyDispatchGateDecision`, which is simpler: no plan, so the cache key covers two blobs instead of a glob.

**Files:**
- Create: `dashboard/lib/verify-story-items.ts`
- Test: `dashboard/__tests__/lib/verify-story-items.test.ts`

**Interfaces:**
- Consumes: `StoryItem[]` from Task 5 and `blobShas` from Task 4.
- Produces:
  ```ts
  export async function verifyStoryItems(
    octokit: Octokit, owner: string, repo: string, ref: string,
    items: StoryItem[], blobShas?: Record<string, string>,
  ): Promise<StoryItem[]>
  ```

- [ ] **Step 1: Write the failing tests**

Create `dashboard/__tests__/lib/verify-story-items.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { verifyStoryItems } from '@/lib/verify-story-items';
import { hashStory } from '@/lib/story-approval';
import type { StoryItem } from '@/lib/story-items';

const STORY = 'docs/stories/epic-8-agent-reliability/8.1-gate.md';
const APPROVAL = 'docs/stories/epic-8-agent-reliability/8.1-gate.approval.json';
const SPEC = 'docs/superpowers/specs/2026-09-09-a-design.md';
const STORY_TEXT = '# Story 8.1 — Gate\n\n**Status:** Approved\n\n- [ ] AC-1: works.\n';

/** An item the listing believed was approved. */
function item(over: Partial<StoryItem> = {}): StoryItem {
  return {
    storyPath: STORY,
    key: STORY,
    epic: 8,
    storyNumber: '8.1',
    title: '8.1 — Gate',
    approved: true,
    ...over,
  };
}

/** A valid story approval over the canonical text. */
function approvalJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    kind: 'story',
    story_path: STORY,
    story_sha256: hashStory(STORY_TEXT),
    source_spec_path: SPEC,
    source_spec_sha256: 'a'.repeat(64),
    review_verdict: 'ok',
    review_rounds: 1,
    approved_by: 'ali@example.com',
    approved_at: '2026-09-09T10:00:00.000Z',
    ...over,
  });
}

/** An octokit whose getContent serves `files`, 404ing on anything else. */
function octokitOver(files: Record<string, string>, fail?: () => never): Octokit {
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (fail) fail();
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error('nope'), { status: 404 });
    return { data: { content: Buffer.from(text, 'utf8').toString('base64') } };
  });
  return { repos: { getContent } } as unknown as Octokit;
}

describe('verifyStoryItems', () => {
  it('approves a story whose hash still matches', async () => {
    const octokit = octokitOver({ [STORY]: STORY_TEXT, [APPROVAL]: approvalJson() });
    const [result] = await verifyStoryItems(octokit, 'o', 'r', 'main', [item()]);
    expect(result.approved).toBe(true);
    expect(result.unverified).toBe(false);
  });

  it('refuses a story edited since approval', async () => {
    const octokit = octokitOver({
      [STORY]: `${STORY_TEXT}\nAn extra line nobody approved.\n`,
      [APPROVAL]: approvalJson(),
    });
    const [result] = await verifyStoryItems(octokit, 'o', 'r', 'main', [item()]);
    expect(result.approved).toBe(false);
    expect(result.unverified).toBe(false);
  });

  it('still approves after only the status line changed', async () => {
    // The central property. dev-agent rewrites this line as the issue moves,
    // so a projection must not invalidate the approval it is projecting.
    const octokit = octokitOver({
      [STORY]: STORY_TEXT.replace('**Status:** Approved', '**Status:** InProgress'),
      [APPROVAL]: approvalJson(),
    });
    const [result] = await verifyStoryItems(octokit, 'o', 'r', 'main', [item()]);
    expect(result.approved).toBe(true);
  });

  it('refuses a story whose artifact is not there', async () => {
    const octokit = octokitOver({ [STORY]: STORY_TEXT });
    const [result] = await verifyStoryItems(octokit, 'o', 'r', 'main', [item()]);
    expect(result.approved).toBe(false);
    expect(result.unverified).toBe(false);
  });

  it('reports a read it could not complete as unverified, not unapproved', async () => {
    // Two different facts: the gate refused, versus the gate never ran.
    // Rendering the second as the first hides approved work behind an outage.
    const octokit = octokitOver({}, () => {
      throw Object.assign(new Error('rate limit'), { status: 403 });
    });
    const [result] = await verifyStoryItems(octokit, 'o', 'r', 'main', [item()]);
    expect(result.approved).toBe(false);
    expect(result.unverified).toBe(true);
  });

  it('reads nothing when no item carries an artifact', async () => {
    const getContent = vi.fn();
    const octokit = { repos: { getContent } } as unknown as Octokit;
    const result = await verifyStoryItems(octokit, 'o', 'r', 'main', [item({ approved: false })]);
    expect(getContent).not.toHaveBeenCalled();
    expect(result[0].approved).toBe(false);
  });

  it('serves a second identical call from cache', async () => {
    const files = { [STORY]: STORY_TEXT, [APPROVAL]: approvalJson() };
    const shas = { [STORY]: 'story-sha-1', [APPROVAL]: 'approval-sha-1' };
    const octokit = octokitOver(files);
    await verifyStoryItems(octokit, 'o', 'r', 'main', [item()], shas);
    const before = (octokit.repos.getContent as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await verifyStoryItems(octokit, 'o', 'r', 'main', [item()], shas);
    expect(
      (octokit.repos.getContent as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(before);
  });

  it('does not serve a cached verdict after the story changes', async () => {
    const octokit = octokitOver({ [STORY]: STORY_TEXT, [APPROVAL]: approvalJson() });
    await verifyStoryItems(octokit, 'o', 'r', 'main', [item()], {
      [STORY]: 'sha-a',
      [APPROVAL]: 'approval-sha-2',
    });
    const before = (octokit.repos.getContent as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await verifyStoryItems(octokit, 'o', 'r', 'main', [item()], {
      [STORY]: 'sha-b',
      [APPROVAL]: 'approval-sha-2',
    });
    expect(
      (octokit.repos.getContent as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run, from `dashboard/`: `npx vitest run __tests__/lib/verify-story-items.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

```ts
import 'server-only';

import type { Octokit } from '@octokit/rest';

import { approvalPathForStory, hashStory, storyDispatchGateDecision } from './story-approval';
import type { StoryItem } from './story-items';

/**
 * Decide which stories the dispatch path would actually accept.
 *
 * The presence of an artifact is not approval. The gate checks the recorded
 * verdict is clean, the schema is one it understands, the recorded path is the
 * one being dispatched, and the story still hashes to what was approved. A
 * stale approval passes a filename check and fails the gate, which is exactly
 * the round-trip failure the picker exists to remove.
 *
 * Only stories that already carry an artifact are read, so a repo with a
 * hundred unapproved stories makes no calls at all.
 */

/** How many stories to verify at once. A concurrency limit, not a cap. */
const BATCH = 25;

/** Most cached verdicts to keep, across every repo in the process. */
const CACHE_LIMIT = 2000;

/**
 * Verdicts keyed by the content that produced them.
 *
 * A verdict is a function of two blob SHAs, so it never goes stale: editing
 * either file changes its SHA and misses the cache. Insertion-ordered, so
 * evicting the oldest key is the whole eviction policy.
 */
const verdictCache = new Map<string, boolean>();

/**
 * Record a verdict against the content it was derived from.
 *
 * @param key - Content-addressed cache key.
 * @param approved - What the gate decided.
 */
function cacheVerdict(key: string, approved: boolean): void {
  verdictCache.delete(key);
  verdictCache.set(key, approved);
  while (verdictCache.size > CACHE_LIMIT) {
    const oldest = verdictCache.keys().next();
    if (oldest.done) break;
    verdictCache.delete(oldest.value);
  }
}

/**
 * Build the content-addressed key for a story, when the SHAs allow one.
 *
 * The path is part of the key, not just the bytes: the gate compares the
 * approval's recorded story path against the one being dispatched, so the same
 * blobs copied elsewhere are a different decision.
 *
 * @param blobShas - Path-to-blob-SHA map from the tree listing.
 * @param storyPath - The story.
 * @param approvalPath - The artifact beside it.
 * @returns The key, or null when either SHA is unknown.
 */
function cacheKey(
  blobShas: Record<string, string> | undefined,
  storyPath: string,
  approvalPath: string,
): string | null {
  if (!blobShas) return null;
  const story = blobShas[storyPath];
  const approval = blobShas[approvalPath];
  if (story === undefined || approval === undefined) return null;
  return `${storyPath}|${story}|${approval}`;
}

/**
 * Read a repo file, or null when it is not there.
 *
 * @returns The decoded text, or null on 404.
 * @throws On any non-404 error, so an unreadable repo is not mistaken for an
 *   unapproved one.
 */
async function readText(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/** What verifying one story concluded. */
interface Verdict {
  /** True only when the gate would let dispatch proceed. */
  approved: boolean;
  /** True when a read failed for a reason other than the file being absent. */
  unverified: boolean;
}

/**
 * Re-derive `approved` on each story by running the real gate decision.
 *
 * A story whose reads fail comes back `approved: false, unverified: true`.
 * Those are different facts: one says the gate refused, the other says the
 * gate never ran.
 *
 * @param octokit - Authenticated client.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param ref - Branch the files live on.
 * @param items - Output of `toStoryItems`.
 * @param blobShas - Optional path-to-blob-SHA map from the tree listing, used
 *   to serve unchanged stories from cache instead of re-reading them.
 * @returns The same items, with `approved` reflecting what dispatch would do.
 */
export async function verifyStoryItems(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  items: StoryItem[],
  blobShas?: Record<string, string>,
): Promise<StoryItem[]> {
  const candidates = items.filter((i) => i.approved);
  if (candidates.length === 0) {
    return items.map((i) => ({ ...i, approved: false, unverified: false }));
  }

  const verdicts = new Map<string, Verdict>();

  const verifyOne = async (story: StoryItem): Promise<void> => {
    const approvalPath = approvalPathForStory(story.storyPath);
    const key = cacheKey(blobShas, story.storyPath, approvalPath);
    if (key !== null) {
      const hit = verdictCache.get(key);
      if (hit !== undefined) {
        verdicts.set(story.key, { approved: hit, unverified: false });
        return;
      }
    }

    try {
      const [storyText, approvalRaw] = await Promise.all([
        readText(octokit, owner, repo, story.storyPath, ref),
        readText(octokit, owner, repo, approvalPath, ref),
      ]);

      if (storyText === null) {
        verdicts.set(story.key, { approved: false, unverified: false });
        if (key !== null) cacheVerdict(key, false);
        return;
      }

      // The gate reads the story alone — never the source spec. A late
      // amendment to a program spec must not invalidate every story derived
      // from it, which is the whole asymmetry this design rests on.
      const decision = storyDispatchGateDecision({
        approvalRaw,
        currentStoryHash: hashStory(storyText),
        storyPath: story.storyPath,
      });
      verdicts.set(story.key, { approved: decision.allow, unverified: false });
      if (key !== null) cacheVerdict(key, decision.allow);
    } catch {
      // A read we could not complete is not an approval, and not a refusal
      // either. Caching it would make one rate-limited render stick.
      verdicts.set(story.key, { approved: false, unverified: true });
    }
  };

  // eslint-disable-next-line no-restricted-syntax -- batches run in sequence so
  // a repo with many approvals does not open every read at once.
  for (let i = 0; i < candidates.length; i += BATCH) {
    await Promise.all(candidates.slice(i, i + BATCH).map(verifyOne));
  }

  return items.map((i) => {
    const verdict = verdicts.get(i.key);
    return {
      ...i,
      approved: verdict?.approved === true,
      unverified: verdict?.unverified === true,
    };
  });
}
```

Note for the implementer: `approvalPathForStory` throws on a path that does not end in `.md`. Every path here comes from the lister, which filters on that suffix, so it cannot throw — but if you add another caller, that contract is yours to keep.

- [ ] **Step 4: Run the tests to verify they pass**

Run, from `dashboard/`: `npx vitest run __tests__/lib/verify-story-items.test.ts`
Expected: PASS, eight tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/verify-story-items.ts dashboard/__tests__/lib/verify-story-items.test.ts
git commit -m "feat(dashboard): re-derive story approval through the real gate"
```

---

### Task 7: Find the issue a story was already filed under (AC-12)

`dispatchFromSpec` does not create an issue when one already exists — the intake files a `state:spec-ready` issue the moment it records an approval, and that issue's own body says to press **Start work**. Creating a second one would start a second run and leave the first in the queue for ever. The story path needs the same lookup, against `Story:` instead of `Spec:`.

Two helpers in `find-spec-issue.ts` are already kind-agnostic in everything but their parameter type. Widen them rather than copying them.

**Files:**
- Create: `dashboard/lib/find-story-issue.ts`
- Modify: `dashboard/lib/find-spec-issue.ts` (widen `isWaitingToStart` and `stateLabel`)
- Test: `dashboard/__tests__/lib/find-story-issue.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StoryIssue {
    number: number; html_url: string; body: string | null;
    labels: string[]; open: boolean; title: string;
  }
  export async function findIssuesForStory(
    octokit: Octokit, owner: string, repo: string, storyPath: string,
  ): Promise<StoryIssue[]>
  ```
- Consumes: `isWaitingToStart` and `stateLabel` from `find-spec-issue.ts`, after the widening below.

- [ ] **Step 1: Widen the two shared helpers**

In `dashboard/lib/find-spec-issue.ts`, change the two signatures so both issue kinds satisfy them. This is a widening: every existing caller still type-checks.

```ts
/** The parts of an issue these helpers read, whichever kind it is. */
export interface TrackedIssue {
  /** Whether the issue is still open. */
  open: boolean;
  /** Current labels. */
  labels: string[];
}
```

Then change `isWaitingToStart(issue: SpecIssue)` to `isWaitingToStart(issue: TrackedIssue)` and `stateLabel(issue: SpecIssue)` to `stateLabel(issue: Pick<TrackedIssue, 'labels'>)`. Update their docstrings to say they read any tracked issue. Leave their bodies alone.

- [ ] **Step 2: Write the failing tests**

Create `dashboard/__tests__/lib/find-story-issue.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { findIssuesForStory } from '@/lib/find-story-issue';

const STORY = 'docs/stories/epic-8-agent-reliability/8.1-gate.md';

/** An octokit whose paginate returns `issues`. */
function octokitOver(issues: unknown[]): Octokit {
  return {
    paginate: vi.fn(async () => issues),
    issues: { listForRepo: {} },
  } as unknown as Octokit;
}

/** A minimal issue payload. */
function issue(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    html_url: 'https://example.test/7',
    body: `Story: ${STORY}\n`,
    labels: [{ name: 'state:spec-ready' }],
    state: 'open',
    title: '8.1 — Gate',
    ...over,
  };
}

describe('findIssuesForStory', () => {
  it('matches the issue that names the story', async () => {
    const found = await findIssuesForStory(octokitOver([issue()]), 'o', 'r', STORY);
    expect(found.map((i) => i.number)).toEqual([7]);
  });

  it('includes closed issues', async () => {
    // A story that already shipped keeps its artifact on disk while its issue
    // is closed. An open-only lookup files a fresh issue and implements
    // shipped work a second time.
    const found = await findIssuesForStory(
      octokitOver([issue({ state: 'closed' })]), 'o', 'r', STORY,
    );
    expect(found).toHaveLength(1);
    expect(found[0].open).toBe(false);
  });

  it('ignores a pull request that quotes the story', async () => {
    const found = await findIssuesForStory(
      octokitOver([issue({ pull_request: { url: 'x' } })]), 'o', 'r', STORY,
    );
    expect(found).toEqual([]);
  });

  it('ignores a story path quoted inside a fenced block', async () => {
    // Goes through parseStoryRef, the same parser the gate and the workflow
    // use, so the panel cannot decide an issue is about one story while the
    // gate reads it as another.
    const body = ['Story: docs/stories/epic-9-x/9.1-other.md', '', '```', `Story: ${STORY}`, '```'].join('\n');
    const found = await findIssuesForStory(octokitOver([issue({ body })]), 'o', 'r', STORY);
    expect(found).toEqual([]);
  });

  it('ignores a spec issue', async () => {
    const found = await findIssuesForStory(
      octokitOver([issue({ body: 'Spec: docs/specs/a-design.md\n' })]), 'o', 'r', STORY,
    );
    expect(found).toEqual([]);
  });

  it('returns every match, oldest first', async () => {
    // Not just the oldest. A repo that already carries the duplicate this
    // exists to stop has an old spec-ready issue and a newer one implementing;
    // collapsing to the lowest number throws away the evidence work started.
    const found = await findIssuesForStory(
      octokitOver([issue({ number: 9 }), issue({ number: 4 })]), 'o', 'r', STORY,
    );
    expect(found.map((i) => i.number)).toEqual([4, 9]);
  });

  it('lets a listing failure propagate', async () => {
    // An unreadable issue list is not an absent issue. Swallowing it files
    // the duplicate this function exists to prevent.
    const octokit = {
      paginate: vi.fn(async () => {
        throw new Error('rate limit');
      }),
      issues: { listForRepo: {} },
    } as unknown as Octokit;
    await expect(findIssuesForStory(octokit, 'o', 'r', STORY)).rejects.toThrow('rate limit');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run, from `dashboard/`: `npx vitest run __tests__/lib/find-story-issue.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Write the module**

```ts
import 'server-only';

import type { Octokit } from '@octokit/rest';

import { parseStoryRef } from './spec-approval-gate';

/**
 * Finding the issue a story was already filed under.
 *
 * The intake files a `state:spec-ready` issue the moment it records an
 * approval, and that issue's own body says to press **Start work**. Creating a
 * second one here would start a second run against the same story and leave
 * the original sitting in the queue with nobody coming back for it.
 */

/** An issue that already names a given story. */
export interface StoryIssue {
  /** Issue number. */
  number: number;
  /** Link, for the error path to point at. */
  html_url: string;
  /** Body as filed, so the gate reads the same text the workflow will. */
  body: string | null;
  /** Current labels, including any approval override a human added. */
  labels: string[];
  /** Whether the issue is still open. */
  open: boolean;
  /** Current title, so a reuse only renames when the user asked for a change. */
  title: string;
}

/**
 * Find every issue whose body declares this story, open or closed.
 *
 * Closed ones count: a story that has already been through the pipeline keeps
 * its approval artifact on disk while its issue is closed, so an open-only
 * lookup finds nothing and implements shipped work again.
 *
 * Matching goes through `parseStoryRef`, the same parser the approval gate and
 * the implement workflow use, so the panel cannot decide an issue is about one
 * story while the gate reads it as another. A path quoted inside a fenced
 * block or backticks does not count, for that reason.
 *
 * @param octokit - Authenticated client.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param storyPath - Repo-relative story path to match.
 * @returns Matching issues, open and closed, oldest first.
 * @throws Whatever the listing throws — an unreadable issue list is not the
 *   same as an absent issue, and treating it as one files a duplicate.
 */
export async function findIssuesForStory(
  octokit: Octokit,
  owner: string,
  repo: string,
  storyPath: string,
): Promise<StoryIssue[]> {
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    per_page: 100,
  });

  return issues
    // A pull request is an issue as far as this endpoint is concerned, and a
    // PR quoting the story path is not the handoff issue.
    .filter((i) => !('pull_request' in i && i.pull_request))
    .filter((i) => parseStoryRef(i.body)?.story_path === storyPath)
    .sort((a, b) => a.number - b.number)
    .map((issue) => ({
      number: issue.number,
      html_url: issue.html_url,
      body: issue.body ?? null,
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      open: issue.state === 'open',
      title: issue.title,
    }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run, from `dashboard/`: `npx vitest run __tests__/lib/find-story-issue.test.ts __tests__/lib/find-spec-issue.test.ts`
Expected: PASS. The spec-side tests must still pass — the widening is not allowed to change their behaviour.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/find-story-issue.ts dashboard/lib/find-spec-issue.ts dashboard/__tests__/lib/find-story-issue.test.ts
git commit -m "feat(dashboard): find the issue a story was filed under"
```

---

### Task 8: `dispatchFromStory` (AC-12)

A sibling of `dispatchFromSpec`, not a generalisation of it. It is shorter, because a story has no plan and therefore no plan reconciliation: `dispatchFromSpec` rewrites a reused issue's `Plan:` line when the approval names a different plan, and there is nothing here to rewrite.

Everything else carries across unchanged, and every one of these guards exists because it was needed: work-already-started detection including closed issues, the active-run check that fails closed, the gate run **before** any issue is created so a refusal leaves no orphan, and the label flip whose failure is warned about rather than thrown.

**Files:**
- Modify: `dashboard/lib/actions.ts`
- Test: `dashboard/__tests__/lib/actions-dispatch-from-story.test.ts`

**Interfaces:**
- Consumes: `findIssuesForStory` (Task 7), `isWaitingToStart`, `stateLabel`, `evaluateSpecApproval`, `epicOf` (Task 5).
- Produces: `export async function dispatchFromStory(formData: FormData): Promise<ApproveAndStartError | void>`, reading `repo`, `story_path`, `title`, `custom_title`.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/__tests__/lib/actions-dispatch-from-story.test.ts`. Follow whatever mocking shape the existing `actions` tests in `dashboard/__tests__/lib/` already use — read one first and match it rather than inventing a second harness. Cover exactly these cases:

```
1. refuses with 'story_path is required' when the field is blank
2. refuses when the story is not on the default branch, naming the path
3. refuses when the gate refuses, and creates no issue  (assert issues.create was not called)
4. reuses the spec-ready issue the intake filed instead of creating a second one
5. refuses when a matching issue has already moved past spec-ready, naming its state
6. refuses when a matching issue is closed, saying the story already went through the pipeline
7. refuses when a matching issue already has an active run, naming the count
8. creates an issue carrying `Story: <path>` and no `Spec:` line when there is none
9. labels a created issue kind:feature, state:spec-ready and epic:8 for an epic-8 story
10. omits the epic label when the story is not in an epic directory
11. dispatches dev-agent.yml with phase=implement and the issue number
12. flips the issue to state:implementing, keeping its non-state labels
13. does not throw when the label flip fails after a successful dispatch
14. accepts a `./`-prefixed story_path and files the issue with the canonical spelling
```

Case 3 is the load-bearing one: an issue created before a refusal is an orphan in the queue that nothing comes back for.

- [ ] **Step 2: Run the tests to verify they fail**

Run, from `dashboard/`: `npx vitest run __tests__/lib/actions-dispatch-from-story.test.ts`
Expected: FAIL — `dispatchFromStory` is not exported.

- [ ] **Step 3: Write the action**

Add to `dashboard/lib/actions.ts`, directly after `dispatchFromSpec`. Import `findIssuesForStory` from `./find-story-issue`, `epicOf` from `./story-items`, and `canonicalStoryPath` from `./story-approval`.

```ts
/**
 * Start work on an approved story, from the repo page's story list.
 *
 * A sibling of `dispatchFromSpec` rather than a generalisation of it. A story
 * has no plan, so there is no plan reconciliation and no `Plan:` line to bring
 * into line with the approval; everything else — reuse over creation, the
 * closed-issue check, the active-run check, gating before creation — is the
 * same set of guards, each of which exists because it was needed.
 *
 * @param formData - `repo`, `story_path`, `title`, `custom_title`.
 * @returns An error to render inline, or nothing before redirecting.
 */
export async function dispatchFromStory(
  formData: FormData,
): Promise<ApproveAndStartError | void> {
  let issueNumberForRedirect: number | null = null;
  let repoFullForRedirect: string | null = null;
  let issueUrl: string | null = null;

  try {
    const session_username = await getCurrentUsername();
    const octokit = await getOctokit();
    const repoFull = (formData.get('repo') as string).trim();
    // Canonicalised, as every other reader of a story path is: the approval
    // records the path without a leading `./`, so an uncanonical spelling
    // would pass the existence check and then refuse at the gate.
    const story_path = canonicalStoryPath((formData.get('story_path') as string).trim());
    const title = (formData.get('title') as string).trim();
    const custom_title = ((formData.get('custom_title') as string) ?? '').trim();
    if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
    if (!story_path) return { error: 'story_path is required' };
    if (!title) return { error: 'title is required' };

    const [owner, repo] = repoFull.split('/');
    await assertWritePermission(octokit, owner, repo, session_username);

    const repoData = await wrapStep('looking up repo', () => octokit.repos.get({ owner, repo }));
    const default_branch = repoData.data.default_branch;

    const storyExists = await fileExistsOnBranch(
      octokit, owner, repo, story_path, default_branch,
    );
    if (!storyExists) {
      return { error: `story_path not found on ${default_branch}: ${story_path}` };
    }

    const body = [
      `Story: ${story_path}`,
      '',
      '## TL;DR',
      '',
      `Implementing the story at \`${story_path}\`.`,
      '',
      'Filed from the dashboard "Start work on an approved story" panel.',
    ].join('\n');

    const matching = await wrapStep('looking for the issue this story was filed under', () =>
      findIssuesForStory(octokit, owner, repo, story_path),
    );

    const started = matching.find((i) => !isWaitingToStart(i));
    if (started) {
      const why = started.open
        ? `is at ${stateLabel(started) ?? 'an unknown state'}`
        : 'is closed, so this story has already been through the pipeline';
      return {
        error: `work has already started on this story — issue #${started.number} ${why}`,
        issue_url: started.html_url,
      };
    }

    for (const candidate of matching) {
      // Fail-closed: a run list this cannot read is not an empty one.
      const activeRuns = await wrapStep('checking for runs already in flight', () =>
        fetchActiveRunsForIssue(octokit, owner, repo, candidate.number, { strict: true }),
      );
      if (activeRuns.length > 0) {
        const phases = activeRuns.map((r) => r.phase ?? 'unknown').join(', ');
        return {
          error: `dispatch refused — issue #${candidate.number} already has ${activeRuns.length} active run(s) (${phases}). Wait for them to finish.`,
          issue_url: candidate.html_url,
        };
      }
    }

    const existing = matching[0] ?? null;

    // Run before anything is created. A refusal must not leave an orphan
    // `state:spec-ready` issue behind that nothing comes back for. On the
    // reuse path the real issue's labels are read, so an override a human
    // applied counts; on the create path there is no issue and no override.
    const gate = await wrapStep('checking story approval', () =>
      evaluateSpecApproval({
        octokit,
        owner,
        repo,
        ref: default_branch,
        issueBody: existing?.body ?? body,
        labels: existing?.labels ?? [],
      }),
    );
    if (!gate.allow) {
      return { error: `work cannot start — ${gate.message}` };
    }

    let issue_number: number;
    if (existing) {
      issue_number = existing.number;
      issueUrl = existing.html_url;
      if (custom_title && custom_title !== existing.title) {
        await wrapStep('renaming the issue', () =>
          octokit.issues.update({ owner, repo, issue_number, title: custom_title }),
        );
      }
    } else {
      // The epic label is what stops eight stories from one program appearing
      // as eight unrelated items. Omitted rather than guessed when the story
      // is not in an epic directory: a wrong epic groups work incorrectly,
      // which is worse than not grouping it.
      const epic = epicOf(story_path);
      const created = await wrapStep('creating spec-ready issue', () =>
        octokit.issues.create({
          owner,
          repo,
          title,
          body,
          labels: [
            'kind:feature',
            'state:spec-ready',
            ...(epic === null ? [] : [`epic:${epic}`]),
          ],
        }),
      );
      issue_number = created.data.number;
      issueUrl = created.data.html_url;
    }

    await wrapStep('dispatching implement workflow', () =>
      octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: 'dev-agent.yml',
        ref: default_branch,
        inputs: {
          phase: 'implement',
          issue_number: String(issue_number),
          invocation_mode: 'live',
        },
      }),
    );

    const keptLabels = (existing?.labels ?? ['kind:feature']).filter(
      (l) => !l.startsWith('state:'),
    );
    const nextLabels = [...keptLabels, 'state:implementing'];
    try {
      await octokit.issues.setLabels({ owner, repo, issue_number, labels: nextLabels });
    } catch (err) {
      // The run is already dispatched. Throwing here would report a failure
      // that did not happen and invite a second click.
      console.warn(
        `dispatchFromStory: state:implementing label flip failed for ${owner}/${repo}#${issue_number} (run is already dispatched):`,
        err,
      );
    }

    issueNumberForRedirect = issue_number;
    repoFullForRedirect = repoFull;
  } catch (e) {
    const message = formatApproveError(e, issueUrl);
    console.error('[dispatchFromStory] failed', {
      message,
      issueUrl,
      raw: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
    });
    return { error: message, ...(issueUrl ? { issue_url: issueUrl } : {}) };
  }

  revalidatePath('/');
  redirect(`/features/${issueNumberForRedirect}?repo=${encodeURIComponent(repoFullForRedirect!)}`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run, from `dashboard/`: `npx vitest run __tests__/lib/actions-dispatch-from-story.test.ts`
Expected: PASS, fourteen cases.

- [ ] **Step 5: Run the whole dashboard suite**

Run, from `dashboard/`: `npx vitest run`
Expected: PASS. `actions.ts` is imported widely; a broken import surfaces here.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/actions.ts dashboard/__tests__/lib/actions-dispatch-from-story.test.ts
git commit -m "feat(dashboard): dispatch an approved story"
```

---

### Task 9: The panel's second section and the page that feeds it (AC-12, AC-13)

The panel grows a second section beside the first. Both sections keep their own selection state and submit to their own action. The "nothing here yet" copy has to work when one list is empty and the other is not, which the current single-list branch cannot express.

**Files:**
- Modify: `dashboard/components/start-from-spec-panel.tsx`
- Modify: `dashboard/app/repos/[name]/page.tsx`
- Test: `dashboard/__tests__/components/start-from-spec-panel.test.tsx`

**Interfaces:**
- Consumes: `StoryItem[]` (Task 5) and `dispatchFromStory` (Task 8).
- Produces: the panel gains `stories?: StoryItem[]` and `storyListingIncomplete?: boolean`. Both default so the component's existing call sites keep compiling.

- [ ] **Step 1: Write the failing tests**

There is no test file for this component yet. Create `dashboard/__tests__/components/start-from-spec-panel.test.tsx`, copying the render-and-query harness from `dashboard/__tests__/components/inbox-item.test.tsx` rather than inventing one. Cover:

```
1. renders the story section when an approved story is passed
2. does not render the story section at all when no story is approved and none exists
   (a repo with no docs/stories tree must not grow an empty control)
3. says the story list may be short when storyListingIncomplete is true
4. counts unverified stories apart from unapproved ones, in the story section's copy
5. submits story_path for the selected story
6. keeps the spec section's behaviour unchanged when only specs are passed
   (this is the regression guard — every existing consumer sees exactly this)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run, from `dashboard/`: `npx vitest run __tests__/components/start-from-spec-panel.test.tsx`
Expected: FAIL on the story assertions; the spec ones pass already.

- [ ] **Step 3: Extend the panel**

Keep the existing spec section exactly as it is. Add, after it:

- `const approvedStories = useMemo(() => stories.filter((s) => s.approved), [stories])`
- `const unverifiedStories = useMemo(() => stories.filter((s) => s.unverified).length, [stories])`
- a second `useState` for the selected story key and a second for its title override
- the section renders only when `stories.length > 0`, so a repo with no story tree is unchanged
- inside it, a `<form>` submitting to `dispatchFromStory` with hidden `repo`, `story_path`, `title`, `custom_title`, mirroring the spec form's two-field title handling verbatim
- the same `role="alert"` error paragraph, with its own state

The heading is "Start work on an approved story". The empty-but-present case — stories exist, none approved — reuses the spec section's wording, pointing at the Claude Code session where approval happens.

- [ ] **Step 4: Wire the page**

In `dashboard/app/repos/[name]/page.tsx`:

```ts
// Stories are listed from the directory the consumer's own config names, and
// verified through the story gate — the same treatment specs get, because the
// presence of an artifact is not approval.
const artifactsConfig = repo.wired_up
  ? await readArtifactsConfig(octokit, repo.owner, repo.name, repo.default_branch)
  : { storiesDir: 'docs/stories', unreadable: false };

const storyFiles = repo.wired_up
  ? await listStoryFiles(
      octokit, repo.owner, repo.name, repo.default_branch, artifactsConfig.storiesDir,
    )
  : { stories: [], approvals: [], blobShas: {}, unreadable: false };

const storyItems = await verifyStoryItems(
  octokit,
  repo.owner,
  repo.name,
  repo.default_branch,
  toStoryItems(storyFiles.stories, storyFiles.approvals),
  storyFiles.blobShas,
).catch(() => []);
```

and pass them through:

```tsx
<StartFromSpecPanel
  repo={name}
  pairs={specPairs}
  listingIncomplete={specPlanFiles.unreadable}
  stories={storyItems}
  storyListingIncomplete={artifactsConfig.unreadable || storyFiles.unreadable}
/>
```

Note for the implementer: `listStoryFiles` and `readArtifactsConfig` never reject — they return `unreadable: true` instead — so neither needs a `.catch`. `verifyStoryItems` can reject, and the existing `.catch(() => [])` on `verifySpecPairs` is the pattern to match. Fold these two reads into the existing `Promise.all` at the top of the function if it is straightforward; if the config-then-listing dependency makes that awkward, leave them sequential and say so in the report rather than restructuring the page.

- [ ] **Step 5: Run the tests to verify they pass**

Run, from `dashboard/`: `npx vitest run && npm run typecheck`
Expected: PASS, both.

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/start-from-spec-panel.tsx dashboard/app/repos/\[name\]/page.tsx dashboard/__tests__/components/start-from-spec-panel.test.tsx
git commit -m "feat(dashboard): a second list, for approved stories"
```

---

### Task 10: Write the status line, and stop comparing what the approval ignores (AC-15)

Two small CLIs, both of which exist so the status-line grammar stays in one place.

`stamp-story-status` writes the line. It reuses `stampStatus` from `approve-story.ts`, which validates the status against `STORY_STATUS_VALUES` and replaces via the shared `STATUS_LINE_RE`.

`compare-approved-text` replaces the `cmp -s` at `phase-implement.yml:524` for the document path. That comparison is byte-exact, and it will hard-fail the moment the status line is stamped — on a difference the approval was deliberately built to ignore. Comparing `storyBodyForHashing` instead compares exactly what the approval binds. This is not a loosening: it is the same predicate the gate uses.

**Files:**
- Create: `lib/cli/stamp-story-status.ts`
- Create: `lib/cli/compare-approved-text.ts`
- Test: `tests/unit/stamp-story-status.test.ts`
- Test: `tests/unit/compare-approved-text.test.ts`

**Interfaces:**
- Consumes: `stampStatus` from `lib/cli/approve-story.ts`; `STATUS_LINE_RE` and `storyBodyForHashing` from `lib/story-approval.ts`.
- Produces: two CLIs driven by environment variables, matching `verify-approval.ts`'s shape — including the `fileURLToPath(import.meta.url)` entry guard, which is what makes them importable from tests without executing.

- [ ] **Step 1: Write the failing tests**

`tests/unit/stamp-story-status.test.ts`:

```
1. rewrites **Status:** Approved to **Status:** InProgress
2. leaves the rest of the file byte-identical
3. does not change the story's hash  (hashStory before === hashStory after — the
   whole point: a projection must not invalidate the approval it projects)
4. exits 2 when STORY_PATH is unset
5. exits 2 when STATUS is not one of STORY_STATUS_VALUES
6. exits 1 when the story has no status line at all, saying so
   (silently succeeding would report a projection that never happened)
7. exits 0 and writes nothing when the line already says the target status
8. exits 1 when the story does not exist, naming the path
```

Case 6 needs the CLI to test `STATUS_LINE_RE` itself before stamping: `stampStatus` returns the text unchanged when nothing matches, which is indistinguishable from case 7 by its return value alone.

`tests/unit/compare-approved-text.test.ts`:

```
1. exits 0 for two byte-identical stories
2. exits 0 when the two differ only in their status line, with KIND=story
3. exits 1 when the two differ elsewhere, with KIND=story
4. exits 1 when the two differ only in their status line, with KIND=spec
   (the discriminating test: the story rule must not leak onto the spec path)
5. exits 2 when KIND is neither
6. exits 1 when either file is missing, naming which
```

Case 4 is the regression guard for every shipped consumer repo.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/stamp-story-status.test.ts tests/unit/compare-approved-text.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Write `lib/cli/stamp-story-status.ts`**

```ts
#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { STATUS_LINE_RE, STORY_STATUS_VALUES } from '../story-approval';
import { stampStatus } from './approve-story';

/**
 * stamp-story-status — write a story's `**Status:**` line to reflect where its
 * issue has got to.
 *
 * The artifact is authoritative and the status line is a projection of issue
 * state, which is why the hash deliberately excludes it. That is what makes
 * this safe to run at every transition: it cannot invalidate the approval it
 * is projecting.
 *
 * Environment:
 * - `STORY_PATH` — repo-relative path to the story. Required.
 * - `STATUS` — one of `STORY_STATUS_VALUES`. Required.
 *
 * Exit codes match `verify-approval`: 0 written or already correct, 1 the
 * story could not be stamped, 2 the invocation was wrong.
 *
 * @throws On a usage error, which the entry guard turns into exit 2.
 */
function main(): void {
  const storyPath = process.env.STORY_PATH?.trim() ?? '';
  const status = process.env.STATUS?.trim() ?? '';
  if (storyPath === '') throw new Error('STORY_PATH is required');
  if (!(STORY_STATUS_VALUES as readonly string[]).includes(status)) {
    throw new Error(
      `STATUS must be one of ${STORY_STATUS_VALUES.join(', ')}; got ${JSON.stringify(status)}`,
    );
  }

  let text: string;
  try {
    text = readFileSync(storyPath, 'utf8');
  } catch {
    process.stderr.write(`${storyPath} could not be read\n`);
    process.exit(1);
  }

  // Checked here rather than inferred from stampStatus returning the text
  // unchanged, which a story already at the target status also produces. A
  // story with no status line cannot carry the projection at all, and
  // reporting success would claim work that did not happen.
  STATUS_LINE_RE.lastIndex = 0;
  if (!STATUS_LINE_RE.test(text)) {
    process.stderr.write(
      `${storyPath} has no **Status:** line, so its status cannot be projected. ` +
        'Add one from the story template.\n',
    );
    process.exit(1);
  }

  const stamped = stampStatus(text, status);
  if (stamped === text) {
    process.stdout.write(`${storyPath} already reads ${status}\n`);
    process.exit(0);
  }
  writeFileSync(storyPath, stamped);
  process.stdout.write(`${storyPath} -> ${status}\n`);
  process.exit(0);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `stamp-story-status failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}
```

- [ ] **Step 4: Write `lib/cli/compare-approved-text.ts`**

```ts
#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { storyBodyForHashing } from '../story-approval';

/**
 * compare-approved-text — check the base-branch copy of an approved document
 * against the agent branch's.
 *
 * The implement workflow proves the base copy is approved, then hands the
 * agent the working-tree copy. Approved text on one branch and different text
 * on the other would undo the whole binding, so the two must match.
 *
 * For a story, "match" means what the approval means: the hashed body, which
 * excludes the `**Status:**` line because dev-agent rewrites it as the issue
 * moves. A byte comparison would hard-fail on precisely the difference the
 * approval was built to ignore. For a spec it stays byte-exact, which is what
 * every consumer repo has today.
 *
 * Environment:
 * - `BASE_PATH` — the base-branch copy. Required.
 * - `HEAD_PATH` — the working-tree copy. Required.
 * - `KIND` — `story` or `spec`. Required.
 *
 * Exit codes: 0 they match, 1 they differ or a file is unreadable, 2 the
 * invocation was wrong.
 *
 * @throws On a usage error, which the entry guard turns into exit 2.
 */
function main(): void {
  const basePath = process.env.BASE_PATH?.trim() ?? '';
  const headPath = process.env.HEAD_PATH?.trim() ?? '';
  const kind = process.env.KIND?.trim() ?? '';
  if (basePath === '' || headPath === '') {
    throw new Error('BASE_PATH and HEAD_PATH are both required');
  }
  if (kind !== 'story' && kind !== 'spec') {
    throw new Error(`KIND must be story or spec; got ${JSON.stringify(kind)}`);
  }

  const read = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      process.stderr.write(`${path} could not be read\n`);
      return null;
    }
  };

  const base = read(basePath);
  const head = read(headPath);
  if (base === null || head === null) process.exit(1);

  const normalise = (text: string): string =>
    kind === 'story' ? storyBodyForHashing(text) : text;

  process.exit(normalise(base) === normalise(head) ? 0 : 1);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `compare-approved-text failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}
```

Both follow `verify-approval.ts`: `main` is private, usage errors throw and the entry guard turns them into exit 2, and the outcome is an explicit `process.exit`. Drive them from the tests the way `tests/unit/verify-approval.test.ts` does — a subprocess per case, asserting on the status and the streams. Do not export `main` to make the tests simpler; a CLI whose exit codes are its contract should be tested through them.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/stamp-story-status.test.ts tests/unit/compare-approved-text.test.ts`
Expected: PASS, fourteen cases.

- [ ] **Step 6: Commit**

```bash
git add lib/cli/stamp-story-status.ts lib/cli/compare-approved-text.ts tests/unit/stamp-story-status.test.ts tests/unit/compare-approved-text.test.ts
git commit -m "feat(approval): write the status line, and compare what the approval binds"
```

---

### Task 11: Wire the projection into the two transitions that exist (AC-15)

`phase-implement.yml` owns both: it starts the work, and at line 1045 it flips the issue to `state:pr-review` after opening the pull request. Nothing in this repo sets `state:done` — `phase-promote-to-prod.yml:118` reports promotion unimplemented and exits 1 — so the third stamp has nowhere to hang. Do not invent a transition for it.

The stamp is pushed to the **base branch**, not committed on the agent branch: the story's status is a fact about the repository rather than about one pull request, and a stamp on the branch would put the projection inside a diff a reviewer has to read.

**Files:**
- Modify: `.github/workflows/phase-implement.yml`
- Test: `tests/unit/workflows.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the `phase-implement.yml — story issues` describe block in `tests/unit/workflows.test.ts`:

```
1. the identity check runs compare-approved-text, not cmp, for the document path
2. it passes KIND=story when STORY_PATH is set and KIND=spec otherwise
3. the plan path is still compared with cmp  (unchanged for every spec consumer)
4. a step stamps InProgress, gated on story_path being non-empty
5. a step stamps Review after the state:pr-review label flip, gated the same way
6. both stamping steps are skipped when the run was overtaken
   (steps.slot.outputs.overtaken != 'true', like every other step in the file)
7. the push retries with git pull --rebase and warns rather than failing the run
   (the run's real work is done; a failed status push must not report the
   implementation as failed)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/workflows.test.ts -t "story issues"`
Expected: FAIL on all seven.

- [ ] **Step 3: Replace the identity check**

At `phase-implement.yml:522-529`, keep the loop for the plan and route the document through the new CLI:

```yaml
          if [ "${OVERRIDE:-}" != "true" ]; then
            # The document is compared by what its approval actually binds. For
            # a story that excludes the **Status:** line, which dev-agent
            # rewrites as the issue moves — a byte comparison would hard-fail
            # on precisely the difference the approval was built to ignore.
            # A spec stays byte-exact, which is what every consumer has today.
            if ! BASE_PATH="$BASE_ROOT/$DOC_PATH" HEAD_PATH="$DOC_PATH" \
                 KIND="$([ -n "${STORY_PATH:-}" ] && echo story || echo spec)" \
                 .dev-agent-engine/node_modules/.bin/tsx \
                 .dev-agent-engine/lib/cli/compare-approved-text.ts; then
              echo "::error::${DOC_PATH} differs between ${BASE} and the working branch. The approval covers the ${BASE} copy; the agent would read the other one. Push the approved text, or re-approve the current one." >&2
              exit 1
            fi
            for REL in ${PLAN_PATH:+"$PLAN_PATH"}; do
              if ! cmp -s "$BASE_ROOT/$REL" "$REL"; then
                echo "::error::${REL} differs between ${BASE} and the working branch. The approval covers the ${BASE} copy; the agent would read the other one. Push the approved text, or re-approve the current one." >&2
                exit 1
              fi
            done
          fi
```

- [ ] **Step 4: Add the two stamping steps**

Both are their own step, with this shape. Place the first immediately after the `Verify spec approval` step, and the second immediately after the `gh issue edit ... --add-label state:pr-review` at line 1045.

```yaml
      - name: Project the story status
        if: steps.slot.outputs.overtaken != 'true' && steps.issue.outputs.story_path != ''
        env:
          STORY_PATH: ${{ steps.issue.outputs.story_path }}
          STATUS: InProgress
          BASE: ${{ github.event.repository.default_branch }}
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          # Empty on trigger shapes that carry no repository payload. The
          # approval gate derives its own fallback and refuses without one;
          # here there is nothing to refuse, so warn and skip.
          if [ -z "${BASE:-}" ]; then
            echo "::warning::could not determine the default branch; ${STORY_PATH} was not stamped to ${STATUS}"
            exit 0
          fi
          # The story's status is a fact about the repository, not about this
          # pull request, so it is pushed to the base branch rather than
          # committed on the agent branch — where it would sit inside a diff a
          # reviewer has to read, and would be unreachable once the branch is
          # deleted.
          #
          # The hash deliberately excludes this line, so stamping it cannot
          # invalidate the approval the gate above just verified.
          STAMP_DIR=$(mktemp -d)
          git clone --depth 1 --branch "$BASE" "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$STAMP_DIR" >/dev/null 2>&1
          (
            cd "$STAMP_DIR"
            if ! STORY_PATH="$STORY_PATH" STATUS="$STATUS" \
                 "${GITHUB_WORKSPACE}/.dev-agent-engine/node_modules/.bin/tsx" \
                 "${GITHUB_WORKSPACE}/.dev-agent-engine/lib/cli/stamp-story-status.ts"; then
              echo "::warning::could not stamp ${STORY_PATH} to ${STATUS}; the status line and the issue now disagree"
              exit 0
            fi
            if git diff --quiet -- "$STORY_PATH"; then exit 0; fi
            git config user.name "dev-agent"
            git config user.email "dev-agent@users.noreply.github.com"
            git add "$STORY_PATH"
            git commit -q -m "docs(story): ${STORY_PATH} -> ${STATUS}"
            # Retried, because the base branch moves. Warned about rather than
            # fatal: the implementation succeeded, and failing the run here
            # would report work that was done as work that was not.
            for attempt in 1 2 3; do
              if git push -q origin "HEAD:${BASE}"; then exit 0; fi
              git pull --rebase -q origin "$BASE" || true
            done
            echo "::warning::could not push the status stamp for ${STORY_PATH} after 3 attempts; the status line and the issue now disagree"
          )
          rm -rf "$STAMP_DIR"
```

The second step is identical with `STATUS: Review` and the name "Project the story status (pull request open)".

Implementer notes:
- The base branch comes from `${{ github.event.repository.default_branch }}`, the same expression the approval gate's step reads at line 463. That gate derives its own fallback from `origin/HEAD` and refuses without one; these steps warn and skip instead, because there is no decision here to fail closed on. Do not add an output to the gate step to share its value — it is a gate, and widening it to publish state is how gates acquire second jobs.
- The clone is shallow and single-branch on purpose: the working tree is on the agent branch and must not be disturbed.
- Every failure path here warns and continues. A status line that did not get written is a cosmetic disagreement between two records; failing the run over it would throw away a completed implementation.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/workflows.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 6: Validate the YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/phase-implement.yml')); print('ok')"`
Expected: `ok`.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/phase-implement.yml tests/unit/workflows.test.ts
git commit -m "feat(implement): project the story status as the issue moves"
```

---

## Acceptance criteria covered

| AC | Where | Status |
|---|---|---|
| AC-12 | Tasks 5, 6, 7, 8, 9 | Full |
| AC-13 | Tasks 2, 3, 4 | Full |
| AC-14 | Task 1 | Delivered in slice 3's PR, not here |
| AC-15 | Tasks 10, 11 | `InProgress` and `Review` only — see below |

**AC-15 is knowingly partial.** The `Done` stamp is implemented in the CLI and covered by its tests, and is not wired, because nothing in this repository sets `state:done`. `phase-promote-to-prod.yml` reports promotion unimplemented and exits 1. Wiring it is one step in the promotion phase on the day that phase is built. Record this honestly wherever the criterion is ticked: a criterion marked met on a transition that cannot occur is the same failure this whole feature exists to remove.

AC-1 to AC-11 belong to slices 1 and 2 and are merged. AC-16 and AC-17 belong to slice 3.

## Notes for the executor

- **Do not touch `lib/story-approval.ts` or `lib/spec-approval.ts`, or their dashboard mirrors.** Nothing in this plan needs to. If a task seems to require it, the task is wrong — say so rather than editing and re-copying.
- **`unreadable` is a third state everywhere it appears.** Tasks 3, 4 and 6 each produce one, and the panel in Task 9 renders it apart from "not approved". Collapsing any of them into a boolean is the defect class this feature has spent four slices removing: a check that could not run reporting that the thing it checks is not there.
- **The spec path is a shipped surface.** Tasks 2, 7, 9 and 11 all touch code every consumer repo runs. Each has a named regression test; treat a failure there as a blocker rather than an assertion to update.
- The dashboard's story gate branch in `evaluateSpecApproval` does not wrap its two `fetchText` calls in a try/catch, unlike the spec branch, so a non-404 error throws out of the function rather than returning a refusal. Both new callers run it inside `wrapStep` within a try/catch, so it still fails closed — with a less specific message than the spec path gives. Leave it; it is a message-quality issue, not a correctness one, and changing it belongs with a test of its own.
- Task 8's test harness should match whatever the existing `actions` tests use. Read one before writing, and do not introduce a second mocking style.
