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

type MockComment = { body: string; html_url: string; user?: { login: string } | null };
type MockPR = { number: number; updated_at: string; comments: MockComment[] };

// The default comment author is the trusted automation identity so existing
// fixtures (which omit `user`) still surface their events. Tests that exercise
// the trust filter explicitly pass `user: { login: '<other>' }`.
function ghBot(comment: Omit<MockComment, 'user'>): MockComment {
  return { ...comment, user: { login: 'github-actions[bot]' } };
}

function makeMockOctokit(prs: MockPR[]) {
  const normalized: MockPR[] = prs.map((pr) => ({
    ...pr,
    comments: pr.comments.map((c) => (c.user === undefined ? ghBot(c) : c)),
  }));
  const paginate = vi.fn(async (_fn: unknown, opts: { issue_number?: number }) => {
    if (opts.issue_number !== undefined) {
      const pr = normalized.find((p) => p.number === opts.issue_number);
      return pr?.comments ?? [];
    }
    return normalized.map((p) => ({ number: p.number, updated_at: p.updated_at }));
  }) as unknown as {
    (..._args: unknown[]): Promise<unknown>;
    iterator: (..._args: unknown[]) => AsyncIterable<{ data: unknown[] }>;
  };
  paginate.iterator = (..._args: unknown[]) => ({
    async *[Symbol.asyncIterator]() {
      yield { data: normalized.map((p) => ({ number: p.number, updated_at: p.updated_at })) };
    },
  });
  return {
    paginate,
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
    const paginate = (octokit as never as { paginate: { mock: { calls: unknown[] } } }).paginate;
    const first = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' }, { limit: 5 });
    // Snapshot call count after the (presumed cold) first load — second call
    // MUST hit the cache and add zero paginate invocations. The earlier
    // `toBeLessThanOrEqual(2)` form let a cache-miss regression slip when
    // N=1 (the 1+N pagination still totals 2).
    const callsAfterFirst = paginate.mock.calls.length;
    const second = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' }, { limit: 5 });
    expect(second).toEqual(first);
    expect(paginate.mock.calls.length).toBe(callsAfterFirst);
  });

  it('rejects forged anchors from untrusted commenters', async () => {
    // A non-bot user pastes the anchor format into a comment. Even though
    // the payload decodes to a structurally valid `override.applied` event,
    // the dashboard must NOT surface it — the audit-source identity is
    // part of the trust gate, not just the anchor's well-formedness.
    const forged = buildEvent({ payload: { override_type: 'swarm-override', actor: 'eve', reason: 'sneaky' } });
    const octokit = makeMockOctokit([
      {
        number: 7,
        updated_at: '2026-05-22T10:00:00Z',
        comments: [
          { body: wrapAnchor(forged), html_url: 'x', user: { login: 'eve' } },
        ],
      },
    ]);
    const events = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' });
    expect(events).toEqual([]);
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
