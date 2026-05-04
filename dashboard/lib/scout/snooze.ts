import 'server-only';

import type { Proposal } from './types';

/**
 * In-memory snooze store for /proposals.
 *
 * The dashboard surfaces a finding the moment scout returns it, on every
 * page load. Without a "not now" affordance, the same untriaged issue or
 * unfinished plan box keeps reappearing forever — friction that the user
 * has to swat away on every visit.
 *
 * Storage: a module-scope Map keyed by `${username}::${proposalId}` →
 * unix-ms expiry. Why not GitHub-backed:
 *   - Most proposal sources don't have a backing artifact we can label
 *     (an unchecked plan box isn't an issue).
 *   - Snooze is a UX preference, not an artifact change. Cold-start
 *     eviction is acceptable: the user can snooze again if it matters.
 * If the user starts asking for "permanent dismiss," that becomes a
 * label on the underlying issue (untriaged_issue) or a `pm.md`
 * frontmatter entry (everything else) — Phase 3.6.
 */

const SNOOZE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SnoozeKey = string;
const SNOOZE_STORE = new Map<SnoozeKey, number>();

function key(username: string, proposalId: string): SnoozeKey {
  return `${username}::${proposalId}`;
}

/**
 * Add a snooze entry for `proposalId` valid for `SNOOZE_TTL_MS`. Idempotent
 * — re-snoozing the same id resets the clock.
 */
export function snoozeProposalId(username: string, proposalId: string): void {
  SNOOZE_STORE.set(key(username, proposalId), Date.now() + SNOOZE_TTL_MS);
}

/**
 * Remove a snooze entry, e.g. when the user explicitly un-snoozes from the
 * "Show snoozed" view. No-op if the entry isn't present.
 */
export function unsnoozeProposalId(username: string, proposalId: string): void {
  SNOOZE_STORE.delete(key(username, proposalId));
}

/** True if the user currently has an active snooze for this proposal. */
export function isSnoozed(username: string, proposalId: string, now: number = Date.now()): boolean {
  const expiry = SNOOZE_STORE.get(key(username, proposalId));
  if (expiry === undefined) return false;
  if (expiry <= now) {
    // Expired — clean up so the store doesn't grow unbounded.
    SNOOZE_STORE.delete(key(username, proposalId));
    return false;
  }
  return true;
}

/** Partition proposals into (active, snoozed) for the page renderer. */
export function partitionBySnooze(
  username: string,
  proposals: Proposal[],
  now: number = Date.now(),
): { active: Proposal[]; snoozed: Proposal[] } {
  const active: Proposal[] = [];
  const snoozed: Proposal[] = [];
  for (const p of proposals) {
    if (isSnoozed(username, p.id, now)) snoozed.push(p);
    else active.push(p);
  }
  return { active, snoozed };
}

/**
 * Test-only helper: clear the entire store. Production code never needs
 * this — production resets happen via cold start.
 */
export function __resetSnoozeStoreForTests(): void {
  SNOOZE_STORE.clear();
}
