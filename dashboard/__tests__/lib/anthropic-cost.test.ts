import { describe, it, expect } from 'vitest';
import {
  shapeDailyByModel,
  type CostBucket,
} from '@/lib/anthropic-cost';

/** One results row with sensible defaults; override per test. */
function row(over: Partial<CostBucket['results'][number]>): CostBucket['results'][number] {
  return {
    amount: '0',
    currency: 'USD',
    cost_type: 'tokens',
    model: 'claude-sonnet-4-6',
    token_type: 'uncached_input_tokens',
    context_window: '0-200k',
    service_tier: 'standard',
    workspace_id: null,
    inference_geo: 'global',
    description: null,
    ...over,
  };
}

describe('shapeDailyByModel', () => {
  it('converts fractional cents to USD, folds model families, and separates non-token cost', () => {
    const buckets: CostBucket[] = [
      {
        starting_at: '2026-07-01T00:00:00Z',
        ending_at: '2026-07-02T00:00:00Z',
        results: [
          // sonnet: two token-type rows same day+model must sum
          row({ amount: '123.78912', model: 'claude-sonnet-4-6', token_type: 'uncached_input_tokens' }),
          row({ amount: '10', model: 'claude-sonnet-4-6', token_type: 'output_tokens' }),
          row({ amount: '50', model: 'claude-haiku-4-5' }),
          row({ amount: '200', model: 'claude-opus-4-7' }),
          // unknown non-null model → other_model
          row({ amount: '5', model: 'claude-future-9' }),
          // non-token cost: model null → non_token
          row({ amount: '30', model: null, token_type: null, context_window: null, service_tier: null, cost_type: 'web_search' }),
        ],
      },
      {
        starting_at: '2026-07-02T00:00:00Z',
        ending_at: '2026-07-03T00:00:00Z',
        results: [row({ amount: '400', model: 'claude-sonnet-4-6' })],
      },
    ];

    const out = shapeDailyByModel(buckets);

    // Two UTC days, ascending.
    expect(out.days.map((d) => d.day)).toEqual(['2026-07-01', '2026-07-02']);

    // Day 1 sonnet = (123.78912 + 10) cents / 100 = 1.3378912 USD
    expect(out.days[0].sonnet).toBeCloseTo((123.78912 + 10) / 100, 10);
    expect(out.days[0].haiku).toBeCloseTo(50 / 100, 10);
    expect(out.days[0].opus).toBeCloseTo(200 / 100, 10);
    expect(out.days[0].other_model).toBeCloseTo(5 / 100, 10);
    expect(out.days[0].non_token).toBeCloseTo(30 / 100, 10);
    expect(out.days[1].sonnet).toBeCloseTo(400 / 100, 10);

    // total = computed from the fixture (NOT a hand-typed golden), and matches
    // an independent fractional-cents accumulation (no float drift).
    const allCents = [123.78912, 10, 50, 200, 5, 30, 400];
    const expectedTotal = allCents.reduce((s, c) => s + c, 0) / 100;
    expect(out.total_usd).toBeCloseTo(expectedTotal, 10);
    expect(out.by_series.sonnet).toBeCloseTo((123.78912 + 10 + 400) / 100, 10);
  });

  it('ignores rows with a non-finite amount instead of poisoning the total', () => {
    const buckets: CostBucket[] = [
      {
        starting_at: '2026-07-01T00:00:00Z',
        ending_at: '2026-07-02T00:00:00Z',
        results: [row({ amount: 'not-a-number' }), row({ amount: '100', model: 'claude-haiku-4-5' })],
      },
    ];
    const out = shapeDailyByModel(buckets);
    expect(Number.isFinite(out.total_usd)).toBe(true);
    expect(out.total_usd).toBeCloseTo(1, 10);
  });

  it('returns an empty summary for no buckets', () => {
    const out = shapeDailyByModel([]);
    expect(out.days).toEqual([]);
    expect(out.total_usd).toBe(0);
  });
});
