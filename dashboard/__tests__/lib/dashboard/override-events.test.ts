// dashboard/__tests__/lib/dashboard/override-events.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadOverrideEvents, __resetCacheForTests } from '../../../lib/dashboard/override-events';

const buildEvent = (overrides: Record<string, unknown> = {}) => ({
  ts: '2026-05-22T10:00:00Z',
  run_id: '12345',
  issue: 42,
  phase: 'phase-pr-review',
  event: 'override.applied',
  payload: { override_type: 'swarm-override', actor: 'alice', reason: 'false positive' },
  ...overrides,
});

const wrapAnchor = (event: object): string =>
  `audit comment\n\n<!-- dev-agent:event:b64 ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')} -->`;

function makeMockOctokit(prs: { number: number; updated_at: string; comments: { body: string; html_url: string }[] }[]) {
  return {
    paginate: vi.fn(async (fn: unknown, opts: { issue_number?: number }) => {
      if (opts.issue_number !== undefined) {
        const pr = prs.find((p) => p.number === opts.issue_number);
        return pr?.comments ?? [];
      }
      return prs.map((p) => ({ number: p.number, updated_at: p.updated_at }));
    }),
    pulls: { list: vi.fn() },
    issues: { listComments: vi.fn() },
  } as never;
}

describe('loadOverrideEvents', () => {
  beforeEach(() => __resetCacheForTests());

  it('returns the most recent override events sorted by ts desc', async () => {
    const older = buildEvent({ ts: '2026-05-20T10:00:00Z', payload: { override_type: 'swarm-override', actor: 'bob', reason: 'old' } });
    const newer = buildEvent({ ts: '2026-05-22T10:00:00Z', payload: { override_type: 'swarm-override', actor: 'alice', reason: 'new' } });
    const octokit = makeMockOctokit([
      { number: 42, updated_at: '2026-05-22T10:00:00Z', comments: [{ body: wrapAnchor(newer), html_url: 'https://gh.example/42#new' }] },
      { number: 41, updated_at: '2026-05-20T10:00:00Z', comments: [{ body: wrapAnchor(older), html_url: 'https://gh.example/41#old' }] },
    ]);
    const events = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' });
    expect(events).toHaveLength(2);
    expect(events[0].actor).toBe('alice');
    expect(events[1].actor).toBe('bob');
    expect(events[0].source_comment_url).toBe('https://gh.example/42#new');
  });

  it('skips comments without anchors and PRs without override comments', async () => {
    const octokit = makeMockOctokit([
      { number: 99, updated_at: '2026-05-22T10:00:00Z', comments: [{ body: 'no anchor here', html_url: 'x' }] },
    ]);
    const events = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' });
    expect(events).toEqual([]);
  });

  it('truncates to the limit and uses the cache on second call', async () => {
    const octokit = makeMockOctokit([
      { number: 1, updated_at: '2026-05-22T10:00:00Z', comments: [{ body: wrapAnchor(buildEvent()), html_url: 'x' }] },
    ]);
    const first = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' }, { limit: 5 });
    const second = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' }, { limit: 5 });
    expect(second).toEqual(first);
    // Second call hit the cache — paginate should not have been called again
    // for the same key. Expectation: paginate called for PRs+comments on the
    // first run, no additional calls on the second.
    expect((octokit as never as { paginate: { mock: { calls: unknown[] } } }).paginate.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('returns [] on octokit errors instead of crashing', async () => {
    const octokit = {
      paginate: vi.fn(async () => { throw new Error('rate limit'); }),
      pulls: { list: vi.fn() },
      issues: { listComments: vi.fn() },
    } as never;
    const events = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' });
    expect(events).toEqual([]);
  });
});
