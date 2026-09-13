import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseLabels, verifyApproval, verifyStoryApproval } from '../../lib/cli/verify-approval';
import { buildApproval } from '../../lib/cli/approve-spec';
import { OVERRIDE_LABEL } from '../../lib/spec-approval';
import { approvalPathForStory, hashStory, type StoryApproval } from '../../lib/story-approval';

const SPEC = 'docs/superpowers/specs/thing-design.md';
const PLAN = 'docs/superpowers/plans/thing.md';
const APPROVAL = 'docs/superpowers/specs/thing-design.approval.json';
const SPEC_TEXT = '# Thing\n\nAC-1: it works.\n';
const PLAN_TEXT = '# Plan\n\nTask 1 (AC: 1)\n';

const STORY = 'docs/stories/epic-9/9.1-thing.md';
const STORY_TEXT =
  '# Story 9.1\n\n**Status:** Draft\n**Source spec:** `docs/superpowers/specs/thing-design.md`\n\n' +
  '## Story\n\nBody text.\n';
/**
 * A syntactically valid but otherwise meaningless digest, used for
 * `source_spec_sha256` — a field `storyDispatchGateDecision` never inspects,
 * so nothing in these tests depends on it matching a real spec hash.
 */
const DUMMY_DIGEST = 'a'.repeat(64);

let repo: string;

/** Write a repo-relative file, creating parent directories as needed. */
function put(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** Record a real approval for the spec and plan currently on the checkout. */
function approve(planPath: string | null = PLAN): void {
  const { approval, outPath } = buildApproval({
    specPath: SPEC,
    planPath,
    reviewVerdict: 'ok',
    reviewRounds: 1,
    approvedBy: 'ali@example.com',
    repoRoot: repo,
    now: () => new Date('2026-09-09T10:00:00.000Z'),
  });
  put(outPath, JSON.stringify(approval, null, 2));
}

/** Verify with the canonical paths, overridable per test. */
function verify(over: Partial<Parameters<typeof verifyApproval>[0]> = {}) {
  return verifyApproval({
    specPath: SPEC,
    planPath: PLAN,
    labels: [],
    repoRoot: repo,
    ...over,
  });
}

/** Record a story approval on disk for the given story text. */
function approveStory(storyText: string = STORY_TEXT): void {
  const approval: StoryApproval = {
    schema_version: 1,
    kind: 'story',
    story_path: STORY,
    story_sha256: hashStory(storyText),
    source_spec_path: SPEC,
    source_spec_sha256: DUMMY_DIGEST,
    review_verdict: 'ok',
    review_rounds: 1,
    approved_by: 'ali@example.com',
    approved_at: '2026-09-09T10:00:00.000Z',
  };
  put(approvalPathForStory(STORY), JSON.stringify(approval, null, 2));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'verify-approval-test-'));
  put(SPEC, SPEC_TEXT);
  put(PLAN, PLAN_TEXT);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('parseLabels', () => {
  it('splits on commas and newlines and drops blanks', () => {
    expect(parseLabels('a, b\nc,,\n')).toEqual(['a', 'b', 'c']);
  });

  it('treats an unset value as no labels', () => {
    expect(parseLabels(undefined)).toEqual([]);
    expect(parseLabels('')).toEqual([]);
  });
});

describe('verifyApproval', () => {
  it('allows a checkout whose approval matches the committed text', () => {
    approve();
    const d = verify();
    expect(d.allow).toBe(true);
    expect(d.message).toContain('ali@example.com');
  });

  it('refuses when no approval was ever committed', () => {
    const d = verify();
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('missing');
  });

  it('refuses when the spec was edited after approval', () => {
    approve();
    put(SPEC, SPEC_TEXT + 'AC-2: sneaked in after approval.\n');
    const d = verify();
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('spec-changed');
  });

  it('refuses when the plan was edited after approval', () => {
    approve();
    put(PLAN, PLAN_TEXT + 'Task 9: rewrite everything.\n');
    const d = verify();
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('spec-changed');
  });

  it('refuses the workflow placeholder spec rather than treating it as unchecked', () => {
    // phase-implement writes `<specs_dir>/placeholder-no-spec.md` when it
    // cannot find a spec link. That file has no approval beside it, so it
    // must refuse — a spec nobody wrote is not a spec anybody approved.
    const d = verify({ specPath: 'docs/specs/placeholder-no-spec.md', planPath: null });
    expect(d.allow).toBe(false);
  });

  it('refuses when the resolved spec is not on the checkout at all', () => {
    const d = verify({ specPath: 'docs/superpowers/specs/absent.md', planPath: null });
    expect(d.allow).toBe(false);
    expect(d.message).toContain('not on this checkout');
  });

  it('refuses when the workflow resolved a different spec than the one approved', () => {
    // The failure this step exists for: the dashboard and the workflow derive
    // the spec path with different code. If the workflow lands on another
    // file, that file's own approval is what gets checked — and it has none.
    approve();
    put('docs/superpowers/specs/legacy-design.md', '# Legacy\n');
    const d = verify({ specPath: 'docs/superpowers/specs/legacy-design.md', planPath: null });
    expect(d.allow).toBe(false);
  });

  it('allows a plan-less quick-dev spec approved without a plan', () => {
    approve(null);
    const d = verify({ planPath: null });
    expect(d.allow).toBe(true);
  });

  it('refuses when the workflow found a plan the approval does not cover', () => {
    approve(null);
    const d = verify();
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('path-mismatch');
  });

  it('lets the override label through on any refusal, and says so', () => {
    const d = verify({ labels: [OVERRIDE_LABEL] });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('override');
  });

  it('lets the override label through even when the spec is absent', () => {
    const d = verify({ specPath: 'docs/absent.md', planPath: null, labels: [OVERRIDE_LABEL] });
    expect(d.allow).toBe(true);
  });

  it('ignores unrelated labels', () => {
    approve();
    put(SPEC, SPEC_TEXT + 'edited\n');
    const d = verify({ labels: ['state:spec-ready', 'kind:feature'] });
    expect(d.allow).toBe(false);
  });

  it('rejects a corrupt approval file rather than reading past it', () => {
    put(APPROVAL, '{ truncated');
    const d = verify();
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('malformed');
  });
});

describe('verify-approval — story issues', () => {
  it('passes a story whose approval still matches', () => {
    put(STORY, STORY_TEXT);
    approveStory(STORY_TEXT);

    const d = verifyStoryApproval({ storyPath: STORY, labels: [], repoRoot: repo });

    expect(d.allow).toBe(true);
    expect(d.message).toContain('ali@example.com');
  });

  it('refuses a story edited after approval', () => {
    put(STORY, STORY_TEXT);
    approveStory(STORY_TEXT);
    // Edit the story on disk after the approval was recorded against the
    // original text — the hash in the approval no longer matches.
    put(STORY, STORY_TEXT + '\nOne more paragraph, added after approval.\n');

    const d = verifyStoryApproval({ storyPath: STORY, labels: [], repoRoot: repo });

    expect(d.allow).toBe(false);
    expect(d.reason).toBe('spec-changed');
  });

  it('allows a story whose status line alone moved on', () => {
    put(STORY, STORY_TEXT);
    approveStory(STORY_TEXT);
    // The dashboard (or the engine) advances the story's own status header as
    // the issue moves through the pipeline. `hashStory` excludes that line
    // precisely so this projection cannot invalidate the approval it came
    // from.
    const projected = STORY_TEXT.replace('**Status:** Draft', '**Status:** InProgress');
    expect(projected).not.toBe(STORY_TEXT);
    put(STORY, projected);

    const d = verifyStoryApproval({ storyPath: STORY, labels: [], repoRoot: repo });

    expect(d.allow).toBe(true);
  });

  describe('main() — SPEC_PATH / STORY_PATH are mutually exclusive', () => {
    const scriptPath = resolve(process.cwd(), 'lib/cli/verify-approval.ts');
    const tsxBinPath = resolve(process.cwd(), 'node_modules/.bin/tsx');

    /** Run the real CLI as a subprocess; never throws — callers inspect status/stdio. */
    function run(env: NodeJS.ProcessEnv) {
      return spawnSync(tsxBinPath, [scriptPath], {
        cwd: repo,
        env,
        encoding: 'utf8',
      });
    }

    it('refuses when both SPEC_PATH and STORY_PATH are set', () => {
      approve();
      put(STORY, STORY_TEXT);
      approveStory(STORY_TEXT);

      const result = run({
        ...process.env,
        SPEC_PATH: SPEC,
        STORY_PATH: STORY,
        PLAN_PATH: PLAN,
        REPO_ROOT: repo,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/SPEC_PATH/);
      expect(result.stderr).toMatch(/STORY_PATH/);
    });

    it('refuses when neither SPEC_PATH nor STORY_PATH is set', () => {
      const env: NodeJS.ProcessEnv = { ...process.env, REPO_ROOT: repo };
      delete env.SPEC_PATH;
      delete env.STORY_PATH;

      const result = run(env);

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/SPEC_PATH.*STORY_PATH|STORY_PATH.*SPEC_PATH/s);
    });
  });
});

describe('verifyStoryApproval — path canonicalisation', () => {
  it('accepts a ./-prefixed story path against a record written without one', () => {
    // Codex, PR #164. The workflow resolver, the dashboard parser and this
    // function must all hand the gate the spelling `approve-story` recorded.
    const repoRoot = mkdtempSync(join(tmpdir(), 'story-dot-slash-'));
    mkdirSync(dirname(join(repoRoot, STORY)), { recursive: true });
    writeFileSync(join(repoRoot, STORY), STORY_TEXT);
    const approval: StoryApproval = {
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
    };
    writeFileSync(join(repoRoot, approvalPathForStory(STORY)), JSON.stringify(approval));

    const d = verifyStoryApproval({ storyPath: `./${STORY}`, labels: [], repoRoot });
    expect(d.allow).toBe(true);
  });
});

describe('verifyStoryApproval — a missing story is not overridable', () => {
  it('refuses a story absent from the checkout even with the override label', () => {
    // Agrees with the dashboard gate, which must refuse the same case. The
    // override authorises dispatch despite a problem with the RECORD; a story
    // that is not on the checkout gives the agent nothing to implement, and
    // the workflow's own resolution step exits before this check is reached.
    const repoRoot = mkdtempSync(join(tmpdir(), 'story-missing-'));
    const d = verifyStoryApproval({
      storyPath: 'docs/stories/epic-8/8.1-gone.md',
      labels: [OVERRIDE_LABEL],
      repoRoot,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('missing');
    expect(d.message).toContain('override');
  });
});
