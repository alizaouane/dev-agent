import { describe, it, expect } from 'vitest';
import { usageToDollars, PRICING_PER_MTOK } from '../../lib/pricing';

describe('usageToDollars', () => {
  it('computes uncached input + output for haiku', () => {
    const d = usageToDollars('claude-haiku-4-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(d).toBeCloseTo(1 + 5, 6);
  });

  it('charges 0.1x for cache reads', () => {
    const d = usageToDollars('claude-haiku-4-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    expect(d).toBeCloseTo(0.1, 6);
  });

  it('charges 1.25x for cache writes (5-min TTL)', () => {
    const d = usageToDollars('claude-haiku-4-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(d).toBeCloseTo(1.25, 6);
  });

  it('falls back to haiku rates for unknown model', () => {
    const d = usageToDollars('nonexistent-model', {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(d).toBeCloseTo(1.00, 6);
  });

  it('exports pricing for all 3 spec models', () => {
    expect(PRICING_PER_MTOK['claude-haiku-4-5']).toBeDefined();
    expect(PRICING_PER_MTOK['claude-sonnet-4-6']).toBeDefined();
    expect(PRICING_PER_MTOK['claude-opus-4-7']).toBeDefined();
  });
});
