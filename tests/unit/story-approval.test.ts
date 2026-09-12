import { describe, it, expect } from 'vitest';
import { storyBodyForHashing, hashStory, parseStoryApproval, approvalPathForStory } from '../../lib/story-approval';
import { hashSpecAndPlan, parseSpecApproval } from '../../lib/spec-approval';

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
    for (const line of ['**Status:** Approved', '**Status**: Approved', 'Status: Approved', '**Status:** Review — code merged']) {
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

  it('throws when the story path does not end in .md', () => {
    expect(() => approvalPathForStory('docs/stories/8.1-gate-hardening.txt')).toThrow(
      /story path must end in \.md/,
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
