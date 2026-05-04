import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { scoutUntriagedIssues } from '@/lib/scout/triage';

type IssueFixture = {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  labels: Array<string | { name?: string }>;
  pull_request?: unknown;
  user?: { login?: string } | null;
  created_at: string;
};

function mockOctokit(issues: IssueFixture[], opts: { fail?: boolean } = {}): Octokit {
  const listForRepo = vi.fn(async () => ({ data: issues }));
  const paginate = vi.fn(
    async (
      _fn: (args: Record<string, unknown>) => Promise<{ data: IssueFixture[] }>,
      _args: Record<string, unknown>,
    ) => {
      if (opts.fail) {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      return issues;
    },
  );
  return { issues: { listForRepo }, paginate } as unknown as Octokit;
}

const baseIssue = (n: number, overrides: Partial<IssueFixture> = {}): IssueFixture => ({
  number: n,
  title: `Issue ${n}`,
  html_url: `https://github.com/q/r/issues/${n}`,
  body: 'Body text',
  labels: [],
  user: { login: 'someone' },
  created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
  ...overrides,
});

describe('scoutUntriagedIssues', () => {
  it('returns issues with no state:* label as untriaged proposals', async () => {
    const octokit = mockOctokit([baseIssue(1), baseIssue(2)]);
    const proposals = await scoutUntriagedIssues(octokit, 'q', 'r');
    expect(proposals).toHaveLength(2);
    expect(proposals[0].source).toBe('untriaged_issue');
    expect(proposals[0].group).toBe('new_idea');
    expect(proposals[0].id).toBe('untriaged_issue:q/r:1');
  });

  it('skips issues that already have any state:* label', async () => {
    const octokit = mockOctokit([
      baseIssue(1, { labels: [{ name: 'state:implementing' }] }),
      baseIssue(2, { labels: ['state:done'] }),
      baseIssue(3),
    ]);
    const proposals = await scoutUntriagedIssues(octokit, 'q', 'r');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].meta?.issue_number).toBe(3);
  });

  it('skips issues marked kind:user-intent (created via dashboard)', async () => {
    const octokit = mockOctokit([
      baseIssue(1, { labels: [{ name: 'kind:user-intent' }] }),
      baseIssue(2),
    ]);
    const proposals = await scoutUntriagedIssues(octokit, 'q', 'r');
    expect(proposals.map((p) => p.meta?.issue_number)).toEqual([2]);
  });

  it('skips PRs that come back from issues.list', async () => {
    const octokit = mockOctokit([
      baseIssue(1, { pull_request: { url: '...' } }),
      baseIssue(2),
    ]);
    const proposals = await scoutUntriagedIssues(octokit, 'q', 'r');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].meta?.issue_number).toBe(2);
  });

  it('truncates long bodies in description preview', async () => {
    const octokit = mockOctokit([
      baseIssue(1, { body: 'x'.repeat(500) }),
    ]);
    const proposals = await scoutUntriagedIssues(octokit, 'q', 'r');
    expect(proposals[0].description.length).toBeLessThan(260);
    expect(proposals[0].description).toContain('…');
  });

  it('handles missing body gracefully', async () => {
    const octokit = mockOctokit([baseIssue(1, { body: null })]);
    const proposals = await scoutUntriagedIssues(octokit, 'q', 'r');
    expect(proposals[0].description).toContain('(no body)');
  });

  it('returns empty array when listing fails (not throw)', async () => {
    const octokit = mockOctokit([], { fail: true });
    const proposals = await scoutUntriagedIssues(octokit, 'q', 'r');
    expect(proposals).toEqual([]);
  });
});
