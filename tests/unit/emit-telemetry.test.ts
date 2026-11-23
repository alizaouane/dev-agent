import { describe, it, expect } from 'vitest';
import { extractUsage, estimateCost, buildBody } from '../../lib/cli/emit-telemetry';

describe('extractUsage', () => {
  it('reads a reported total cost', () => {
    const u = extractUsage(JSON.stringify({ total_cost_usd: 1.23, usage: { input_tokens: 100, output_tokens: 50 } }));
    expect(u.costUsd).toBeCloseTo(1.23);
    expect(u.tokensIn).toBe(100);
  });

  it('sums usage nested across messages', () => {
    const u = extractUsage(JSON.stringify({
      messages: [
        { usage: { input_tokens: 100, output_tokens: 10 } },
        { usage: { input_tokens: 200, output_tokens: 20 } },
      ],
    }));
    expect(u.tokensIn).toBe(300);
    expect(u.tokensOut).toBe(30);
  });

  it('handles JSON Lines output', () => {
    const u = extractUsage('{"usage":{"input_tokens":5,"output_tokens":1}}\n{"usage":{"input_tokens":7,"output_tokens":2}}');
    expect(u.tokensIn).toBe(12);
  });

  it('returns unknown cost rather than zero for garbage', () => {
    const u = extractUsage('not json');
    expect(u.costUsd).toBeNull();
    expect(u.tokensIn).toBe(0);
  });
});

describe('estimateCost', () => {
  it('prices a sonnet run from tokens', () => {
    // 1M in @ $3 + 1M out @ $15
    expect(estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18);
  });
  it('returns null for an unknown model family', () => {
    expect(estimateCost('some-other-model', 1000, 1000)).toBeNull();
  });
  it('returns null when there are no tokens to price', () => {
    expect(estimateCost('claude-sonnet-4-6', 0, 0)).toBeNull();
  });
});

describe('buildBody', () => {
  const usage = { tokensIn: 1000, tokensOut: 500, costUsd: null, durationMs: 1000 };

  it('marks an undeterminable cost as unavailable rather than free', () => {
    // The whole point: a silent $0 is what made the gate decorative.
    const body = buildBody({ phase: 'implement', model: 'mystery', usage, status: 'success' });
    expect(body).toMatch(/cost_source: unavailable/);
  });

  // dev-agent#200 ruling A. Breakers: `cost ?? 0` in buildBody (both tests red);
  // `?? UNKNOWN_RUN_FALLBACK_USD` -> `?? 0` (second test red).
  it('charges an unmeasured run at the phase cap, never $0', () => {
    const body = buildBody({ phase: 'implement', model: 'mystery', usage, status: 'blocked', unknownCostUsd: 5 });
    expect(body).toMatch(/Cost: \$5\.00/);
    expect(body).toMatch(/cost_source: unavailable-charged-at-cap/);
  });
  it('charges the fallback when no cap is passed', () => {
    const body = buildBody({ phase: 'implement', model: 'mystery', usage, status: 'blocked' });
    expect(body).not.toMatch(/Cost: \$0\.00/);
    expect(body).toMatch(/Cost: \$5\.00/);
  });

  it('labels an estimated cost as estimated', () => {
    const body = buildBody({ phase: 'implement', model: 'claude-sonnet-4-6', usage, status: 'success' });
    expect(body).toMatch(/cost_source: estimated/);
  });

  it('labels a reported cost as reported', () => {
    const body = buildBody({
      phase: 'implement', model: 'claude-sonnet-4-6',
      usage: { ...usage, costUsd: 2.5 }, status: 'success',
    });
    expect(body).toMatch(/cost_source: reported/);
    expect(body).toMatch(/Cost: \$2\.50/);
  });

  it('emits a block the watchdog can parse back', () => {
    const body = buildBody({
      phase: 'scout_digest', model: 'claude-haiku-4-5',
      usage: { ...usage, costUsd: 0.4 }, status: 'success',
    });
    expect(body).toMatch(/^🤖 Phase: scout_digest/);
    expect(body).toMatch(/Cost: \$0\.40/);
  });
});
