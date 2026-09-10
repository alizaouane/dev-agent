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

/** Upper bound on pairs verified per page render. */
const MAX_VERIFIED = 25;

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

/**
 * Re-derive `approved` on each pair by running the real gate decision.
 *
 * @param octokit - Authenticated client.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param ref - Branch the files live on.
 * @param pairs - Output of `pairSpecsAndPlans`.
 * @returns The same pairs, with `approved` reflecting what dispatch would do.
 */
export async function verifySpecPairs(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  pairs: SpecPair[],
): Promise<SpecPair[]> {
  const candidates = pairs.filter((p) => p.approved).slice(0, MAX_VERIFIED);
  if (candidates.length === 0) return pairs.map((p) => ({ ...p, approved: false }));

  const verdicts = new Map<string, boolean>();
  await Promise.all(
    candidates.map(async (pair) => {
      try {
        const approvalPath = `${pair.specPath.replace(/\.md$/, '')}.approval.json`;
        const [specText, planText, approvalRaw] = await Promise.all([
          readText(octokit, owner, repo, pair.specPath, ref),
          pair.planPath ? readText(octokit, owner, repo, pair.planPath, ref) : Promise.resolve(null),
          readText(octokit, owner, repo, approvalPath, ref),
        ]);
        if (specText === null) {
          verdicts.set(pair.key, false);
          return;
        }
        const decision = dispatchGateDecision({
          approvalRaw,
          currentSpecHash: hashSpecAndPlan(specText, planText),
          specPath: pair.specPath,
          planPath: pair.planPath,
        });
        verdicts.set(pair.key, decision.allow);
      } catch {
        // A read we could not complete is not an approval. Offering the spec
        // on that basis would be guessing, and the guess fails at dispatch.
        verdicts.set(pair.key, false);
      }
    }),
  );

  return pairs.map((p) => ({ ...p, approved: verdicts.get(p.key) === true }));
}
