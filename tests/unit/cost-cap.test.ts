import { describe, it, expect } from 'vitest';
import { CostCapTracker } from '../../lib/cost-cap';

describe('CostCapTracker', () => {
  it('accumulates tokens and dollars', () => {
    const t = new CostCapTracker({ tokens_in: 1000, tokens_out: 500, dollars: 0.5 });
    t.add({ tokens_in: 100, tokens_out: 50, dollars: 0.05 });
    t.add({ tokens_in: 200, tokens_out: 100, dollars: 0.10 });
    const usage = t.usage();
    expect(usage.tokens_in).toBe(300);
    expect(usage.tokens_out).toBe(150);
    expect(usage.dollars).toBeCloseTo(0.15, 5);
  });

  it('throws when tokens_in cap is exceeded', () => {
    const t = new CostCapTracker({ tokens_in: 100, tokens_out: 100, dollars: 1 });
    expect(() => t.add({ tokens_in: 150, tokens_out: 0, dollars: 0 })).toThrow(/tokens_in/i);
  });

  it('throws when dollars cap is exceeded', () => {
    const t = new CostCapTracker({ tokens_in: 1e9, tokens_out: 1e9, dollars: 0.10 });
    expect(() => t.add({ tokens_in: 1, tokens_out: 1, dollars: 0.20 })).toThrow(/dollars/i);
  });

  it('approachingCap returns true at 80%+ usage', () => {
    const t = new CostCapTracker({ tokens_in: 100, tokens_out: 100, dollars: 1 });
    t.add({ tokens_in: 85, tokens_out: 0, dollars: 0 });
    expect(t.approachingCap()).toBe(true);
  });

  it('approachingCap returns false below 80%', () => {
    const t = new CostCapTracker({ tokens_in: 100, tokens_out: 100, dollars: 1 });
    t.add({ tokens_in: 50, tokens_out: 50, dollars: 0.5 });
    expect(t.approachingCap()).toBe(false);
  });
});
