import { describe, it, expect, beforeEach } from 'vitest';

import {
  parseCategorizationResponse,
  categorizationCacheKey,
  getCachedCategorization,
  setCachedCategorization,
  __resetCategorizationCacheForTests,
  PROPOSAL_CATEGORIES,
  type ProposalCategory,
} from '@/lib/categorize-proposals';
import type { Proposal } from '@/lib/scout';

function makeProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'unfinished_plan:q/r:plan#L1',
    source: 'unfinished_plan',
    group: 'carry_over',
    repo: 'q/r',
    title: 'Sample',
    description: '...',
    url: 'https://github.com/q/r',
    ...over,
  };
}

describe('parseCategorizationResponse', () => {
  const proposals = [
    makeProposal({ id: 'a' }),
    makeProposal({ id: 'b' }),
    makeProposal({ id: 'c' }),
  ];

  it('parses fenced JSON output into a Map', () => {
    const text = '```json\n{"categories":[{"id":"a","category":"cleanup"},{"id":"b","category":"implementation"},{"id":"c","category":"tech_debt"}]}\n```';
    const out = parseCategorizationResponse(text, proposals);
    expect(out).not.toBeNull();
    expect(out?.get('a')).toBe('cleanup');
    expect(out?.get('b')).toBe('implementation');
    expect(out?.get('c')).toBe('tech_debt');
  });

  it('parses bare JSON (no fences)', () => {
    const text = '{"categories":[{"id":"a","category":"cleanup"},{"id":"b","category":"investigation"},{"id":"c","category":"tech_debt"}]}';
    const out = parseCategorizationResponse(text, proposals);
    expect(out?.size).toBe(3);
  });

  it('returns null when output is malformed JSON', () => {
    expect(parseCategorizationResponse('not json', proposals)).toBeNull();
  });

  it('returns null when "categories" is missing', () => {
    expect(parseCategorizationResponse('{"foo": []}', proposals)).toBeNull();
  });

  it('returns null when not every proposal id is covered (partial result is worse than none)', () => {
    const text = '{"categories":[{"id":"a","category":"cleanup"},{"id":"b","category":"implementation"}]}';
    expect(parseCategorizationResponse(text, proposals)).toBeNull();
  });

  it('rejects entries with unknown categories', () => {
    const text = '{"categories":[{"id":"a","category":"cleanup"},{"id":"b","category":"BOGUS"},{"id":"c","category":"tech_debt"}]}';
    // b's category is invalid → only 2 entries valid → mismatch with 3 proposals → null
    expect(parseCategorizationResponse(text, proposals)).toBeNull();
  });

  it('rejects entries with unknown ids (LLM hallucinated an id)', () => {
    const text = '{"categories":[{"id":"a","category":"cleanup"},{"id":"made-up","category":"implementation"},{"id":"c","category":"tech_debt"}]}';
    expect(parseCategorizationResponse(text, proposals)).toBeNull();
  });

  it('accepts every documented category value', () => {
    const proposalsByCategory = PROPOSAL_CATEGORIES.map((c, i) =>
      makeProposal({ id: `p${i}` }),
    );
    const text = `{"categories":${JSON.stringify(
      PROPOSAL_CATEGORIES.map((category, i) => ({ id: `p${i}`, category })),
    )}}`;
    const out = parseCategorizationResponse(text, proposalsByCategory);
    expect(out).not.toBeNull();
    expect(Array.from(out?.values() ?? []).sort()).toEqual([...PROPOSAL_CATEGORIES].sort());
  });
});

describe('categorizationCacheKey', () => {
  it('is order-invariant on the proposal-id set', () => {
    const a = [makeProposal({ id: '1' }), makeProposal({ id: '2' }), makeProposal({ id: '3' })];
    const b = [makeProposal({ id: '3' }), makeProposal({ id: '1' }), makeProposal({ id: '2' })];
    expect(categorizationCacheKey(a)).toBe(categorizationCacheKey(b));
  });

  it('changes when the proposal set changes', () => {
    const a = [makeProposal({ id: '1' }), makeProposal({ id: '2' })];
    const b = [makeProposal({ id: '1' }), makeProposal({ id: '99' })];
    expect(categorizationCacheKey(a)).not.toBe(categorizationCacheKey(b));
  });
});

describe('cache get/set/expiry', () => {
  beforeEach(() => __resetCategorizationCacheForTests());

  it('round-trips a stored map', () => {
    const map = new Map<string, ProposalCategory>([
      ['a', 'cleanup'],
      ['b', 'implementation'],
    ]);
    setCachedCategorization('k', map);
    const out = getCachedCategorization('k');
    expect(out?.get('a')).toBe('cleanup');
    expect(out?.get('b')).toBe('implementation');
  });

  it('returns a fresh Map (mutating the caller-side copy doesn\'t corrupt the cache)', () => {
    const map = new Map<string, ProposalCategory>([['a', 'cleanup']]);
    setCachedCategorization('k', map);
    const first = getCachedCategorization('k');
    first?.set('a', 'tech_debt');
    const second = getCachedCategorization('k');
    expect(second?.get('a')).toBe('cleanup');
  });

  it('returns null after TTL expires', () => {
    const now = 1_000_000;
    setCachedCategorization('k', new Map([['a', 'cleanup']]), now);
    // Just before expiry → present
    expect(getCachedCategorization('k', now + 29 * 60 * 1000)).not.toBeNull();
    // After 30-min TTL → gone
    expect(getCachedCategorization('k', now + 31 * 60 * 1000)).toBeNull();
  });

  it('returns null for unknown keys', () => {
    expect(getCachedCategorization('never-set')).toBeNull();
  });
});
