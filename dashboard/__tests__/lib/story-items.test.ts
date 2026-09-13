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

  it('filters an approval artifact out of the story list', () => {
    // Defence in depth: the lister already splits stories from approvals, but
    // a caller passing the raw tree (both mixed into `stories`) must not get a
    // startable item for an approval artifact.
    const items = toStoryItems([`${EPIC8}/8.1-gate.md`, `${EPIC8}/8.1-gate.approval.json`]);
    expect(items).toHaveLength(1);
    expect(items[0].storyPath).toBe(`${EPIC8}/8.1-gate.md`);
  });
});
