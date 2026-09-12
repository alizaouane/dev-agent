import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  storyBodyForHashing,
  hashStory,
  parseStoryApproval,
  approvalPathForStory,
  storyDispatchGateDecision,
  STORY_STATUS_VALUES,
  STATUS_LINE_RE as RE,
} from '../../lib/story-approval';
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

  it('strips a CRLF status line (.standard/check.sh:91 treats \\r as trailing [[:space:]])', () => {
    const doc = '# S\r\n\r\n**Status:** Approved\r\n\r\nbody\r\n';
    expect(storyBodyForHashing(doc)).not.toMatch(/Status/);
  });

  it('strips a status line with more than two asterisks (.standard/check.sh:91 allows \\** — any count)', () => {
    const doc = '# S\n\n***Status:*** Approved\n\nbody\n';
    expect(storyBodyForHashing(doc)).not.toMatch(/Status/);
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

  it('is unchanged by a status transition on a CRLF story', () => {
    const crlfStory = STORY.replace(/\n/g, '\r\n');
    const draft = crlfStory;
    const done = crlfStory.replace('**Status:** Draft', '**Status:** Done');
    expect(hashStory(done)).toBe(hashStory(draft));
  });

  it('is unchanged by a status transition on a story using more than two asterisks', () => {
    const draft = STORY.replace('**Status:** Draft', '***Status:*** Draft');
    const done = draft.replace('***Status:*** Draft', '***Status:*** Done');
    expect(hashStory(done)).toBe(hashStory(draft));
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
    ['approved_at', { approved_at: 'not-a-date' }],
    // A valid Date input that does not round-trip to itself is not the
    // ISO-8601 format the record documents (no time component, no
    // milliseconds, no explicit UTC offset) — accepting it would let
    // approved_at drift from the one canonical rendering the field claims.
    ['approved_at', { approved_at: '2026-09-12' }],
  ])('rejects a bad %s', (field, over) => {
    const parsed = parseStoryApproval(record(over));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(field);
  });

  it('accepts a well-formed ISO-8601 approved_at with milliseconds and Z', () => {
    const parsed = parseStoryApproval(record({ approved_at: '2026-09-12T10:00:00.000Z' }));
    expect(parsed.ok).toBe(true);
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

const OK_HASH = hashStory(STORY);

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
      currentStoryHash: hashStory(STORY.replace('truthful', 'different')),
      storyPath: STORY_PATH,
    });
    expect(d.reason).toBe('spec-changed');
  });

  it('allows a story whose status line moved on', () => {
    // The projection must not invalidate the approval it was projected from.
    const d = storyDispatchGateDecision({
      approvalRaw: approved(),
      currentStoryHash: hashStory(STORY.replace('**Status:** Draft', '**Status:** Review')),
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

  it('treats regex metacharacters in values as literals, not patterns', () => {
    // A future value containing . ? or other metacharacters must match exactly,
    // not change the grammar. E.g., In.Progress should not also accept InXProgress.
    RE.lastIndex = 0;
    // '.' is a regex metacharacter — it matches any character. If unescaped,
    // In.Review would also match InXReview, InAReview, etc.
    // Since we escape it, the dot must be literal in the input.
    expect(RE.test('**Status:** In.Review')).toBe(false);
    expect(RE.test('**Status:** InXReview')).toBe(false);
  });

  it('derives its alternation from STORY_STATUS_VALUES, not a hardcoded list', () => {
    // Every other test here passes just as well against a hardcoded
    // alternation — it only diverges the day someone adds a status to
    // STORY_STATUS_VALUES and the regex stops recognising it, at which point
    // hashing stops stripping the line and breaks the approval on a story
    // nobody edited. So pin the derivation itself, in both directions.
    for (const value of STORY_STATUS_VALUES) {
      const alternative = value === 'InProgress' ? 'In ?Progress' : value;
      expect(RE.source, value).toContain(alternative);
    }
    const alternation = RE.source.match(/\(\?:(.+?)\)/);
    expect(alternation, 'the status alternation group moved — update this test').not.toBeNull();
    expect(alternation![1].split('|')).toHaveLength(STORY_STATUS_VALUES.length);
  });
});

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
