import { describe, it, expect, vi } from 'vitest';
import { extractSmokeOutcome } from '@/lib/verification/extractors/smoke';

function mkOctokit(comments: Array<{ body: string; html_url: string; created_at?: string }>) {
  return {
    issues: { listComments: vi.fn() },
    paginate: vi.fn(async () => comments),
  } as unknown as Parameters<typeof extractSmokeOutcome>[0];
}

const passBody = `🤖 Phase: tier2-smoke
Model: claude-sonnet-4-6
Tokens: 0.8k in / 0.3k out
Cost: $0.02
Mode: live
Status: pass
Verdict: pass

UI assertions all green.`;

const failBody = `🤖 Phase: tier2-smoke
Model: claude-sonnet-4-6
Tokens: 0.8k in / 0.3k out
Cost: $0.02
Mode: live
Status: fail
Verdict: fail

Tier-2 smoke detected a UI failure.`;

const ambiguousBody = `🤖 Phase: tier2-smoke
Model: claude-sonnet-4-6
Tokens: 0.1k in / 0.05k out
Cost: $0.002
Mode: live
Status: ambiguous
Verdict: ambiguous

No probe authored — spec had no UI-mapped criteria.`;

describe('extractSmokeOutcome (Pillar 7)', () => {
  it('returns null without a tier2-smoke comment', async () => {
    const oct = mkOctokit([{ body: 'x', html_url: 'y' }]);
    expect(await extractSmokeOutcome(oct, 'a/b', 1)).toBeNull();
  });

  it('returns passed when verdict is pass', async () => {
    const oct = mkOctokit([{ body: passBody, html_url: 'https://example/c' }]);
    const out = await extractSmokeOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('passed');
  });

  it('returns failed when verdict is fail', async () => {
    const oct = mkOctokit([{ body: failBody, html_url: 'https://example/c' }]);
    const out = await extractSmokeOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('failed');
  });

  it('returns advisory when verdict is ambiguous', async () => {
    const oct = mkOctokit([{ body: ambiguousBody, html_url: 'https://example/c' }]);
    const out = await extractSmokeOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('advisory');
  });
});
