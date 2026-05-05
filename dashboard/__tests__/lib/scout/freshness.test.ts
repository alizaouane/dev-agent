import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { enrichProposalsWithFreshness } from '@/lib/scout/freshness';
import type { Proposal } from '@/lib/scout/types';

function pendingSpec(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'pending_spec:q/r:auth-flow',
    source: 'pending_spec',
    group: 'carry_over',
    repo: 'q/r',
    title: 'Auth flow',
    description: '...',
    url: 'https://github.com/q/r/blob/main/docs/specs/auth-flow.md',
    meta: { spec_slug: 'auth-flow', spec_path: 'docs/specs/auth-flow.md' },
    ...over,
  };
}

function unfinishedPlanLine(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'unfinished_plan:q/r:plan#L12',
    source: 'unfinished_plan',
    group: 'carry_over',
    repo: 'q/r',
    title: 'do the thing',
    description: '...',
    url: 'https://github.com/q/r/blob/main/docs/plans/plan.md#L12',
    meta: { plan_file: 'docs/plans/plan.md', line: 12 },
    ...over,
  };
}

function bugFinding(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'bug_scout_finding:q/r:42',
    source: 'bug_scout_finding',
    group: 'carry_over',
    repo: 'q/r',
    title: '[bug-scout/high] XSS in /api/users',
    description: '...',
    url: 'https://github.com/q/r/issues/42',
    meta: { issue_number: 42, severity: 'high', category: 'security', age_days: 5 },
    ...over,
  };
}

function untriagedIssue(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'untriaged_issue:q/r:99',
    source: 'untriaged_issue',
    group: 'new_idea',
    repo: 'q/r',
    title: 'flaky checkout',
    description: '...',
    url: 'https://github.com/q/r/issues/99',
    meta: { issue_number: 99, age_days: 3, author: 'someone' },
    ...over,
  };
}

type MockArgs = {
  searchPRs?: { total_count: number; items?: Array<{ number: number }> };
  commits?: Array<{ commit?: { committer?: { date?: string } } }>;
  issueGet?: { body?: string; created_at?: string };
  pullsGet?: Record<number, { merged: boolean }>;
  searchThrows?: boolean;
};

function mockOctokit(args: MockArgs): Octokit {
  const search = {
    issuesAndPullRequests: vi.fn(async () => {
      if (args.searchThrows) throw new Error('rate-limited');
      return { data: args.searchPRs ?? { total_count: 0 } };
    }),
  };
  const repos = {
    listCommits: vi.fn(async () => ({ data: args.commits ?? [] })),
  };
  const issues = {
    get: vi.fn(async () => ({
      data: { body: args.issueGet?.body ?? '', created_at: args.issueGet?.created_at ?? '' },
    })),
  };
  const pulls = {
    get: vi.fn(async ({ pull_number }: { pull_number: number }) => {
      const entry = args.pullsGet?.[pull_number];
      if (!entry) {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }
      return { data: entry };
    }),
  };
  return { search, repos, issues, pulls } as unknown as Octokit;
}

describe('enrichProposalsWithFreshness', () => {
  describe('pending_spec', () => {
    it('flags a pending spec when a merged PR mentions the slug', async () => {
      const octokit = mockOctokit({ searchPRs: { total_count: 1, items: [{ number: 7 }] } });
      const m = await enrichProposalsWithFreshness(octokit, [pendingSpec()]);
      expect(m.get('pending_spec:q/r:auth-flow')?.reason).toMatch(/merged PR #7 mentions this spec/);
    });

    it('does not flag when no merged PR mentions the slug', async () => {
      const octokit = mockOctokit({ searchPRs: { total_count: 0 } });
      const m = await enrichProposalsWithFreshness(octokit, [pendingSpec()]);
      expect(m.has('pending_spec:q/r:auth-flow')).toBe(false);
    });

    it('degrades silently when search rate-limits', async () => {
      const octokit = mockOctokit({ searchThrows: true });
      const m = await enrichProposalsWithFreshness(octokit, [pendingSpec()]);
      expect(m.has('pending_spec:q/r:auth-flow')).toBe(false);
    });
  });

  describe('unfinished_plan (per-line)', () => {
    it('flags when the plan file has commits in the last 14d', async () => {
      const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const octokit = mockOctokit({
        commits: [{ commit: { committer: { date: recent } } }],
      });
      const m = await enrichProposalsWithFreshness(octokit, [unfinishedPlanLine()]);
      const hint = m.get('unfinished_plan:q/r:plan#L12');
      expect(hint?.reason).toMatch(/docs\/plans\/plan\.md modified/);
      expect(hint?.reason).toMatch(/checkbox may already be ticked/);
    });

    it('does not flag rolled-up entries (no #L<n>)', async () => {
      const octokit = mockOctokit({
        commits: [{ commit: { committer: { date: new Date().toISOString() } } }],
      });
      const proposal = unfinishedPlanLine({
        id: 'unfinished_plan:q/r:plan',
        meta: { plan_file: 'docs/plans/plan.md', item_count: 60, rolled_up: 'true' },
      });
      const m = await enrichProposalsWithFreshness(octokit, [proposal]);
      expect(m.has('unfinished_plan:q/r:plan')).toBe(false);
    });

    it('does not flag when no recent commits', async () => {
      const octokit = mockOctokit({ commits: [] });
      const m = await enrichProposalsWithFreshness(octokit, [unfinishedPlanLine()]);
      expect(m.has('unfinished_plan:q/r:plan#L12')).toBe(false);
    });
  });

  describe('issue-backed file findings (bug_scout / unfinished_work / cleanup)', () => {
    it('flags when the located file has commits since the issue was filed', async () => {
      const filed = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const fixed = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const octokit = mockOctokit({
        issueGet: {
          body: '**Bug-scout finding**\n\n- Severity: `high`\n- Location: `app/api/users.ts:42`\n\n## Description\n\nXSS sink.',
          created_at: filed,
        },
        commits: [{ commit: { committer: { date: fixed } } }],
      });
      const m = await enrichProposalsWithFreshness(octokit, [bugFinding()]);
      const hint = m.get('bug_scout_finding:q/r:42');
      expect(hint?.reason).toMatch(/app\/api\/users\.ts modified .*after issue filed/);
    });

    it('strips :<line> suffix from Location before checking commits', async () => {
      const filed = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const listCommits = vi.fn(async (_args: { path?: string }) => ({
        data: [{ commit: { committer: { date: new Date().toISOString() } } }],
      }));
      const octokit = {
        issues: {
          get: vi.fn(async () => ({
            data: {
              body: '- Location: `lib/auth.ts:128`',
              created_at: filed,
            },
          })),
        },
        repos: { listCommits },
      } as unknown as Octokit;
      await enrichProposalsWithFreshness(octokit, [bugFinding()]);
      expect(listCommits.mock.calls[0][0]?.path).toBe('lib/auth.ts');
    });

    it("does not flag when issue body has no Location: line", async () => {
      const octokit = mockOctokit({
        issueGet: {
          body: 'no location backtick block here',
          created_at: new Date().toISOString(),
        },
        commits: [{ commit: { committer: { date: new Date().toISOString() } } }],
      });
      const m = await enrichProposalsWithFreshness(octokit, [bugFinding()]);
      expect(m.has('bug_scout_finding:q/r:42')).toBe(false);
    });

    it('does not flag when no commits since the issue was filed', async () => {
      const octokit = mockOctokit({
        issueGet: {
          body: '- Location: `app/api/users.ts`',
          created_at: new Date().toISOString(),
        },
        commits: [],
      });
      const m = await enrichProposalsWithFreshness(octokit, [bugFinding()]);
      expect(m.has('bug_scout_finding:q/r:42')).toBe(false);
    });
  });

  describe('untriaged_issue', () => {
    it('flags when body references a merged PR', async () => {
      const octokit = mockOctokit({
        issueGet: { body: 'maybe fixed by #7? or possibly #8.', created_at: '' },
        pullsGet: { 7: { merged: false }, 8: { merged: true } },
      });
      const m = await enrichProposalsWithFreshness(octokit, [untriagedIssue()]);
      expect(m.get('untriaged_issue:q/r:99')?.reason).toMatch(/addressed by merged PR #8/);
    });

    it("ignores the issue's own number", async () => {
      const octokit = mockOctokit({
        issueGet: { body: 'see #99', created_at: '' },
        pullsGet: { 99: { merged: true } },
      });
      const m = await enrichProposalsWithFreshness(octokit, [untriagedIssue()]);
      expect(m.has('untriaged_issue:q/r:99')).toBe(false);
    });

    it('does not flag when no referenced PR is merged', async () => {
      const octokit = mockOctokit({
        issueGet: { body: 'see #5 and #6', created_at: '' },
        pullsGet: { 5: { merged: false }, 6: { merged: false } },
      });
      const m = await enrichProposalsWithFreshness(octokit, [untriagedIssue()]);
      expect(m.has('untriaged_issue:q/r:99')).toBe(false);
    });

    it('skips refs that 404 (not actually PRs)', async () => {
      const octokit = mockOctokit({
        issueGet: { body: 'see #5 (issue, not a PR) and #6 (PR)', created_at: '' },
        pullsGet: { 6: { merged: true } },
      });
      const m = await enrichProposalsWithFreshness(octokit, [untriagedIssue()]);
      expect(m.get('untriaged_issue:q/r:99')?.reason).toMatch(/PR #6/);
    });
  });

  describe('parallel + isolation', () => {
    it('runs per-proposal heuristics in parallel without one failure breaking others', async () => {
      // First proposal triggers a search (which throws). Second proposal
      // is bug-scout — should still get hinted from issues.get + commits.
      const filed = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const octokit = {
        search: { issuesAndPullRequests: vi.fn(async () => { throw new Error('boom'); }) },
        issues: {
          get: vi.fn(async () => ({
            data: { body: '- Location: `lib/x.ts`', created_at: filed },
          })),
        },
        repos: {
          listCommits: vi.fn(async () => ({
            data: [{ commit: { committer: { date: new Date().toISOString() } } }],
          })),
        },
      } as unknown as Octokit;
      const m = await enrichProposalsWithFreshness(octokit, [pendingSpec(), bugFinding()]);
      expect(m.has('pending_spec:q/r:auth-flow')).toBe(false);
      expect(m.has('bug_scout_finding:q/r:42')).toBe(true);
    });

    it('returns an empty map for sources with no v1 freshness signal', async () => {
      const octokit = mockOctokit({});
      const competitorWatchProposal: Proposal = {
        id: 'competitor_watch:q/r:rival',
        source: 'competitor_watch',
        group: 'new_idea',
        repo: 'q/r',
        title: 'rival',
        description: '...',
        url: 'https://example.com',
      };
      const m = await enrichProposalsWithFreshness(octokit, [competitorWatchProposal]);
      expect(m.size).toBe(0);
    });
  });
});
