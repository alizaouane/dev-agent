import 'server-only';

import type { Octokit } from '@octokit/rest';

import { dispatchGateDecision, hashSpecAndPlan } from './spec-approval';
import type { SpecPair } from './spec-pairs';

/**
 * Decide which spec pairs the dispatch path would actually accept.
 *
 * The picker previously treated the presence of an approval file as approval.
 * The gate does not: it checks the recorded verdict is clean, that the paths
 * match, that the schema is one it understands, and that a hash over the spec
 * and plan still matches what was approved. A stale approval — one whose spec
 * was edited afterwards — passes a filename check and fails the gate, which
 * puts back exactly the round-trip failure the picker exists to remove.
 *
 * Only pairs that already carry an approval artifact are verified, so the cost
 * is bounded by how many specs have been approved rather than by how many
 * exist. On a repo with 259 specs and none approved this makes no calls at all.
 */

/**
 * How many pairs to verify at once.
 *
 * A concurrency limit, not a cap on how many get verified. Truncating the
 * candidate list instead would mark everything past the limit unapproved, so a
 * repo with more approvals than the limit could not start its older ones —
 * truncation reading as absence, one more time.
 */
const BATCH = 25;

/**
 * Most cached verdicts to keep, across every repo in the process.
 *
 * A verdict is a function of three blob SHAs, so it never goes stale: editing
 * any of the three files changes its SHA and misses the cache. The bound is
 * only there to stop a long-lived server accumulating entries for content
 * nobody looks at any more.
 */
const CACHE_LIMIT = 2000;

/**
 * Verdicts keyed by the content that produced them.
 *
 * Insertion-ordered, so evicting the oldest key is the whole eviction policy.
 */
const verdictCache = new Map<string, boolean>();

/**
 * Record a verdict against the content it was derived from.
 *
 * @param key - Content-addressed cache key.
 * @param verdict - What the gate decided.
 */
function cacheVerdict(key: string, verdict: boolean): void {
  verdictCache.delete(key);
  verdictCache.set(key, verdict);
  while (verdictCache.size > CACHE_LIMIT) {
    const oldest = verdictCache.keys().next();
    if (oldest.done) break;
    verdictCache.delete(oldest.value);
  }
}

/**
 * Build the content-addressed key for a pair, when every blob SHA is known.
 *
 * The paths are part of the key, not just the bytes: the gate compares the
 * approval's recorded spec and plan paths against the ones being dispatched,
 * so the same three blobs copied into the other tree are a different decision.
 * Keying on content alone would let the original path's `true` be reused for
 * the copy, and the picker would offer a pair the server gate then refuses.
 *
 * Missing any of the three SHAs means the key would not describe the content,
 * so there is no key and the pair is read rather than served from cache.
 *
 * @param blobShas - Path-to-blob-SHA map from the directory listing.
 * @param specPath - The spec.
 * @param planPath - Its plan, or null.
 * @param approvalPath - The approval artifact beside the spec.
 * @returns The key, or null when a SHA is unknown.
 */
function cacheKey(
  blobShas: Record<string, string> | undefined,
  specPath: string,
  planPath: string | null,
  approvalPath: string,
): string | null {
  if (!blobShas) return null;
  const spec = blobShas[specPath];
  const approval = blobShas[approvalPath];
  const plan = planPath === null ? '-' : blobShas[planPath];
  if (spec === undefined || approval === undefined || plan === undefined) return null;
  return `${specPath}|${planPath ?? '-'}|${spec}:${plan}:${approval}`;
}

/**
 * Read a repo file, or null when it is not there.
 *
 * @returns The decoded text, or null on 404.
 * @throws On any non-404 error, so an unreadable repo is not mistaken for an
 *   unapproved one.
 */
async function readText(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/** What verifying one pair concluded. */
interface Verdict {
  /** True only when the gate would let dispatch proceed. */
  approved: boolean;
  /** True when a read failed for a reason other than the file being absent. */
  unverified: boolean;
}

/**
 * Re-derive `approved` on each pair by running the real gate decision.
 *
 * A pair whose reads fail — rate limiting, a revoked token, a network fault —
 * comes back `approved: false, unverified: true`. Those are different facts:
 * one says the gate refused, the other says the gate never ran, and rendering
 * the second as the first hides an approved spec behind an outage.
 *
 * @param octokit - Authenticated client.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param ref - Branch the files live on.
 * @param pairs - Output of `pairSpecsAndPlans`.
 * @param blobShas - Optional path-to-blob-SHA map from the directory listing,
 *   used to serve unchanged pairs from cache instead of re-reading them.
 * @returns The same pairs, with `approved` reflecting what dispatch would do.
 */
export async function verifySpecPairs(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  pairs: SpecPair[],
  blobShas?: Record<string, string>,
): Promise<SpecPair[]> {
  const candidates = pairs.filter((p) => p.approved);
  if (candidates.length === 0) {
    return pairs.map((p) => ({ ...p, approved: false, unverified: false }));
  }

  const verdicts = new Map<string, Verdict>();

  const verifyOne = async (pair: SpecPair): Promise<void> => {
    const approvalPath = `${pair.specPath.replace(/\.md$/, '')}.approval.json`;
    const key = cacheKey(blobShas, pair.specPath, pair.planPath, approvalPath);
    if (key !== null) {
      const hit = verdictCache.get(key);
      if (hit !== undefined) {
        verdicts.set(pair.key, { approved: hit, unverified: false });
        return;
      }
    }

    try {
      const [specText, planText, approvalRaw] = await Promise.all([
        readText(octokit, owner, repo, pair.specPath, ref),
        pair.planPath ? readText(octokit, owner, repo, pair.planPath, ref) : Promise.resolve(null),
        readText(octokit, owner, repo, approvalPath, ref),
      ]);

      // A named plan that is not there is not an empty plan. Hashing null like
      // an empty file would let an approved zero-byte plan keep matching after
      // deletion, and dispatch would refuse it afterwards.
      if (specText === null || (pair.planPath !== null && planText === null)) {
        verdicts.set(pair.key, { approved: false, unverified: false });
        if (key !== null) cacheVerdict(key, false);
        return;
      }

      const decision = dispatchGateDecision({
        approvalRaw,
        currentSpecHash: hashSpecAndPlan(specText, planText),
        specPath: pair.specPath,
        planPath: pair.planPath,
      });
      verdicts.set(pair.key, { approved: decision.allow, unverified: false });
      if (key !== null) cacheVerdict(key, decision.allow);
    } catch {
      // A read we could not complete is not an approval, and it is not a
      // refusal either. Caching it would make one rate-limited render stick.
      verdicts.set(pair.key, { approved: false, unverified: true });
    }
  };

  // eslint-disable-next-line no-restricted-syntax -- batches run in sequence so
  // a repo with many approvals does not open every read at once.
  for (let i = 0; i < candidates.length; i += BATCH) {
    await Promise.all(candidates.slice(i, i + BATCH).map(verifyOne));
  }

  return pairs.map((p) => {
    const verdict = verdicts.get(p.key);
    return { ...p, approved: verdict?.approved === true, unverified: verdict?.unverified === true };
  });
}
