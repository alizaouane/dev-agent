import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { scoutCleanupFindings } from '@/lib/scout/cleanup-findings';

type IssueFixture = {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  labels: Array<string | { name?: string }>;
  pull_request?: unknown;
  created_at: string;
};

function makeIssue(over: Partial<IssueFixture> = {}): IssueFixture {
  return {
    number: 1,
    title: 'Sample finding',
    body: 'Body text',
    html_url: 'https://github.com/q/r/issues/1',
    labels: [{ name: 'kind:cleanup' }, { name: 'state:proposed' }],
    created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

function mockOctokit(opts: { issues?: IssueFixture[]; fail?: boolean }): Octokit {
  const listForRepo = vi.fn(async () => ({ data: opts.issues ?? [] }));
  const paginate = vi.fn(async () => {
    if (opts.fail) throw Object.assign(new Error('rate'), { status: 429 });
    return opts.issues ?? [];
  });
  return { issues: { listForRepo }, paginate } as unknown as Octokit;
}

describe('scoutCleanupFindings', () => {
  it('returns proposals for kind:cleanup + state:proposed issues', async () => {
    const octokit = mockOctokit({
      issues: [
        makeIssue({
          number: 7,
          title: '[cleanup/dead_code] unused export getFoo',
          labels: [
            { name: 'kind:cleanup' },
            { name: 'state:proposed' },
            { name: 'cleanup-category:dead_code' },
          ],
        }),
      ],
    });
    const proposals = await scoutCleanupFindings(octokit, 'q', 'r');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe('cleanup_finding');
    expect(proposals[0].group).toBe('carry_over');
    expect(proposals[0].id).toBe('cleanup_finding:q/r:7');
    expect(proposals[0].meta?.category).toBe('dead_code');
  });

  it('skips PRs surfaced by issues.list', async () => {
    const octokit = mockOctokit({
      issues: [
        makeIssue({ number: 1, pull_request: { url: 'x' } }),
        makeIssue({ number: 2 }),
      ],
    });
    const proposals = await scoutCleanupFindings(octokit, 'q', 'r');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].meta?.issue_number).toBe(2);
  });

  it('sorts oldest first (longest-ignored floats up)', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const octokit = mockOctokit({
      issues: [
        makeIssue({ number: 1, created_at: recent }),
        makeIssue({ number: 2, created_at: old }),
        makeIssue({ number: 3, created_at: recent }),
      ],
    });
    const proposals = await scoutCleanupFindings(octokit, 'q', 'r');
    expect(proposals[0].meta?.issue_number).toBe(2);
  });

  it("defaults category to 'unknown' when label is missing", async () => {
    const octokit = mockOctokit({
      issues: [
        makeIssue({
          number: 1,
          labels: [{ name: 'kind:cleanup' }, { name: 'state:proposed' }],
        }),
      ],
    });
    const proposals = await scoutCleanupFindings(octokit, 'q', 'r');
    expect(proposals[0].meta?.category).toBe('unknown');
  });

  it('returns empty when listing fails', async () => {
    const octokit = mockOctokit({ fail: true });
    expect(await scoutCleanupFindings(octokit, 'q', 'r')).toEqual([]);
  });

  it('truncates long bodies in description preview', async () => {
    const octokit = mockOctokit({
      issues: [makeIssue({ number: 1, body: 'x'.repeat(500) })],
    });
    const proposals = await scoutCleanupFindings(octokit, 'q', 'r');
    expect(proposals[0].description.length).toBeLessThan(260);
    expect(proposals[0].description).toContain('…');
  });
});
