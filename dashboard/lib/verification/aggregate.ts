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

/**
 * Per-feature outcomes with 30-min in-memory cache. Key is the feature
 * (`<repo>#<issue_number>`) — caching at this granularity means features
 * shared across two page loads (e.g. the same repo on Home + per-repo
 * workspace) hit the same cache slot, AND the order of any batched call
 * cannot pollute the cached value (Codex P1).
 *
 * One extractor failing does NOT drop the rest of the feature's outcomes
 * (CodeRabbit R5): we use Promise.allSettled and warn on rejections.
 */
export async function outcomesForFeature(
  octokit: Octokit,
  repo: string,
  issueNumber: number,
  deps: AggregatorDeps = DEFAULT_DEPS,
): Promise<VerificationOutcome[]> {
  const cacheKey = hashInputs([`${repo}#${issueNumber}`], 0);
  const cached = getCached<VerificationOutcome[]>(cacheKey);
  if (cached) return cached;

  const settled = await Promise.allSettled([
    deps.extractGateB(octokit, repo, issueNumber),
    deps.extractAudit(octokit, repo, issueNumber),
    deps.extractRisk(octokit, repo, issueNumber),
    deps.extractSmoke(octokit, repo, issueNumber),
  ]);
  const fresh: VerificationOutcome[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value !== null) {
      fresh.push(r.value);
    } else if (r.status === 'rejected') {
      console.warn(`outcomesForFeature: extractor failed for ${repo}#${issueNumber}:`, r.reason);
    }
  }
  setCached(cacheKey, fresh);
  return fresh;
}

/**
 * Batched parallel mapper. Returns one outcomes array per input feature,
 * in the caller's input order. Caching happens per-feature inside
 * `outcomesForFeature`, so this function is itself stateless wrt cache.
 */
export async function outcomesForFeatures(
  octokit: Octokit,
  features: Array<{ repo: string; issue_number: number }>,
  deps: AggregatorDeps = DEFAULT_DEPS,
): Promise<VerificationOutcome[][]> {
  if (features.length === 0) return [];
  return Promise.all(
    features.map((f) => outcomesForFeature(octokit, f.repo, f.issue_number, deps)),
  );
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
