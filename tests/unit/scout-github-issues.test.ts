import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => ({
    paginate: vi.fn().mockResolvedValue([
      { number: 1, title: 'login fails on Safari', body: 'Steps...', html_url: 'https://gh/1', labels: [{ name: 'bug' }] },
      { number: 2, title: 'add dark mode', body: 'Want...', html_url: 'https://gh/2', labels: [{ name: 'triage' }] },
      { number: 3, title: 'bump deps', body: 'routine', html_url: 'https://gh/3', labels: [{ name: 'chore' }] },
    ]),
  })),
}));

beforeEach(() => {
  process.env.GH_TOKEN = 'fake';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
});

describe('githubIssuesAdapter', () => {
  it('returns candidates for triage/bug-labeled issues', async () => {
    const { githubIssuesAdapter } = await import('../../lib/scout/github-issues');
    const candidates = await githubIssuesAdapter();
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.title)).toEqual([
      'login fails on Safari',
      'add dark mode',
    ]);
    expect(candidates[0].source).toBe('github_issues');
    expect(candidates[0].evidence_url).toBe('https://gh/1');
  });
});
