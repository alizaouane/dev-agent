import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { RepoInfo } from '../repos';
import { scoutBugFindings } from './bug-findings';
import { scoutCleanupFindings } from './cleanup-findings';
import { scoutCompetitorWatch } from './competitive';
import { scoutSpecDrift } from './drift';
import { scoutUnfinishedPlans } from './plans';
import { listMarkdownFiles } from './repo-tree';
import { scoutPendingSpecs } from './specs';
import { scoutUntriagedIssues } from './triage';
import { scoutUnfinishedWorkFindings } from './unfinished-work';
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
 *
 * **Shared tree walk.** Both spec + plan scouts auto-discover markdown
 * files anywhere in the repo (no `docs/specs/` / `docs/plans/`
 * convention required). We do the recursive tree listing once per
 * repo and pass the result to both scouts — half the API calls of
 * having each scout walk independently.
 */
export async function runAllScouts(
  octokit: Octokit,
  wiredRepos: RepoInfo[],
): Promise<Proposal[]> {
  const perRepo = await Promise.all(
    wiredRepos.map(async (r) => {
      try {
        const mdFiles = await listMarkdownFiles(octokit, r.owner, r.name, r.default_branch);
        const [
          plans,
          triage,
          drift,
          pendingSpecs,
          bugFindings,
          unfinishedWork,
          cleanupFindings,
          competitive,
        ] = await Promise.all([
          scoutUnfinishedPlans(octokit, r.owner, r.name, r.default_branch, mdFiles),
          scoutUntriagedIssues(octokit, r.owner, r.name),
          scoutSpecDrift(octokit, r.owner, r.name, r.default_branch),
          scoutPendingSpecs(octokit, r.owner, r.name, r.default_branch, mdFiles),
          scoutBugFindings(octokit, r.owner, r.name),
          scoutUnfinishedWorkFindings(octokit, r.owner, r.name),
          scoutCleanupFindings(octokit, r.owner, r.name),
          scoutCompetitorWatch(octokit, r.owner, r.name),
        ]);
        return [
          ...plans,
          ...triage,
          ...drift,
          ...pendingSpecs,
          ...bugFindings,
          ...unfinishedWork,
          ...cleanupFindings,
          ...competitive,
        ];
      } catch (err) {
        console.warn(`runAllScouts: failed for ${r.owner}/${r.name}:`, err);
        return [];
      }
    }),
  );
  return perRepo.flat();
}
