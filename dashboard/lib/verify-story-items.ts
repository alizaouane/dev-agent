import 'server-only';

import type { Octokit } from '@octokit/rest';

import { approvalPathForStory, hashStory, storyDispatchGateDecision } from './story-approval';
import type { StoryItem } from './story-items';

/**
 * Decide which stories the dispatch path would actually accept.
 *
 * The presence of an artifact is not approval. The gate checks the recorded
 * verdict is clean, the schema is one it understands, the recorded path is the
 * one being dispatched, and the story still hashes to what was approved. A
 * stale approval passes a filename check and fails the gate, which is exactly
 * the round-trip failure the picker exists to remove.
 *
 * Only stories that already carry an artifact are read, so a repo with a
 * hundred unapproved stories makes no calls at all.
 */

/** How many stories to verify at once. A concurrency limit, not a cap. */
const BATCH = 25;

/** Most cached verdicts to keep, across every repo in the process. */
const CACHE_LIMIT = 2000;

/**
 * Verdicts keyed by the content that produced them.
 *
 * A verdict is a function of two blob SHAs, so it never goes stale: editing
 * either file changes its SHA and misses the cache. Insertion-ordered, so
 * evicting the oldest key is the whole eviction policy.
 */
const verdictCache = new Map<string, boolean>();

/**
 * Record a verdict against the content it was derived from.
 *
 * @param key - Content-addressed cache key.
 * @param approved - What the gate decided.
 */
function cacheVerdict(key: string, approved: boolean): void {
  verdictCache.delete(key);
  verdictCache.set(key, approved);
  while (verdictCache.size > CACHE_LIMIT) {
    const oldest = verdictCache.keys().next();
    if (oldest.done) break;
    verdictCache.delete(oldest.value);
  }
}

/**
 * Build the content-addressed key for a story, when the SHAs allow one.
 *
 * The path is part of the key, not just the bytes: the gate compares the
 * approval's recorded story path against the one being dispatched, so the same
 * blobs copied elsewhere are a different decision.
 *
 * @param blobShas - Path-to-blob-SHA map from the tree listing.
 * @param storyPath - The story.
 * @param approvalPath - The artifact beside it.
 * @returns The key, or null when either SHA is unknown.
 */
function cacheKey(
  blobShas: Record<string, string> | undefined,
  storyPath: string,
  approvalPath: string,
): string | null {
  if (!blobShas) return null;
  const story = blobShas[storyPath];
  const approval = blobShas[approvalPath];
  if (story === undefined || approval === undefined) return null;
  return `${storyPath}|${story}|${approval}`;
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

/** What verifying one story concluded. */
interface Verdict {
  /** True only when the gate would let dispatch proceed. */
  approved: boolean;
  /** True when a read failed for a reason other than the file being absent. */
  unverified: boolean;
}

/**
 * Re-derive `approved` on each story by running the real gate decision.
 *
 * A story whose reads fail comes back `approved: false, unverified: true`.
 * Those are different facts: one says the gate refused, the other says the
 * gate never ran.
 *
 * @param octokit - Authenticated client.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param ref - Branch the files live on.
 * @param items - Output of `toStoryItems`.
 * @param blobShas - Optional path-to-blob-SHA map from the tree listing, used
 *   to serve unchanged stories from cache instead of re-reading them.
 * @returns The same items, with `approved` reflecting what dispatch would do.
 */
export async function verifyStoryItems(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  items: StoryItem[],
  blobShas?: Record<string, string>,
): Promise<StoryItem[]> {
  const candidates = items.filter((i) => i.approved);
  if (candidates.length === 0) {
    return items.map((i) => ({ ...i, approved: false, unverified: false }));
  }

  const verdicts = new Map<string, Verdict>();

  const verifyOne = async (story: StoryItem): Promise<void> => {
    const approvalPath = approvalPathForStory(story.storyPath);
    const key = cacheKey(blobShas, story.storyPath, approvalPath);
    if (key !== null) {
      const hit = verdictCache.get(key);
      if (hit !== undefined) {
        verdicts.set(story.key, { approved: hit, unverified: false });
        return;
      }
    }

    try {
      const [storyText, approvalRaw] = await Promise.all([
        readText(octokit, owner, repo, story.storyPath, ref),
        readText(octokit, owner, repo, approvalPath, ref),
      ]);

      if (storyText === null) {
        verdicts.set(story.key, { approved: false, unverified: false });
        if (key !== null) cacheVerdict(key, false);
        return;
      }

      // The gate reads the story alone — never the source spec. A late
      // amendment to a program spec must not invalidate every story derived
      // from it, which is the whole asymmetry this design rests on.
      const decision = storyDispatchGateDecision({
        approvalRaw,
        currentStoryHash: hashStory(storyText),
        storyPath: story.storyPath,
      });
      verdicts.set(story.key, { approved: decision.allow, unverified: false });
      if (key !== null) cacheVerdict(key, decision.allow);
    } catch {
      // A read we could not complete is not an approval, and not a refusal
      // either. Caching it would make one rate-limited render stick.
      verdicts.set(story.key, { approved: false, unverified: true });
    }
  };

  // eslint-disable-next-line no-restricted-syntax -- batches run in sequence so
  // a repo with many approvals does not open every read at once.
  for (let i = 0; i < candidates.length; i += BATCH) {
    await Promise.all(candidates.slice(i, i + BATCH).map(verifyOne));
  }

  return items.map((i) => {
    const verdict = verdicts.get(i.key);
    return {
      ...i,
      approved: verdict?.approved === true,
      unverified: verdict?.unverified === true,
    };
  });
}
