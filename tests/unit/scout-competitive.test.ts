import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sampleFeed = readFileSync(resolve(__dirname, '../fixtures/competitive/sample-feed.xml'), 'utf8');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

describe('competitiveAdapter', () => {
  it('returns empty for empty feed list', async () => {
    const { competitiveAdapter } = await import('../../lib/scout/competitive');
    expect(await competitiveAdapter({ kind: 'competitive', feeds: [] })).toEqual([]);
  });

  it('parses RSS items into candidates', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => sampleFeed,
    });
    const { competitiveAdapter } = await import('../../lib/scout/competitive');
    const candidates = await competitiveAdapter({ kind: 'competitive', feeds: ['https://acme.example.com/feed'] });
    expect(candidates).toHaveLength(2);
    expect(candidates[0].title).toContain('AI Agent v2');
    expect(candidates[0].evidence_url).toBe('https://acme.example.com/posts/agent-v2');
  });

  it('skips a feed on HTTP error but continues others', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, text: async () => sampleFeed });
    const { competitiveAdapter } = await import('../../lib/scout/competitive');
    const candidates = await competitiveAdapter({ kind: 'competitive', feeds: ['bad', 'good'] });
    expect(candidates.length).toBeGreaterThan(0);
  });
});
