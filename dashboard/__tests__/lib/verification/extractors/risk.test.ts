import { describe, it, expect, vi } from 'vitest';
import { extractRiskOutcome } from '@/lib/verification/extractors/risk';

function mkOctokit(comments: Array<{ body: string; html_url: string; created_at?: string }>) {
  return {
    issues: { listComments: vi.fn() },
    paginate: vi.fn(async () => comments),
  } as unknown as Parameters<typeof extractRiskOutcome>[0];
}

// Fixtures mirror the actual `report.md` emitted by lib/cli/risk-audit.ts
// (renderMarkdown). risk-audit is a deterministic CLI — its comment has the
// `🤖 Phase: risk-audit` anchor + `Verdict:` + risk-specific lines, but NO
// Model/Tokens/Cost/Status telemetry block. Earlier fixtures wrongly added
// that block, so these tests passed while the real extractor returned null.
const cleanBody = `🤖 Phase: risk-audit
Verdict: clean
Total Bash calls: 12
Mismatches (agent rated < classifier): 0
Classifier-HIGH calls: 0`;

const mismatchBody = `🤖 Phase: risk-audit
Verdict: mismatches
Total Bash calls: 12
Mismatches (agent rated < classifier): 2
Classifier-HIGH calls: 1`;

const absentBody = `🤖 Phase: risk-audit
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
