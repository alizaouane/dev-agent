import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { RepoInfo } from '@/lib/repos';
import type { FeatureItem } from '@/lib/pipeline';
import { fetchPipeline, needsActionFilter, isTerminalState } from '@/lib/pipeline';
import { outcomesForFeature, rollup } from '@/lib/verification/aggregate';
import type { VerificationOutcome, VerificationRollup } from '@/lib/verification/types';

export type HeroBand =
  | { state: 'empty'; message: string }
  | { state: 'wired'; message: string; repo_count: number };

export type RepoSummary = {
  repo: string;
  in_flight_count: number;
  proposals_count: number; // populated 0 in v1; scout-per-repo wiring is a follow-up
  last_shipped_age_seconds: number | null;
  cost_7d_usd: number; // populated 0 in v1; cost-per-repo aggregation is a follow-up
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

export async function attachOutcomes(
  octokit: Octokit,
  items: FeatureItem[],
): Promise<Array<FeatureItem & { outcomes: VerificationOutcome[] }>> {
  return Promise.all(
    items.map(async (i) => ({
      ...i,
      outcomes: await outcomesForFeature(octokit, i.repo, i.issue_number),
    })),
  );
}

export function buildRepoSummaries(
  wired: RepoInfo[],
  items: FeatureItem[],
): RepoSummary[] {
  return wired.map((r) => {
    const repo = `${r.owner}/${r.name}`;
    const repoItems = items.filter((i) => i.repo === repo);
    const inFlight = repoItems.filter((i) => !isTerminalState(i.state) && !needsActionFilter(i));
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

export async function buildVerificationRollup(
  octokit: Octokit,
  items: FeatureItem[],
  windowDays = 7,
): Promise<VerificationRollup> {
  const recent = items.filter((i) => i.state === 'state:done' && i.age_seconds <= windowDays * 24 * 3600);
  const all: VerificationOutcome[] = (
    await Promise.all(recent.map((i) => outcomesForFeature(octokit, i.repo, i.issue_number)))
  ).flat();
  const totalCost = all.reduce((sum, o) => sum + (o.cost_usd ?? 0), 0);
  return rollup(all, {
    window_days: windowDays,
    shipped_count: recent.length,
    total_cost_usd: totalCost,
  });
}

export async function loadHomeBands(octokit: Octokit, wired: RepoInfo[]) {
  const items = await fetchPipeline(octokit, wired, { include_terminal: true });
  const { needsAction, inMotion, recentlyShipped } = partitionPipeline(items);
  const [needsActionWithOutcomes, inMotionWithOutcomes, recentWithOutcomes, postureRollup] =
    await Promise.all([
      attachOutcomes(octokit, needsAction.slice(0, 5)),
      attachOutcomes(octokit, inMotion.slice(0, 5)),
      attachOutcomes(octokit, recentlyShipped.slice(0, 5)),
      buildVerificationRollup(octokit, items),
    ]);
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
