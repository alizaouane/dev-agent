import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clearCache } from '@/lib/verification/cache';
import {
  outcomesForFeature,
  outcomesForFeatures,
  rollup,
  type AggregatorDeps,
} from '@/lib/verification/aggregate';
import type { VerificationOutcome } from '@/lib/verification/types';

beforeEach(() => clearCache());

const passed = (pillar: VerificationOutcome['pillar']): VerificationOutcome => ({
  feature_id: 1,
  repo: 'a/b',
  pillar,
  status: 'passed',
  summary: 'ok',
  details_url: 'x',
  ran_at: '2026-05-09T10:00:00Z',
});

describe('outcomesForFeature', () => {
  it('returns one outcome per pillar that produced one', async () => {
    const deps: AggregatorDeps = {
      extractGateB: vi.fn().mockResolvedValue(passed('gate_b')),
      extractAudit: vi.fn().mockResolvedValue(passed('audit_p4')),
      extractRisk: vi.fn().mockResolvedValue(null),
      extractSmoke: vi.fn().mockResolvedValue(passed('smoke_p7')),
    };
    const out = await outcomesForFeature({} as never, 'a/b', 1, deps);
    expect(out.map((o) => o.pillar).sort()).toEqual(['audit_p4', 'gate_b', 'smoke_p7']);
  });
});

describe('rollup', () => {
  it('counts shipped, audit-caught, risk-flagged, smoke-failed', () => {
    const r = rollup(
      [
        passed('gate_b'),
        { ...passed('audit_p4'), status: 'advisory' },
        { ...passed('risk_p5'), status: 'advisory' },
        { ...passed('smoke_p7'), status: 'failed' },
      ],
      { window_days: 7, shipped_count: 12, total_cost_usd: 4.2 },
    );
    expect(r).toMatchObject({
      window_days: 7,
      shipped_count: 12,
      audit_caught_count: 1,
      risk_flagged_count: 1,
      smoke_failed_count: 1,
      total_cost_usd: 4.2,
    });
  });
});

describe('outcomesForFeatures', () => {
  it('caches results by feature-set key — second call does not re-fetch', async () => {
    const extractGateB = vi.fn().mockResolvedValue(passed('gate_b'));
    const extractAudit = vi.fn().mockResolvedValue(passed('audit_p4'));
    const extractRisk = vi.fn().mockResolvedValue(null);
    const extractSmoke = vi.fn().mockResolvedValue(null);
    const deps: AggregatorDeps = { extractGateB, extractAudit, extractRisk, extractSmoke };

    const features = [{ repo: 'a/b', issue_number: 42 }];
    // First call — populates cache
    const r1 = await outcomesForFeatures({} as never, features, deps);
    expect(r1.length).toBe(1);
    expect(r1[0].length).toBe(2);
    expect(extractGateB).toHaveBeenCalledTimes(1);

    // Second call — should hit cache, not re-call extractors
    const r2 = await outcomesForFeatures({} as never, features, deps);
    expect(r2).toEqual(r1);
    expect(extractGateB).toHaveBeenCalledTimes(1); // still 1, no re-call
  });
});
