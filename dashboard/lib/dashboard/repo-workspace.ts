import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { RepoInfo } from '@/lib/repos';
import type { FeatureItem } from '@/lib/pipeline';
import { isTerminalState, fetchPipeline } from '@/lib/pipeline';
import { attachOutcomes, buildVerificationRollup } from './home-bands';
import type { PillarId } from '@/lib/verification/types';

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
  const [inFlightOutcomes, recentOutcomes, posture, workflows] = await Promise.all([
    attachOutcomes(octokit, inFlight.slice(0, 10)),
    attachOutcomes(octokit, recentlyShipped.slice(0, 10)),
    buildVerificationRollup(octokit, items),
    fetchRepoWorkflows(octokit, repo.owner, repo.name, repo.default_branch),
  ]);
  return {
    inFlight: inFlightOutcomes,
    recentlyShipped: recentOutcomes,
    posture,
    pillars: configuredPillars({ workflows }),
  };
}
