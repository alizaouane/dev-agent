import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchActiveRunsForIssue } from '@/lib/active-runs';
import type { Octokit } from '@octokit/rest';

function makeOctokit(handler: ReturnType<typeof vi.fn>): Octokit {
  return {
    actions: { listWorkflowRuns: handler },
  } as unknown as Octokit;
}

function mkRun(overrides: Partial<Record<string, unknown>>) {
  return {
    id: 1,
    status: 'in_progress',
    display_title: 'implement → issue #42 (live)',
    created_at: '2026-05-06T08:00:00Z',
    html_url: 'https://github.com/o/r/actions/runs/1',
    ...overrides,
  };
}

describe('fetchActiveRunsForIssue', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('matches the exact issue number, not a substring', async () => {
    // Issue #12 must NOT match a run titled for #123 — the panel is
    // operational live-state visibility, false positives would be
    // misleading.
    const handler = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          mkRun({ id: 1, display_title: 'implement → issue #12 (live)' }),
          mkRun({ id: 2, display_title: 'implement → issue #123 (live)' }),
          mkRun({ id: 3, display_title: 'implement → issue #1234 (live)' }),
        ],
      },
    });
    const result = await fetchActiveRunsForIssue(makeOctokit(handler), 'o', 'r', 12);
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it('returns empty + does not throw when listWorkflowRuns 403s', async () => {
    // Best-effort visibility: a transient 403/5xx must not propagate
    // up to FeaturePage's Promise.all and take down the whole route.
    const handler = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const result = await fetchActiveRunsForIssue(makeOctokit(handler), 'o', 'r', 42);
    expect(result).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it('returns empty + does not throw when listWorkflowRuns 5xxs', async () => {
    const handler = vi.fn().mockRejectedValue(Object.assign(new Error('upstream'), { status: 502 }));
    const result = await fetchActiveRunsForIssue(makeOctokit(handler), 'o', 'r', 42);
    expect(result).toEqual([]);
  });

  it('returns empty silently on 404 (workflow file missing)', async () => {
    // 404 is the "repo not wired up yet" case — expected, not warned.
    const handler = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const result = await fetchActiveRunsForIssue(makeOctokit(handler), 'o', 'r', 42);
    expect(result).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('filters out completed runs even when display_title matches', async () => {
    const handler = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          mkRun({ id: 1, status: 'in_progress' }),
          mkRun({ id: 2, status: 'completed' }),
          mkRun({ id: 3, status: 'queued' }),
          mkRun({ id: 4, status: 'waiting' }),
        ],
      },
    });
    const result = await fetchActiveRunsForIssue(makeOctokit(handler), 'o', 'r', 42);
    expect(result.map((r) => r.id).sort()).toEqual([1, 3, 4]);
  });

  it('parses phase + invocation_mode out of display_title', async () => {
    const handler = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [mkRun({ display_title: 'staging-deploy → issue #42 (stub)' })],
      },
    });
    const [run] = await fetchActiveRunsForIssue(makeOctokit(handler), 'o', 'r', 42);
    expect(run.phase).toBe('staging-deploy');
    expect(run.invocation_mode).toBe('stub');
  });
});
