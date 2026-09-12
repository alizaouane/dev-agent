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
