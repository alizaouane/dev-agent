import { describe, it, expect, vi } from 'vitest';
import { extractAuditOutcome } from '@/lib/verification/extractors/audit';

function mkOctokit(comments: Array<{ body: string; html_url: string; created_at?: string }>) {
  return {
    issues: { listComments: vi.fn() },
    paginate: vi.fn(async () => comments),
  } as unknown as Parameters<typeof extractAuditOutcome>[0];
}

const cleanBody = `🤖 Phase: apply-audit
Model: claude-sonnet-4-6
Tokens: 1.2k in / 0.4k out
Cost: $0.04
Mode: live
Status: clean
Verdict: clean
Files checked: 5 (TS / JS in diff vs \`origin/main\`)`;

const errorsBody = `🤖 Phase: apply-audit
Model: claude-sonnet-4-6
Tokens: 1.2k in / 0.4k out
Cost: $0.04
Mode: live
Status: failed
Verdict: syntax-errors (2 of 5 files)
Base ref: \`origin/main\`

Files with TypeScript parser errors:

- \`src/foo.ts\` — Unexpected token`;

const noFilesBody = `🤖 Phase: apply-audit
Model: claude-sonnet-4-6
Tokens: 0.1k in / 0.05k out
Cost: $0.001
Mode: live
Status: ok
Verdict: no-files

No TypeScript / JavaScript files changed in the diff vs \`origin/main\`.`;

describe('extractAuditOutcome (Pillar 4)', () => {
  it('returns null when no apply-audit comment exists', async () => {
    const oct = mkOctokit([{ body: 'unrelated comment', html_url: 'x' }]);
    expect(await extractAuditOutcome(oct, 'a/b', 142)).toBeNull();
  });

  it('returns passed when verdict is clean and forwards cost_usd from telemetry', async () => {
    const oct = mkOctokit([{ body: cleanBody, html_url: 'https://example/c1', created_at: '2026-05-09T10:00:00Z' }]);
    const out = await extractAuditOutcome(oct, 'a/b', 142);
    expect(out).toMatchObject({
      pillar: 'audit_p4',
      status: 'passed',
      details_url: 'https://example/c1',
      ran_at: '2026-05-09T10:00:00Z',
      cost_usd: 0.04,
    });
  });

  it('returns advisory when verdict is syntax-errors (advisory in v1)', async () => {
    const oct = mkOctokit([{ body: errorsBody, html_url: 'https://example/c2' }]);
    const out = await extractAuditOutcome(oct, 'a/b', 142);
    expect(out?.status).toBe('advisory');
    expect(out?.summary).toMatch(/2/);
  });

  it('returns not_run when verdict is no-files', async () => {
    const oct = mkOctokit([{ body: noFilesBody, html_url: 'https://example/c3' }]);
    const out = await extractAuditOutcome(oct, 'a/b', 142);
    expect(out?.status).toBe('not_run');
  });

  it('walks newest-first and uses the latest apply-audit comment', async () => {
    const oct = mkOctokit([
      { body: errorsBody, html_url: 'https://example/old' },
      { body: cleanBody, html_url: 'https://example/new' },
    ]);
    const out = await extractAuditOutcome(oct, 'a/b', 142);
    expect(out?.status).toBe('passed');
    expect(out?.details_url).toBe('https://example/new');
  });
});
