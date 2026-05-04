import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { scoutRecurringCIFailures } from '@/lib/scout/ci-failures';

type RunFixture = {
  id: number;
  name: string | null;
  path: string;
  conclusion: string | null;
  status: string | null;
  html_url: string;
  created_at: string;
};

function makeRun(over: Partial<RunFixture> = {}): RunFixture {
  return {
    id: Math.random(),
    name: 'CI',
    path: '.github/workflows/ci.yml',
    conclusion: 'failure',
    status: 'completed',
    html_url: 'https://github.com/q/r/actions/runs/123',
    created_at: new Date().toISOString(),
    ...over,
  };
}

function mockOctokit(opts: { runs?: RunFixture[]; fail?: boolean }): Octokit {
  const listWorkflowRunsForRepo = vi.fn(async () => {
    if (opts.fail) throw Object.assign(new Error('rate'), { status: 429 });
    return { data: { workflow_runs: opts.runs ?? [] } };
  });
  return {
    actions: { listWorkflowRunsForRepo },
  } as unknown as Octokit;
}

describe('scoutRecurringCIFailures', () => {
  it('returns empty when there are no failures', async () => {
    const octokit = mockOctokit({ runs: [makeRun({ conclusion: 'success' })] });
    expect(await scoutRecurringCIFailures(octokit, 'q', 'r')).toEqual([]);
  });

  it('does NOT emit a proposal below the 3-failure threshold', async () => {
    const octokit = mockOctokit({
      runs: [
        makeRun({ path: '.github/workflows/ci.yml' }),
        makeRun({ path: '.github/workflows/ci.yml' }),
      ],
    });
    const proposals = await scoutRecurringCIFailures(octokit, 'q', 'r');
    expect(proposals).toEqual([]);
  });

  it('emits a proposal for a workflow with >= 3 failures in the window', async () => {
    const octokit = mockOctokit({
      runs: [
        makeRun({ path: '.github/workflows/ci.yml', name: 'CI' }),
        makeRun({ path: '.github/workflows/ci.yml', name: 'CI' }),
        makeRun({ path: '.github/workflows/ci.yml', name: 'CI' }),
      ],
    });
    const proposals = await scoutRecurringCIFailures(octokit, 'q', 'r');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe('recurring_ci_failure');
    expect(proposals[0].group).toBe('carry_over');
    expect(proposals[0].meta?.failure_count).toBe(3);
    expect(proposals[0].title).toContain('CI');
  });

  it('groups by workflow path, not name (rename-resilient)', async () => {
    // Same path, different display name on different runs (workflow's
    // `name:` field was edited mid-week). Should still group as one.
    const octokit = mockOctokit({
      runs: [
        makeRun({ path: '.github/workflows/ci.yml', name: 'CI' }),
        makeRun({ path: '.github/workflows/ci.yml', name: 'CI v2' }),
        makeRun({ path: '.github/workflows/ci.yml', name: 'CI' }),
      ],
    });
    const proposals = await scoutRecurringCIFailures(octokit, 'q', 'r');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].meta?.failure_count).toBe(3);
  });

  it('keeps each workflow path in its own group', async () => {
    const octokit = mockOctokit({
      runs: [
        ...Array.from({ length: 3 }, () => makeRun({ path: '.github/workflows/a.yml', name: 'A' })),
        ...Array.from({ length: 4 }, () => makeRun({ path: '.github/workflows/b.yml', name: 'B' })),
      ],
    });
    const proposals = await scoutRecurringCIFailures(octokit, 'q', 'r');
    expect(proposals.map((p) => p.meta?.workflow_path).sort()).toEqual([
      '.github/workflows/a.yml',
      '.github/workflows/b.yml',
    ]);
  });

  it('skips runs whose conclusion is not "failure"', async () => {
    const octokit = mockOctokit({
      runs: [
        makeRun({ path: '.github/workflows/ci.yml', conclusion: 'failure' }),
        makeRun({ path: '.github/workflows/ci.yml', conclusion: 'success' }),
        makeRun({ path: '.github/workflows/ci.yml', conclusion: 'cancelled' }),
        makeRun({ path: '.github/workflows/ci.yml', conclusion: 'failure' }),
      ],
    });
    // Only 2 actual failures — below the threshold.
    expect(await scoutRecurringCIFailures(octokit, 'q', 'r')).toEqual([]);
  });

  it('skips failures older than the 7-day window', async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const octokit = mockOctokit({
      runs: [
        makeRun({ path: '.github/workflows/ci.yml', created_at: old }),
        makeRun({ path: '.github/workflows/ci.yml', created_at: old }),
        makeRun({ path: '.github/workflows/ci.yml', created_at: old }),
      ],
    });
    expect(await scoutRecurringCIFailures(octokit, 'q', 'r')).toEqual([]);
  });

  it('uses the most recent failure URL in the proposal', async () => {
    const old = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const octokit = mockOctokit({
      runs: [
        makeRun({ path: '.github/workflows/ci.yml', created_at: old, html_url: 'OLD' }),
        makeRun({ path: '.github/workflows/ci.yml', created_at: old, html_url: 'OLDER' }),
        makeRun({ path: '.github/workflows/ci.yml', created_at: recent, html_url: 'NEW' }),
      ],
    });
    const proposals = await scoutRecurringCIFailures(octokit, 'q', 'r');
    expect(proposals[0].url).toBe('NEW');
  });

  it('returns empty when the API call fails', async () => {
    const octokit = mockOctokit({ fail: true });
    expect(await scoutRecurringCIFailures(octokit, 'q', 'r')).toEqual([]);
  });
});
