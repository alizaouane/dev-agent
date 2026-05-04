import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { scoutBugFindings } from '@/lib/scout/bug-findings';

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
    labels: [{ name: 'kind:bug-scout' }, { name: 'state:proposed' }],
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

describe('scoutBugFindings', () => {
  it('returns proposals for kind:bug-scout + state:proposed issues', async () => {
    const octokit = mockOctokit({
      issues: [
        makeIssue({
          number: 5,
          title: '[bug-scout/high] SQL injection in /api/users',
          labels: [
            { name: 'kind:bug-scout' },
            { name: 'state:proposed' },
            { name: 'severity:high' },
            { name: 'bug-category:security' },
          ],
        }),
      ],
    });
    const proposals = await scoutBugFindings(octokit, 'q', 'r');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe('bug_scout_finding');
    expect(proposals[0].group).toBe('carry_over');
    expect(proposals[0].meta?.severity).toBe('high');
    expect(proposals[0].meta?.category).toBe('security');
  });

  it('skips PRs surfaced by issues.list', async () => {
    const octokit = mockOctokit({
      issues: [
        makeIssue({ number: 1, pull_request: { url: 'x' } }),
        makeIssue({ number: 2 }),
      ],
    });
    const proposals = await scoutBugFindings(octokit, 'q', 'r');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].meta?.issue_number).toBe(2);
  });

  it('sorts by severity (high first), then by age (oldest first within tier)', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const octokit = mockOctokit({
      issues: [
        // Recent low — should be last
        makeIssue({
          number: 1,
          created_at: recent,
          labels: [
            { name: 'kind:bug-scout' },
            { name: 'state:proposed' },
            { name: 'severity:low' },
          ],
        }),
        // Recent high — should be first
        makeIssue({
          number: 2,
          created_at: recent,
          labels: [
            { name: 'kind:bug-scout' },
            { name: 'state:proposed' },
            { name: 'severity:high' },
          ],
        }),
        // Old high — should be second (high tier, older than #2)
        makeIssue({
          number: 3,
          created_at: old,
          labels: [
            { name: 'kind:bug-scout' },
            { name: 'state:proposed' },
            { name: 'severity:high' },
          ],
        }),
      ],
    });
    const proposals = await scoutBugFindings(octokit, 'q', 'r');
    // Both highs come before low; oldest high comes first within tier.
    expect(proposals.map((p) => p.meta?.issue_number)).toEqual([3, 2, 1]);
  });

  it('defaults severity/category when labels are missing', async () => {
    const octokit = mockOctokit({
      issues: [
        makeIssue({
          number: 1,
          labels: [{ name: 'kind:bug-scout' }, { name: 'state:proposed' }],
        }),
      ],
    });
    const proposals = await scoutBugFindings(octokit, 'q', 'r');
    expect(proposals[0].meta?.severity).toBe('medium');
    expect(proposals[0].meta?.category).toBe('unknown');
  });

  it('returns empty when listing fails', async () => {
    const octokit = mockOctokit({ fail: true });
    expect(await scoutBugFindings(octokit, 'q', 'r')).toEqual([]);
  });

  it('truncates long bodies in description preview', async () => {
    const octokit = mockOctokit({
      issues: [makeIssue({ number: 1, body: 'x'.repeat(500) })],
    });
    const proposals = await scoutBugFindings(octokit, 'q', 'r');
    expect(proposals[0].description.length).toBeLessThan(260);
    expect(proposals[0].description).toContain('…');
  });
});
