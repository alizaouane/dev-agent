import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetNextCacheForTests,
  evictRecommendationsForUser,
  getCachedRecommendation,
  recommendationCacheKey,
  setCachedRecommendation,
} from '@/lib/next-cache';
import type { Proposal } from '@/lib/scout';

const fakeProposal = (id: string): Proposal => ({
  id,
  source: 'unfinished_plan',
  group: 'carry_over',
  repo: 'q/r',
  title: 't',
  description: 'd',
  url: 'https://example.com',
});

describe('next-cache', () => {
  beforeEach(() => {
    __resetNextCacheForTests();
  });

  it('cache key is invariant under proposal-list order', () => {
    const k1 = recommendationCacheKey('alice', [fakeProposal('a'), fakeProposal('b')]);
    const k2 = recommendationCacheKey('alice', [fakeProposal('b'), fakeProposal('a')]);
    expect(k1).toBe(k2);
  });

  it('cache key differs across users for the same proposals', () => {
    const k1 = recommendationCacheKey('alice', [fakeProposal('a')]);
    const k2 = recommendationCacheKey('bob', [fakeProposal('a')]);
    expect(k1).not.toBe(k2);
  });

  it('roundtrips a recommendation', () => {
    const k = recommendationCacheKey('alice', [fakeProposal('a')]);
    setCachedRecommendation(k, 'do the thing');
    expect(getCachedRecommendation(k)).toBe('do the thing');
  });

  it('returns null for missing keys', () => {
    expect(getCachedRecommendation('never-set')).toBeNull();
  });

  it('expires entries past the TTL and self-cleans', () => {
    const k = recommendationCacheKey('alice', [fakeProposal('a')]);
    setCachedRecommendation(k, 'old');
    // 31 minutes from now is past the 30-min TTL.
    const future = Date.now() + 31 * 60 * 1000;
    expect(getCachedRecommendation(k, future)).toBeNull();
    // Self-cleanup means the entry is gone for subsequent untimed lookups too.
    expect(getCachedRecommendation(k)).toBeNull();
  });

  it('evictRecommendationsForUser drops only that users entries', () => {
    const aliceK1 = recommendationCacheKey('alice', [fakeProposal('a')]);
    const aliceK2 = recommendationCacheKey('alice', [fakeProposal('b')]);
    const bobK = recommendationCacheKey('bob', [fakeProposal('a')]);
    setCachedRecommendation(aliceK1, 'a1');
    setCachedRecommendation(aliceK2, 'a2');
    setCachedRecommendation(bobK, 'b');

    const removed = evictRecommendationsForUser('alice');
    expect(removed).toBe(2);
    expect(getCachedRecommendation(aliceK1)).toBeNull();
    expect(getCachedRecommendation(aliceK2)).toBeNull();
    expect(getCachedRecommendation(bobK)).toBe('b');
  });

  it('evictRecommendationsForUser is idempotent on absent users', () => {
    expect(evictRecommendationsForUser('nobody')).toBe(0);
  });
});
