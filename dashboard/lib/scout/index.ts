import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { RepoInfo } from '../repos';
import { scoutRecurringCIFailures } from './ci-failures';
import { scoutSpecDrift } from './drift';
import { scoutUnfinishedPlans } from './plans';
import { scoutPendingSpecs } from './specs';
import { scoutUntriagedIssues } from './triage';
import type { Proposal } from './types';

export type { Proposal, ProposalSource, ProposalGroup } from './types';
export { SOURCE_TO_GROUP } from './types';

/**
 * Run every scout source against every wired-up repo and merge the
 * results into a single flat list. Failures in one repo or one source
 * are logged but don't fail the whole batch — proposals are
 * best-effort by design.
 *
 * Concurrency: each repo's scouts run in parallel; per-repo concurrency
 * is bounded only by Octokit's default queue. For tenants with many
 * repos this could be parallelized further with a pLimit, but at v1
 * scout load isn't a hot path (runs on `/proposals` page load, not in
 * a request loop).
 */
export async function runAllScouts(
  octokit: Octokit,
  wiredRepos: RepoInfo[],
): Promise<Proposal[]> {
  const perRepo = await Promise.all(
    wiredRepos.map(async (r) => {
      try {
        const [plans, triage, drift, pendingSpecs, ciFailures] = await Promise.all([
          scoutUnfinishedPlans(octokit, r.owner, r.name, r.default_branch),
          scoutUntriagedIssues(octokit, r.owner, r.name),
          scoutSpecDrift(octokit, r.owner, r.name, r.default_branch),
          scoutPendingSpecs(octokit, r.owner, r.name, r.default_branch),
          scoutRecurringCIFailures(octokit, r.owner, r.name),
        ]);
        return [...plans, ...triage, ...drift, ...pendingSpecs, ...ciFailures];
      } catch (err) {
        console.warn(`runAllScouts: failed for ${r.owner}/${r.name}:`, err);
        return [];
      }
    }),
  );
  return perRepo.flat();
}
