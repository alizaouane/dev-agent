import 'server-only';

import type { Proposal } from './scout';

/**
 * In-memory TTL cache for the /next PM recommendation. Keyed by
 * `${username}::${proposalIdsHash}` so visits with the same proposal
 * queue dedupe, while a queue change naturally invalidates.
 *
 * Lives in its own module rather than in app/next/page.tsx so the
 * regenerate-recommendation server action can evict entries without
 * a circular import.
 */

type CacheEntry = { recommendation: string; expires: number };

const RECOMMENDATION_CACHE = new Map<string, CacheEntry>();
const RECOMMENDATION_TTL_MS = 30 * 60 * 1000;

/**
 * Build the cache key. Proposal ids are sorted so the same set in any
 * order produces the same key — scout sources run in parallel and
 * their merged order is non-deterministic.
 */
export function recommendationCacheKey(username: string, proposals: Proposal[]): string {
  const ids = [...proposals.map((p) => p.id)].sort().join('|');
  return `${username}::${ids}`;
}

/** Look up a cached recommendation; returns null if missing or expired. */
export function getCachedRecommendation(
  key: string,
  now: number = Date.now(),
): string | null {
  const entry = RECOMMENDATION_CACHE.get(key);
  if (!entry) return null;
  if (entry.expires <= now) {
    RECOMMENDATION_CACHE.delete(key);
    return null;
  }
  return entry.recommendation;
}

/** Store a recommendation with a fresh TTL. */
export function setCachedRecommendation(
  key: string,
  recommendation: string,
  now: number = Date.now(),
): void {
  RECOMMENDATION_CACHE.set(key, {
    recommendation,
    expires: now + RECOMMENDATION_TTL_MS,
  });
}

/**
 * Evict every cached entry for a user — used by the "Regenerate" button
 * when the user wants a fresh recommendation regardless of queue state.
 *
 * Iterates the map: cheap for our cardinality (one user × maybe a few
 * proposal-set hashes from the last 30 min). If the cache ever grows
 * to thousands of users we'll need an index, but the in-memory shape
 * already pre-supposes single-user-ish deployment.
 */
export function evictRecommendationsForUser(username: string): number {
  const prefix = `${username}::`;
  let removed = 0;
  for (const key of RECOMMENDATION_CACHE.keys()) {
    if (key.startsWith(prefix)) {
      RECOMMENDATION_CACHE.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** Test-only — production resets are via cold start. */
export function __resetNextCacheForTests(): void {
  RECOMMENDATION_CACHE.clear();
}
