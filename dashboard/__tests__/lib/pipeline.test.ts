import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { fetchPipeline, needsActionFilter, isTerminalState, type FeatureItem } from '@/lib/pipeline';
import type { RepoInfo } from '@/lib/repos';

function makeOctokit(
  issuesByRepo: Record<string, Array<{ number: number; title: string; labels: Array<string | { name: string }>; updated_at: string; html_url: string; comments: number }>>,
  commentsByRepo: Record<string, Record<number, Array<{ body: string; created_at: string }>>> = {},
): Octokit {
  return {
    paginate: vi.fn(async (_fn: unknown, opts: { repo?: string; owner?: string; state?: string }) => {
      const key = `${opts.owner}/${opts.repo}`;
      // Filter by open/closed state per Octokit's listForRepo signature
      const all = issuesByRepo[key] ?? [];
      return all;
    }),
    issues: {
      listForRepo: vi.fn(),
      listComments: vi.fn(({ repo, issue_number }: { repo: string; issue_number: number }) => {
        return Promise.resolve({ data: commentsByRepo[repo]?.[issue_number] ?? [] });
      }),
    },
  } as unknown as Octokit;
}

describe('isTerminalState', () => {
  it('flags terminal states', () => {
    expect(isTerminalState('state:done')).toBe(true);
    expect(isTerminalState('state:abandoned')).toBe(true);
    expect(isTerminalState('state:rolled-back')).toBe(true);
  });
  it('does not flag non-terminal states', () => {
    expect(isTerminalState('state:spec-ready')).toBe(false);
    expect(isTerminalState('state:implementing')).toBe(false);
    expect(isTerminalState('state:blocked')).toBe(false);
  });
});

describe('needsActionFilter', () => {
  const baseFeature: FeatureItem = {
    repo: 'q/r',
    issue_number: 1,
    title: 't',
    state: 'state:spec-ready',
    age_seconds: 0,
    last_telemetry: null,
    blockers: [],
    html_url: '',
  };
  it('returns true for spec-ready, pr-review, ready-to-promote, blocked', () => {
    for (const s of ['state:spec-ready', 'state:pr-review', 'state:ready-to-promote', 'state:blocked'] as const) {
      expect(needsActionFilter({ ...baseFeature, state: s })).toBe(true);
    }
  });
  it('returns false for implementing, staging-deployed, promoting (in-flight, no human action needed)', () => {
    for (const s of ['state:implementing', 'state:staging-deployed', 'state:promoting'] as const) {
      expect(needsActionFilter({ ...baseFeature, state: s })).toBe(false);
    }
  });
  it('returns false for terminal states', () => {
    for (const s of ['state:done', 'state:abandoned', 'state:rolled-back'] as const) {
      expect(needsActionFilter({ ...baseFeature, state: s })).toBe(false);
    }
  });
});

describe('fetchPipeline', () => {
  it('returns FeatureItems across the given repos', async () => {
    const repos: RepoInfo[] = [
      { owner: 'q', name: 'r1', default_branch: 'main' },
      { owner: 'q', name: 'r2', default_branch: 'main' },
    ];
    const octokit = makeOctokit({
      'q/r1': [
        {
          number: 5,
          title: 'feat A',
          labels: [{ name: 'state:spec-ready' }, { name: 'kind:user-intent' }],
          updated_at: new Date().toISOString(),
          html_url: 'https://gh/q/r1/issues/5',
          comments: 1,
        },
      ],
      'q/r2': [
        {
          number: 7,
          title: 'feat B',
          labels: [{ name: 'state:done' }],
          updated_at: new Date().toISOString(),
          html_url: 'https://gh/q/r2/issues/7',
          comments: 2,
        },
      ],
    });
    const items = await fetchPipeline(octokit, repos, { include_terminal: false });
    expect(items).toHaveLength(1); // r2 issue is terminal, filtered out
    expect(items[0].repo).toBe('q/r1');
    expect(items[0].state).toBe('state:spec-ready');
  });

  it('include_terminal: true returns terminal issues too', async () => {
    const repos: RepoInfo[] = [{ owner: 'q', name: 'r1', default_branch: 'main' }];
    const octokit = makeOctokit({
      'q/r1': [
        {
          number: 1,
          title: 'shipped',
          labels: [{ name: 'state:done' }],
          updated_at: new Date().toISOString(),
          html_url: 'https://gh/q/r1/issues/1',
          comments: 0,
        },
      ],
    });
    const items = await fetchPipeline(octokit, repos, { include_terminal: true });
    expect(items).toHaveLength(1);
  });
});
