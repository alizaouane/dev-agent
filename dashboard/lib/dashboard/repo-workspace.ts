import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { RepoInfo } from '@/lib/repos';
import type { FeatureItem } from '@/lib/pipeline';
import { isTerminalState, fetchPipeline } from '@/lib/pipeline';
import { outcomesForFeatures, rollupFromOutcomes } from '@/lib/verification/aggregate';
import type { VerificationOutcome, VerificationRollup, PillarId } from '@/lib/verification/types';

const RISK_WORKFLOW = '.github/workflows/dev-agent-risk-audit.yml';
const SMOKE_WORKFLOW = '.github/workflows/dev-agent-tier2-smoke.yml';

export function partitionRepoPipeline(items: FeatureItem[]) {
  const inFlight = items.filter((i) => !isTerminalState(i.state));
  const recentlyShipped = items.filter(
    (i) => i.state === 'state:done' && i.age_seconds <= 14 * 24 * 3600,
  );
  return { inFlight, recentlyShipped };
}

export function configuredPillars(opts: { workflows: string[] }): Record<PillarId, boolean> {
  return {
    gate_b: true,
    audit_p4: true,
    evidence_p2: true,
    risk_p5: opts.workflows.includes(RISK_WORKFLOW),
    smoke_p7: opts.workflows.includes(SMOKE_WORKFLOW),
  };
}

async function fetchRepoWorkflows(
  octokit: Octokit,
  owner: string,
  name: string,
  ref: string,
): Promise<string[]> {
  try {
    const resp = await octokit.repos.getContent({ owner, repo: name, path: '.github/workflows', ref });
    const data = resp.data;
    if (Array.isArray(data)) {
      return data.filter((d) => d.type === 'file').map((d) => `.github/workflows/${d.name}`);
    }
    return [];
  } catch {
    return [];
  }
}

export async function loadRepoWorkspace(octokit: Octokit, repo: RepoInfo) {
  const items = await fetchPipeline(octokit, [repo], { include_terminal: true });
  const { inFlight, recentlyShipped } = partitionRepoPipeline(items);

  const topInFlight = inFlight.slice(0, 10);
  const topRecent = recentlyShipped.slice(0, 10);

  const seen = new Set<string>();
  const uniqueFeatures: Array<{ repo: string; issue_number: number }> = [];
  for (const item of [...topInFlight, ...topRecent]) {
    const k = `${item.repo}#${item.issue_number}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniqueFeatures.push({ repo: item.repo, issue_number: item.issue_number });
  }

  const [outcomesList, workflows] = await Promise.all([
    outcomesForFeatures(octokit, uniqueFeatures),
    fetchRepoWorkflows(octokit, repo.owner, repo.name, repo.default_branch),
  ]);

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

  const inFlightOutcomes = attach(topInFlight);
  const recentOutcomes = attach(topRecent);

  // Build rollup from the recently-shipped outcomes (window: 7 days subset of
  // the 14-day shown list). shipped_count counts only items in the 7-day window.
  const sevenDayShipped = recentlyShipped.filter((i) => i.age_seconds <= 7 * 24 * 3600);
  const sevenDayOutcomes = sevenDayShipped.flatMap(
    (i) => outcomesByKey.get(`${i.repo}#${i.issue_number}`) ?? [],
  );
  const totalCost = sevenDayOutcomes.reduce((sum, o) => sum + (o.cost_usd ?? 0), 0);
  const posture: VerificationRollup = rollupFromOutcomes(sevenDayOutcomes, {
    window_days: 7,
    shipped_count: sevenDayShipped.length,
    total_cost_usd: totalCost,
  });

  return {
    inFlight: inFlightOutcomes,
    recentlyShipped: recentOutcomes,
    posture,
    pillars: configuredPillars({ workflows }),
  };
}
