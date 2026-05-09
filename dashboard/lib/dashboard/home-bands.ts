import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { RepoInfo } from '@/lib/repos';
import type { FeatureItem } from '@/lib/pipeline';
import { fetchPipeline, needsActionFilter, isTerminalState } from '@/lib/pipeline';
import { outcomesForFeatures, rollupFromOutcomes } from '@/lib/verification/aggregate';
import type { VerificationOutcome, VerificationRollup } from '@/lib/verification/types';

export type HeroBand =
  | { state: 'empty'; message: string }
  | { state: 'wired'; message: string; repo_count: number };

export type RepoSummary = {
  repo: string;
  in_flight_count: number;
  proposals_count: number;
  last_shipped_age_seconds: number | null;
  cost_7d_usd: number;
};

export function buildHero(
  wired: RepoInfo[],
  counts: { needs_action_count: number; in_motion_count: number },
): HeroBand {
  if (wired.length === 0) {
    return { state: 'empty', message: 'Welcome to dev-agent' };
  }
  return {
    state: 'wired',
    repo_count: wired.length,
    message: `Good morning. dev-agent is watching ${wired.length} repo${wired.length === 1 ? '' : 's'}. ${counts.needs_action_count} thing${counts.needs_action_count === 1 ? '' : 's'} need${counts.needs_action_count === 1 ? 's' : ''} you, ${counts.in_motion_count} in motion.`,
  };
}

const IN_MOTION_STATES = new Set([
  'state:scoping',
  'state:acm-building',
  'state:implementing',
  'state:swarm-reviewing',
  'state:staging-deployed',
  'state:tier2-smoke',
  'state:promoting',
]);

export function partitionPipeline(items: FeatureItem[]) {
  const needsAction = items.filter(needsActionFilter);
  const inMotion = items.filter((i) => IN_MOTION_STATES.has(i.state));
  const recentlyShipped = items.filter(
    (i) => i.state === 'state:done' && i.age_seconds <= 7 * 24 * 3600,
  );
  return { needsAction, inMotion, recentlyShipped };
}

export function buildRepoSummaries(
  wired: RepoInfo[],
  items: FeatureItem[],
): RepoSummary[] {
  return wired.map((r) => {
    const repo = `${r.owner}/${r.name}`;
    const repoItems = items.filter((i) => i.repo === repo);
    // Issue #7 fix: include needs-action items in in-flight count. A repo
    // where 3 features are all awaiting review should not show "0 in flight".
    const inFlight = repoItems.filter((i) => !isTerminalState(i.state));
    const lastShipped = repoItems
      .filter((i) => i.state === 'state:done')
      .sort((a, b) => a.age_seconds - b.age_seconds)[0];
    return {
      repo,
      in_flight_count: inFlight.length,
      proposals_count: 0,
      last_shipped_age_seconds: lastShipped ? lastShipped.age_seconds : null,
      cost_7d_usd: 0,
    };
  });
}

export async function loadHomeBands(octokit: Octokit, wired: RepoInfo[]) {
  const items = await fetchPipeline(octokit, wired, { include_terminal: true });
  const { needsAction, inMotion, recentlyShipped } = partitionPipeline(items);

  // Cap each band at 5 for rendering. Combine into a single cached batched
  // fetch — the cache key is order-independent so the same features fetched
  // by different bands hit the same cache entry. Then distribute outcomes
  // back to each band by (repo, issue_number) lookup.
  const topNeeds = needsAction.slice(0, 5);
  const topMotion = inMotion.slice(0, 5);
  const topRecent = recentlyShipped.slice(0, 5);

  // Dedupe on (repo, issue_number) before fetching — the same feature can in
  // theory appear in two bands during a transition.
  const seen = new Set<string>();
  const uniqueFeatures: Array<{ repo: string; issue_number: number }> = [];
  for (const item of [...topNeeds, ...topMotion, ...topRecent]) {
    const k = `${item.repo}#${item.issue_number}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniqueFeatures.push({ repo: item.repo, issue_number: item.issue_number });
  }

  const outcomesList = await outcomesForFeatures(octokit, uniqueFeatures);
  const outcomesByKey = new Map<string, VerificationOutcome[]>();
  uniqueFeatures.forEach((f, i) => {
    outcomesByKey.set(`${f.repo}#${f.issue_number}`, outcomesList[i]);
  });

  function attach(items: FeatureItem[]): Array<FeatureItem & { outcomes: VerificationOutcome[] }> {
    return items.map((i) => ({
      ...i,
      outcomes: outcomesByKey.get(`${i.repo}#${i.issue_number}`) ?? [],
    }));
  }

  const needsActionWithOutcomes = attach(topNeeds);
  const inMotionWithOutcomes = attach(topMotion);
  const recentWithOutcomes = attach(topRecent);

  // Build rollup from the recentlyShipped band's outcomes — no extra fetch.
  // shipped_count counts ALL recently-shipped items (not just the top-5
  // shown), so we use the full list length.
  const recentOutcomesFlat = recentWithOutcomes.flatMap((r) => r.outcomes);
  const totalCost = recentOutcomesFlat.reduce((sum, o) => sum + (o.cost_usd ?? 0), 0);
  const postureRollup: VerificationRollup = rollupFromOutcomes(recentOutcomesFlat, {
    window_days: 7,
    shipped_count: recentlyShipped.length,
    total_cost_usd: totalCost,
  });

  const hero = buildHero(wired, {
    needs_action_count: needsAction.length,
    in_motion_count: inMotion.length,
  });
  const repoSummaries = buildRepoSummaries(wired, items);
  return {
    hero,
    needsAction: needsActionWithOutcomes,
    inMotion: inMotionWithOutcomes,
    recentlyShipped: recentWithOutcomes,
    posture: postureRollup,
    repoSummaries,
  };
}
