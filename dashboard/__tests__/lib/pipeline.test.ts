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
      { owner: 'q', name: 'r1', default_branch: 'main', wired_up: true, html_url: 'https://github.com/q/r1', description: null },
      { owner: 'q', name: 'r2', default_branch: 'main', wired_up: true, html_url: 'https://github.com/q/r2', description: null },
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
    const repos: RepoInfo[] = [{ owner: 'q', name: 'r1', default_branch: 'main', wired_up: true, html_url: 'https://github.com/q/r1', description: null }];
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

  it('queries each open state label individually (REST labels filter is AND, not OR)', async () => {
    // Regression: passing the 8 state labels as one comma-separated
    // string used to filter to issues with ALL labels — impossible —
    // so the live pipeline silently rendered empty. Lock the per-label
    // invocation pattern in: paginate must be called once per state
    // label, and each call's `labels` arg must be a single label
    // (no commas).
    const repos: RepoInfo[] = [
      { owner: 'q', name: 'r1', default_branch: 'main', wired_up: true, html_url: 'https://github.com/q/r1', description: null },
    ];
    const octokit = makeOctokit({ 'q/r1': [] });
    await fetchPipeline(octokit, repos, { include_terminal: false });
    // 11 open-bucket state labels, no terminals (8 original + 3 industry-grade
    // verification gates: acm-building, swarm-reviewing, tier2-smoke).
    const paginate = octokit.paginate as unknown as ReturnType<typeof vi.fn>;
    expect(paginate).toHaveBeenCalledTimes(11);
    const labelArgs = paginate.mock.calls.map(
      (c: unknown[]) => (c[1] as { labels: string }).labels,
    );
    for (const arg of labelArgs) {
      expect(arg).not.toContain(',');
      expect(arg).toMatch(/^state:[a-z0-9-]+$/);
    }
    // Set of distinct labels equals the open-state vocabulary.
    expect(new Set(labelArgs).size).toBe(11);
  });

  it('returns issues even when each one only matches a single state label (real OR semantics)', async () => {
    // Tightest regression for the original bug: simulate the real
    // GitHub API behavior where the `labels` filter is AND. With a
    // label-aware mock, an issue tagged only `state:implementing`
    // returns from the `state:implementing` call but NOT from the
    // `state:scoping` call. Before the fix, the single multi-label
    // query would have returned [] for each of these issues. After,
    // the per-label fan-out picks each one up via its own label.
    const repos: RepoInfo[] = [
      { owner: 'q', name: 'r1', default_branch: 'main', wired_up: true, html_url: 'https://github.com/q/r1', description: null },
    ];
    const issuesInRepo = [
      {
        number: 10,
        title: 'in scoping',
        labels: [{ name: 'state:scoping' }],
        updated_at: new Date().toISOString(),
        html_url: 'https://gh/q/r1/issues/10',
        comments: 0,
      },
      {
        number: 11,
        title: 'building',
        labels: [{ name: 'state:implementing' }],
        updated_at: new Date().toISOString(),
        html_url: 'https://gh/q/r1/issues/11',
        comments: 0,
      },
      {
        number: 12,
        title: 'awaiting review',
        labels: [{ name: 'state:pr-review' }],
        updated_at: new Date().toISOString(),
        html_url: 'https://gh/q/r1/issues/12',
        comments: 0,
      },
    ];
    // Label-aware paginate: only return issues that actually carry
    // the requested label. This mirrors GitHub's real behavior under
    // the AND-semantics filter we have to work around.
    const octokit = {
      paginate: vi.fn(async (_fn: unknown, opts: { labels?: string }) => {
        return issuesInRepo.filter((i) =>
          i.labels.some((l) =>
            typeof l === 'string' ? l === opts.labels : l.name === opts.labels,
          ),
        );
      }),
      issues: {
        listForRepo: vi.fn(),
        listComments: vi.fn(() => Promise.resolve({ data: [] })),
      },
    } as unknown as Octokit;

    const items = await fetchPipeline(octokit, repos, { include_terminal: false });
    const numbers = items.map((i) => i.issue_number).sort();
    expect(numbers).toEqual([10, 11, 12]);
  });

  it('include_terminal: true queries open + closed buckets independently (11 + 3 = 14 calls)', async () => {
    // Regression lock for the closed/terminal branch: same OR-via-fanout
    // pattern, separate label set. If the fix only updated the open
    // path and left the closed path on the multi-label string,
    // include_terminal=true would silently lose terminal issues.
    const repos: RepoInfo[] = [
      { owner: 'q', name: 'r1', default_branch: 'main', wired_up: true, html_url: 'https://github.com/q/r1', description: null },
    ];
    const octokit = makeOctokit({ 'q/r1': [] });
    await fetchPipeline(octokit, repos, { include_terminal: true });
    const paginate = octokit.paginate as unknown as ReturnType<typeof vi.fn>;
    // 11 open + 3 closed (done, abandoned, rolled-back) = 14
    expect(paginate).toHaveBeenCalledTimes(14);
    const labelArgs = paginate.mock.calls.map(
      (c: unknown[]) => (c[1] as { labels: string }).labels,
    );
    for (const arg of labelArgs) {
      expect(arg).not.toContain(',');
      expect(arg).toMatch(/^state:[a-z0-9-]+$/);
    }
    // Distinct labels: 11 open + 3 closed = 14 unique state values.
    expect(new Set(labelArgs).size).toBe(14);
    // Closed-bucket terminals must be in the queried set.
    expect(new Set(labelArgs)).toContain('state:done');
    expect(new Set(labelArgs)).toContain('state:abandoned');
    expect(new Set(labelArgs)).toContain('state:rolled-back');
  });

  it('one failed per-label call does not poison the other state buckets', async () => {
    // Per-label fan-out is robust: a transient 5xx on the
    // `state:scoping` lookup must not blank out the page — issues in
    // `state:implementing` still need to show up. Mirrors the
    // existing one-bad-repo-doesn't-blank-everything contract for
    // multi-repo loops, but at the per-label level inside a repo.
    const repos: RepoInfo[] = [
      { owner: 'q', name: 'r1', default_branch: 'main', wired_up: true, html_url: 'https://github.com/q/r1', description: null },
    ];
    const issue = {
      number: 50,
      title: 'shipping',
      labels: [{ name: 'state:implementing' }],
      updated_at: new Date().toISOString(),
      html_url: 'https://gh/q/r1/issues/50',
      comments: 0,
    };
    const octokit = {
      paginate: vi.fn(async (_fn: unknown, opts: { labels?: string }) => {
        if (opts.labels === 'state:scoping') {
          throw Object.assign(new Error('Internal Server Error'), { status: 500 });
        }
        return opts.labels === 'state:implementing' ? [issue] : [];
      }),
      issues: {
        listForRepo: vi.fn(),
        listComments: vi.fn(() => Promise.resolve({ data: [] })),
      },
    } as unknown as Octokit;
    // Silence the warn so the test output stays clean.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await fetchPipeline(octokit, repos, { include_terminal: false });
    expect(items).toHaveLength(1);
    expect(items[0].issue_number).toBe(50);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('dedupes when the same issue appears under multiple state-label calls', async () => {
    // Per-label calls can return overlapping issues if a server
    // ignores label filters or an issue legitimately carries
    // multiple labels (rare but possible). The merge must dedupe by
    // issue number so the pipeline shows each issue once.
    const repos: RepoInfo[] = [
      { owner: 'q', name: 'r1', default_branch: 'main', wired_up: true, html_url: 'https://github.com/q/r1', description: null },
    ];
    // The mock returns the full bucket regardless of which label was
    // queried — so each of the 8 label calls returns the same issue.
    // Without dedupe, the result would be 8 copies.
    const octokit = makeOctokit({
      'q/r1': [
        {
          number: 99,
          title: 'one',
          labels: [{ name: 'state:implementing' }],
          updated_at: new Date().toISOString(),
          html_url: 'https://gh/q/r1/issues/99',
          comments: 0,
        },
      ],
    });
    const items = await fetchPipeline(octokit, repos, { include_terminal: false });
    expect(items).toHaveLength(1);
    expect(items[0].issue_number).toBe(99);
  });
});
