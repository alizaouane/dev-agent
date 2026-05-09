import { describe, it, expect, vi } from 'vitest';
import { extractGateBOutcome } from '@/lib/verification/extractors/gate-b';

function mkOctokit(comments: Array<{ body: string; html_url: string; created_at?: string }>) {
  return {
    issues: { listComments: vi.fn() },
    paginate: vi.fn(async () => comments),
  } as unknown as Parameters<typeof extractGateBOutcome>[0];
}

const passBody = `## ✅ swarm-review: pass

_All three reviewers approved._

### spec-compliance — \`pass\`

(Reviewer notes…)

### regression-guard — \`pass\`

### security-scout — \`pass\``;

const concernBody = `## ⚠️ swarm-review: concern

_Two reviewers concerned, one passed._`;

const failBody = `## 🛑 swarm-review: fail

_Two reviewers failed._`;

const outageBody = `🤖 Phase: swarm-review
Model: claude-haiku-4-5
Tokens: 0 in / 0 out
Cost: $0.000
Mode: live
Status: outage
Verdict: outage

All three reviewer agents produced no output.`;

describe('extractGateBOutcome', () => {
  it('returns null with no swarm-review comment of either shape', async () => {
    const oct = mkOctokit([{ body: 'unrelated', html_url: 'x' }]);
    expect(await extractGateBOutcome(oct, 'a/b', 1)).toBeNull();
  });

  it('returns passed when rich comment shows pass', async () => {
    const oct = mkOctokit([{ body: passBody, html_url: 'https://example/c' }]);
    const out = await extractGateBOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('passed');
    expect(out?.pillar).toBe('gate_b');
  });

  it('returns advisory when rich comment shows concern', async () => {
    const oct = mkOctokit([{ body: concernBody, html_url: 'https://example/c' }]);
    const out = await extractGateBOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('advisory');
  });

  it('returns failed when rich comment shows fail', async () => {
    const oct = mkOctokit([{ body: failBody, html_url: 'https://example/c' }]);
    const out = await extractGateBOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('failed');
  });

  it('returns failed when telemetry-style comment shows outage', async () => {
    const oct = mkOctokit([{ body: outageBody, html_url: 'https://example/c' }]);
    const out = await extractGateBOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('failed');
    expect(out?.summary).toMatch(/outage/i);
  });

  it('prefers a newer rich-format comment over an older telemetry one', async () => {
    const oct = mkOctokit([
      { body: outageBody, html_url: 'https://example/old' },
      { body: passBody, html_url: 'https://example/new' },
    ]);
    const out = await extractGateBOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('passed');
    expect(out?.details_url).toBe('https://example/new');
  });
});
