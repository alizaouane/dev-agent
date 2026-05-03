import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn(() => ({ messages: { create: mockCreate } })),
  };
});

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

describe('anthropic-client live mode', () => {
  it('calls the SDK with cache_control on the system block', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'live response' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      model: 'claude-haiku-4-5',
    });
    const { invokeAnthropic } = await import('../../lib/anthropic-client');
    const r = await invokeAnthropic({
      mode: 'live',
      model: 'claude-haiku-4-5',
      system: 'sys',
      user: 'u',
    });
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    expect(r.text).toBe('live response');
    expect(r.usage.tokens_in).toBe(100);
    expect(r.usage.tokens_out).toBe(50);
  });

  it('counts cache_read_input_tokens in tokens_in', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'cached' }],
      usage: { input_tokens: 50, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 },
      model: 'claude-haiku-4-5',
    });
    const { invokeAnthropic } = await import('../../lib/anthropic-client');
    const r = await invokeAnthropic({ mode: 'live', model: 'claude-haiku-4-5', system: 's', user: 'u' });
    expect(r.usage.tokens_in).toBe(250);
  });

  it('throws clearly without API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { invokeAnthropic } = await import('../../lib/anthropic-client');
    await expect(invokeAnthropic({ mode: 'live', model: 'claude-haiku-4-5', system: 's', user: 'u' })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('uses (continue) for empty user input', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'k' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
    });
    const { invokeAnthropic } = await import('../../lib/anthropic-client');
    await invokeAnthropic({ mode: 'live', model: 'claude-haiku-4-5', system: 's', user: '' });
    expect(mockCreate.mock.calls[0][0].messages[0].content).toBe('(continue)');
  });

  it('computes non-zero dollars for non-zero token usage', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'priced' }],
      usage: { input_tokens: 1000, output_tokens: 500 },
      model: 'claude-haiku-4-5',
    });
    const { invokeAnthropic } = await import('../../lib/anthropic-client');
    const r = await invokeAnthropic({ mode: 'live', model: 'claude-haiku-4-5', system: 's', user: 'u' });
    expect(r.usage.dollars).toBeGreaterThan(0);
  });
});
