import 'server-only';
import type { Octokit } from '@octokit/rest';
import { extractAuditOutcome } from './extractors/audit';
import { extractRiskOutcome } from './extractors/risk';
import { extractSmokeOutcome } from './extractors/smoke';
import { extractGateBOutcome } from './extractors/gate-b';
import { hashInputs, getCached, setCached } from './cache';
import type { VerificationOutcome, VerificationRollup } from './types';

// Pillar 2 (evidence) is not in v1 — see deferred sub-task tracker.
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

/**
 * Batched outcomes for a list of features, with 30-min in-memory cache. Returns
 * one outcomes array per input feature, in the same order. Cache key is the
 * sorted list of `<repo>#<issue_number>` so two callers with the same feature
 * set hit the same cache slot regardless of input order.
 */
export async function outcomesForFeatures(
  octokit: Octokit,
  features: Array<{ repo: string; issue_number: number }>,
  deps: AggregatorDeps = DEFAULT_DEPS,
): Promise<VerificationOutcome[][]> {
  if (features.length === 0) return [];
  const keyParts = features.map((f) => `${f.repo}#${f.issue_number}`);
  const cacheKey = hashInputs(keyParts, 0);
  const cached = getCached<VerificationOutcome[][]>(cacheKey);
  if (cached) return cached;
  const fresh = await Promise.all(
    features.map((f) => outcomesForFeature(octokit, f.repo, f.issue_number, deps)),
  );
  setCached(cacheKey, fresh);
  return fresh;
}

export function rollupFromOutcomes(
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

// Deprecated alias — keep export so nothing breaks if external callers exist.
export const rollup = rollupFromOutcomes;
