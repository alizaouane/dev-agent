import { describe, it, expect, vi } from 'vitest';
import { extractRiskOutcome } from '@/lib/verification/extractors/risk';

function mkOctokit(comments: Array<{ body: string; html_url: string; created_at?: string }>) {
  return {
    issues: { listComments: vi.fn() },
    paginate: vi.fn(async () => comments),
  } as unknown as Parameters<typeof extractRiskOutcome>[0];
}

const cleanBody = `🤖 Phase: risk-audit
Model: claude-haiku-4-5
Tokens: 0.5k in / 0.1k out
Cost: $0.005
Mode: live
Status: clean
Verdict: clean
Total Bash calls: 12
Mismatches (agent rated < classifier): 0
Classifier-HIGH calls: 0`;

const mismatchBody = `🤖 Phase: risk-audit
Model: claude-haiku-4-5
Tokens: 0.5k in / 0.1k out
Cost: $0.005
Mode: live
Status: mismatches
Verdict: mismatches
Total Bash calls: 12
Mismatches (agent rated < classifier): 2
Classifier-HIGH calls: 1`;

const absentBody = `🤖 Phase: risk-audit
Model: claude-haiku-4-5
Tokens: 0.1k in / 0.05k out
Cost: $0.001
Mode: live
Status: absent
Verdict: absent

No \`.dev-agent/bash-log.jsonl\` was authored by the implement-agent during this run.`;

describe('extractRiskOutcome (Pillar 5)', () => {
  it('returns null with no risk-audit comment', async () => {
    const oct = mkOctokit([{ body: 'noise', html_url: 'x' }]);
    expect(await extractRiskOutcome(oct, 'a/b', 1)).toBeNull();
  });

  it('returns passed when verdict is clean', async () => {
    const oct = mkOctokit([{ body: cleanBody, html_url: 'https://example/c' }]);
    const out = await extractRiskOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('passed');
    expect(out?.pillar).toBe('risk_p5');
  });

  it('returns advisory when verdict is mismatches and reports the count', async () => {
    const oct = mkOctokit([{ body: mismatchBody, html_url: 'https://example/c' }]);
    const out = await extractRiskOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('advisory');
    expect(out?.summary).toMatch(/2/);
  });

  it('returns not_run when verdict is absent', async () => {
    const oct = mkOctokit([{ body: absentBody, html_url: 'https://example/c' }]);
    const out = await extractRiskOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('not_run');
  });
});
