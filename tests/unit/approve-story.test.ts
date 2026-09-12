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
