import 'server-only';

import type { Octokit } from '@octokit/rest';

import { dispatchGateDecision, hashSpecAndPlan, parseSpecApproval } from './spec-approval';
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

/** A cached decision, and the plan it was taken over. */
interface CachedVerdict {
  /** What the gate decided. */
  approved: boolean;
  /**
   * The plan the approval named. Cached with the verdict because the panel
   * dispatches this path, and re-deriving it from the filename convention on
   * a cache hit would submit a different plan from the one that was verified.
   */
  planPath: string | null;
}

/**
 * Verdicts keyed by the content that produced them.
 *
 * Insertion-ordered, so evicting the oldest key is the whole eviction policy.
 */
const verdictCache = new Map<string, CachedVerdict>();

/**
 * Record a verdict against the content it was derived from.
 *
 * @param key - Content-addressed cache key.
 * @param verdict - What the gate decided, and over which plan.
 */
function cacheVerdict(key: string, verdict: CachedVerdict): void {
  verdictCache.delete(key);
  verdictCache.set(key, verdict);
  while (verdictCache.size > CACHE_LIMIT) {
    const oldest = verdictCache.keys().next();
    if (oldest.done) break;
    verdictCache.delete(oldest.value);
  }
}

/**
 * Build the content-addressed key for a pair, when the SHAs allow one.
 *
 * The paths are part of the key, not just the bytes: the gate compares the
 * approval's recorded spec and plan paths against the ones being dispatched,
 * so the same three blobs copied into the other tree are a different decision.
 * Keying on content alone would let the original path's `true` be reused for
 * the copy, and the picker would offer a pair the server gate then refuses.
 *
 * Which plan gets read is decided by the approval, which is not known until it
 * has been read — so the key covers every plan that shares the slug rather
 * than only the paired one. An edit to any of them changes the key, whichever
 * one the approval turns out to name.
 *
 * @param blobShas - Path-to-blob-SHA map from the directory listing.
 * @param specPath - The spec.
 * @param slug - Its shared `YYYY-MM-DD-<topic>` key.
 * @param approvalPath - The approval artifact beside the spec.
 * @returns The key, or null when the spec's or approval's SHA is unknown.
 */
function cacheKey(
  blobShas: Record<string, string> | undefined,
  specPath: string,
  slug: string,
  approvalPath: string,
): string | null {
  if (!blobShas) return null;
  const spec = blobShas[specPath];
  const approval = blobShas[approvalPath];
  if (spec === undefined || approval === undefined) return null;
  const plans = Object.keys(blobShas)
    .filter((p) => p.endsWith(`/${slug}.md`))
    .sort()
    .map((p) => `${p}=${blobShas[p]}`)
    .join(',');
  return `${specPath}|${spec}|${approval}|${plans}`;
}

/**
 * Whether a key actually describes the plan that ended up being read.
 *
 * An approval naming a plan outside the slug convention is not covered by the
 * key, so its verdict must not be cached — the entry would survive edits to a
 * file the key says nothing about.
 *
 * @param key - The key built for this pair.
 * @param planPath - The plan the approval named, or null for none.
 * @returns True when the verdict is safe to cache.
 */
function keyCoversPlan(key: string, planPath: string | null): boolean {
  return planPath === null || key.includes(`${planPath}=`);
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
  /** The plan the approval actually names, which may not be the paired one. */
  planPath?: string | null;
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
 * @returns The same pairs, with `approved` reflecting what dispatch would do
 *   and `planPath` set to the plan the approval names.
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
    const key = cacheKey(blobShas, pair.specPath, pair.slug, approvalPath);
    if (key !== null) {
      const hit = verdictCache.get(key);
      if (hit !== undefined) {
        verdicts.set(pair.key, {
          approved: hit.approved,
          unverified: false,
          planPath: hit.planPath,
        });
        return;
      }
    }

    try {
      const [specText, approvalRaw] = await Promise.all([
        readText(octokit, owner, repo, pair.specPath, ref),
        readText(octokit, owner, repo, approvalPath, ref),
      ]);

      // The approval records which plan was approved, and it is the authority
      // when the filename convention is ambiguous — a slug present in both
      // trees mid-migration. Pairing picks the spec's own tree there, which
      // is a guess; this is the recorded answer. Deferring to it also keeps
      // the returned pair dispatchable, since the panel submits this path.
      const parsed = approvalRaw === null ? null : parseSpecApproval(approvalRaw);
      const planPath = parsed?.ok === true ? parsed.approval.plan_path : pair.planPath;

      const planText = planPath ? await readText(octokit, owner, repo, planPath, ref) : null;

      // A named plan that is not there is not an empty plan. Hashing null like
      // an empty file would let an approved zero-byte plan keep matching after
      // deletion, and dispatch would refuse it afterwards.
      if (specText === null || (planPath !== null && planText === null)) {
        verdicts.set(pair.key, { approved: false, unverified: false, planPath });
        if (key !== null && keyCoversPlan(key, planPath)) cacheVerdict(key, { approved: false, planPath });
        return;
      }

      const decision = dispatchGateDecision({
        approvalRaw,
        currentSpecHash: hashSpecAndPlan(specText, planText),
        specPath: pair.specPath,
        planPath,
      });
      verdicts.set(pair.key, { approved: decision.allow, unverified: false, planPath });
      if (key !== null && keyCoversPlan(key, planPath))
        cacheVerdict(key, { approved: decision.allow, planPath });
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
    return {
      ...p,
      approved: verdict?.approved === true,
      unverified: verdict?.unverified === true,
      planPath: verdict?.planPath !== undefined ? verdict.planPath : p.planPath,
    };
  });
}
