import 'server-only';
import type { Octokit } from '@octokit/rest';
import { extractAuditOutcome } from './extractors/audit';
import { extractRiskOutcome } from './extractors/risk';
import { extractSmokeOutcome } from './extractors/smoke';
import { extractGateBOutcome } from './extractors/gate-b';
import type { VerificationOutcome, VerificationRollup } from './types';

// Pillar 2 (evidence) is not in v1 — it has no comment artifact; surfacing it
// would require the workflow-runs API. Implicit signal: if Gate B produced an
// outcome, the EvidenceBundle was frozen (it's a hard prerequisite). See the
// deferred sub-task tracker.
export type AggregatorDeps = {
  extractGateB: typeof extractGateBOutcome;
  extractAudit: typeof extractAuditOutcome;
  extractRisk: typeof extractRiskOutcome;
  extractSmoke: typeof extractSmokeOutcome;
};

const DEFAULT_DEPS: AggregatorDeps = {
  extractGateB: extractGateBOutcome,
  extractAudit: extractAuditOutcome,
  extractRisk: extractRiskOutcome,
  extractSmoke: extractSmokeOutcome,
};

export async function outcomesForFeature(
  octokit: Octokit,
  repo: string,
  issueNumber: number,
  deps: AggregatorDeps = DEFAULT_DEPS,
): Promise<VerificationOutcome[]> {
  const results = await Promise.all([
    deps.extractGateB(octokit, repo, issueNumber),
    deps.extractAudit(octokit, repo, issueNumber),
    deps.extractRisk(octokit, repo, issueNumber),
    deps.extractSmoke(octokit, repo, issueNumber),
  ]);
  return results.filter((r): r is VerificationOutcome => r !== null);
}

export function rollup(
  outcomes: VerificationOutcome[],
  base: { window_days: number; shipped_count: number; total_cost_usd: number },
): VerificationRollup {
  return {
    window_days: base.window_days,
    generated_at: new Date().toISOString(),
    shipped_count: base.shipped_count,
    audit_caught_count: outcomes.filter(
      (o) => o.pillar === 'audit_p4' && (o.status === 'advisory' || o.status === 'blocked'),
    ).length,
    risk_flagged_count: outcomes.filter(
      (o) => o.pillar === 'risk_p5' && (o.status === 'advisory' || o.status === 'blocked'),
    ).length,
    smoke_failed_count: outcomes.filter(
      (o) => o.pillar === 'smoke_p7' && o.status === 'failed',
    ).length,
    total_cost_usd: base.total_cost_usd,
  };
}
