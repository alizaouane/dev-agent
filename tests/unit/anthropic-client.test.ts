import { describe, it, expect, afterEach } from 'vitest';
import { invokeAnthropic } from '../../lib/anthropic-client';

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_MODE = process.env.INVOCATION_MODE;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_MODE === undefined) delete process.env.INVOCATION_MODE;
  else process.env.INVOCATION_MODE = ORIGINAL_MODE;
});

describe('anthropic-client', () => {
  it('stub mode returns deterministic canned response', async () => {
    const resp = await invokeAnthropic({
      mode: 'stub',
      model: 'claude-haiku-4-5',
      system: 'sys',
      user: 'hi',
    });
    expect(resp.text).toContain('STUB');
    expect(resp.usage.tokens_in).toBeGreaterThan(0);
    expect(resp.usage.tokens_out).toBeGreaterThan(0);
    expect(resp.usage.dollars).toBeGreaterThanOrEqual(0);
  });

  it('stub mode is deterministic for the same inputs', async () => {
    const a = await invokeAnthropic({ mode: 'stub', model: 'claude-haiku-4-5', system: 's', user: 'u' });
    const b = await invokeAnthropic({ mode: 'stub', model: 'claude-haiku-4-5', system: 's', user: 'u' });
    expect(a.text).toBe(b.text);
    expect(a.usage).toEqual(b.usage);
  });

  it('live mode without API key throws a clear error', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      invokeAnthropic({ mode: 'live', model: 'claude-haiku-4-5', system: 's', user: 'u' }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/i);
  });

  it('reads INVOCATION_MODE env when mode is "auto"', async () => {
    process.env.INVOCATION_MODE = 'stub';
    const resp = await invokeAnthropic({ mode: 'auto', model: 'claude-haiku-4-5', system: 's', user: 'u' });
    expect(resp.text).toContain('STUB');
  });
});
