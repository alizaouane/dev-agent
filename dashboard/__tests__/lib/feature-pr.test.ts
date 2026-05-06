import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchFeaturePR } from '@/lib/feature-pr';
import type { Octokit } from '@octokit/rest';

function makeOctokit(opts: {
  list?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
  checks?: ReturnType<typeof vi.fn>;
  combinedStatus?: ReturnType<typeof vi.fn>;
}): Octokit {
  return {
    pulls: {
      list: opts.list ?? vi.fn().mockResolvedValue({ data: [] }),
      get: opts.get ?? vi.fn(),
    },
    checks: {
      listForRef: opts.checks ?? vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
    },
    repos: {
      getCombinedStatusForRef:
        opts.combinedStatus ?? vi.fn().mockResolvedValue({ data: { statuses: [] } }),
    },
  } as unknown as Octokit;
}

describe('fetchFeaturePR', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns null when no PR matches the dev-agent head ref', async () => {
    const list = vi.fn().mockResolvedValue({ data: [] });
    const result = await fetchFeaturePR(makeOctokit({ list }), 'q', 'r', 42);
    expect(result).toBeNull();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ head: 'q:feat/dev-agent-issue-42' }),
    );
  });

  it('returns enriched PR when found, with check aggregation', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ number: 7 }] });
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: 'feat: refunds',
        merged: false,
        state: 'open',
        head: { ref: 'feat/dev-agent-issue-42', sha: 'abc' },
        base: { ref: 'main' },
        html_url: 'https://github.com/q/r/pull/7',
        mergeable: true,
      },
    });
    const checks = vi.fn().mockResolvedValue({
      data: {
        check_runs: [
          { name: 'CI', status: 'completed', conclusion: 'success', html_url: 'https://x' },
          { name: 'Lint', status: 'completed', conclusion: 'success', html_url: null },
        ],
      },
    });
    const result = await fetchFeaturePR(makeOctokit({ list, get, checks }), 'q', 'r', 42);
    expect(result).not.toBeNull();
    expect(result?.number).toBe(7);
    expect(result?.state).toBe('open');
    expect(result?.head_ref).toBe('feat/dev-agent-issue-42');
    expect(result?.checks_state).toBe('success');
    expect(result?.check_runs).toHaveLength(2);
  });

  it('marks state=merged when detail.merged is true', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ number: 7 }] });
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: 'x',
        merged: true,
        state: 'closed',
        head: { ref: 'feat/dev-agent-issue-42', sha: 'abc' },
        base: { ref: 'main' },
        html_url: 'https://github.com/q/r/pull/7',
        mergeable: null,
      },
    });
    const result = await fetchFeaturePR(makeOctokit({ list, get }), 'q', 'r', 42);
    expect(result?.state).toBe('merged');
  });

  it('aggregates checks_state to failure when any check failed', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ number: 7 }] });
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: 'x',
        merged: false,
        state: 'open',
        head: { ref: 'h', sha: 'abc' },
        base: { ref: 'main' },
        html_url: 'https://github.com/q/r/pull/7',
        mergeable: true,
      },
    });
    const checks = vi.fn().mockResolvedValue({
      data: {
        check_runs: [
          { name: 'CI', status: 'completed', conclusion: 'success', html_url: null },
          { name: 'Lint', status: 'completed', conclusion: 'failure', html_url: null },
        ],
      },
    });
    const result = await fetchFeaturePR(makeOctokit({ list, get, checks }), 'q', 'r', 42);
    expect(result?.checks_state).toBe('failure');
  });

  it('aggregates checks_state to pending when any check is still running', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ number: 7 }] });
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: 'x',
        merged: false,
        state: 'open',
        head: { ref: 'h', sha: 'abc' },
        base: { ref: 'main' },
        html_url: 'https://github.com/q/r/pull/7',
        mergeable: true,
      },
    });
    const checks = vi.fn().mockResolvedValue({
      data: {
        check_runs: [
          { name: 'CI', status: 'completed', conclusion: 'success', html_url: null },
          { name: 'Build', status: 'in_progress', conclusion: null, html_url: null },
        ],
      },
    });
    const result = await fetchFeaturePR(makeOctokit({ list, get, checks }), 'q', 'r', 42);
    expect(result?.checks_state).toBe('pending');
  });

  it('returns null + warns when pulls.list fails', async () => {
    const list = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await fetchFeaturePR(makeOctokit({ list }), 'q', 'r', 42);
    expect(result).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('aggregates legacy commit statuses (Jenkins/CircleCI/etc.) into checks_state', async () => {
    // Branch protections often require legacy commit statuses
    // (e.g. "ci/jenkins") that aren't returned by checks.listForRef.
    // Without merging both, the dashboard could show "checks pass" on
    // a PR GitHub will reject for missing required statuses.
    const list = vi.fn().mockResolvedValue({ data: [{ number: 7 }] });
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: 'x',
        merged: false,
        state: 'open',
        head: { ref: 'h', sha: 'abc' },
        base: { ref: 'main' },
        html_url: 'https://github.com/q/r/pull/7',
        mergeable: true,
      },
    });
    const checks = vi.fn().mockResolvedValue({
      data: {
        check_runs: [
          { name: 'CI', status: 'completed', conclusion: 'success', html_url: null },
        ],
      },
    });
    const combinedStatus = vi.fn().mockResolvedValue({
      data: {
        statuses: [
          { context: 'ci/jenkins', state: 'failure', target_url: 'https://j' },
        ],
      },
    });
    const result = await fetchFeaturePR(
      makeOctokit({ list, get, checks, combinedStatus }),
      'q', 'r', 42,
    );
    expect(result?.checks_state).toBe('failure');
    expect(result?.check_runs.map((c) => c.name)).toEqual(['CI', 'ci/jenkins']);
  });

  it('treats legacy status state=error as failure', async () => {
    // GitHub's commit-status `error` is a non-passing terminal state
    // and counts as failed for required-status purposes.
    const list = vi.fn().mockResolvedValue({ data: [{ number: 7 }] });
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: 'x',
        merged: false,
        state: 'open',
        head: { ref: 'h', sha: 'abc' },
        base: { ref: 'main' },
        html_url: 'https://github.com/q/r/pull/7',
        mergeable: true,
      },
    });
    const combinedStatus = vi.fn().mockResolvedValue({
      data: {
        statuses: [{ context: 'deploy/preview', state: 'error', target_url: null }],
      },
    });
    const result = await fetchFeaturePR(
      makeOctokit({ list, get, combinedStatus }),
      'q', 'r', 42,
    );
    expect(result?.checks_state).toBe('failure');
  });

  it('treats legacy status state=pending as pending', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ number: 7 }] });
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: 'x',
        merged: false,
        state: 'open',
        head: { ref: 'h', sha: 'abc' },
        base: { ref: 'main' },
        html_url: 'https://github.com/q/r/pull/7',
        mergeable: true,
      },
    });
    const combinedStatus = vi.fn().mockResolvedValue({
      data: {
        statuses: [{ context: 'ci/jenkins', state: 'pending', target_url: null }],
      },
    });
    const result = await fetchFeaturePR(
      makeOctokit({ list, get, combinedStatus }),
      'q', 'r', 42,
    );
    expect(result?.checks_state).toBe('pending');
  });

  it('still returns enriched PR when one of the two check sources fails', async () => {
    // Promise.allSettled: a transient 5xx on the combined-status call
    // shouldn't suppress the check-runs we already have.
    const list = vi.fn().mockResolvedValue({ data: [{ number: 7 }] });
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: 'x',
        merged: false,
        state: 'open',
        head: { ref: 'h', sha: 'abc' },
        base: { ref: 'main' },
        html_url: 'https://github.com/q/r/pull/7',
        mergeable: true,
      },
    });
    const checks = vi.fn().mockResolvedValue({
      data: {
        check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success', html_url: null }],
      },
    });
    const combinedStatus = vi.fn().mockRejectedValue(new Error('transient'));
    const result = await fetchFeaturePR(
      makeOctokit({ list, get, checks, combinedStatus }),
      'q', 'r', 42,
    );
    expect(result?.checks_state).toBe('success');
    expect(result?.check_runs).toHaveLength(1);
  });
});
