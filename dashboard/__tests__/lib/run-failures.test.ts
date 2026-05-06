import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchRecentFailuresForIssue } from '@/lib/run-failures';
import type { Octokit } from '@octokit/rest';

function makeOctokit(opts: {
  list: ReturnType<typeof vi.fn>;
  jobs?: ReturnType<typeof vi.fn>;
  log?: ReturnType<typeof vi.fn>;
}): Octokit {
  return {
    actions: {
      listWorkflowRuns: opts.list,
      listJobsForWorkflowRun: opts.jobs ?? vi.fn().mockResolvedValue({ data: { jobs: [] } }),
      downloadJobLogsForWorkflowRun: opts.log ?? vi.fn().mockResolvedValue({ data: '' }),
    },
  } as unknown as Octokit;
}

function mkRun(o: Partial<Record<string, unknown>>) {
  return {
    id: 1,
    status: 'completed',
    conclusion: 'failure',
    display_title: 'implement → issue #42 (live)',
    created_at: '2026-05-06T08:00:00Z',
    html_url: 'https://github.com/o/r/actions/runs/1',
    ...o,
  };
}

describe('fetchRecentFailuresForIssue', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('matches by exact issue number, not substring', async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          mkRun({ id: 1, display_title: 'implement → issue #12 (live)' }),
          mkRun({ id: 2, display_title: 'implement → issue #123 (live)' }),
        ],
      },
    });
    const result = await fetchRecentFailuresForIssue(makeOctokit({ list }), 'o', 'r', 12);
    expect(result.map((r) => r.id)).toEqual([1]);
  });

  it('only includes failed/cancelled/timed-out/startup_failure runs', async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          mkRun({ id: 1, conclusion: 'failure' }),
          mkRun({ id: 2, conclusion: 'success' }),
          mkRun({ id: 3, conclusion: 'startup_failure' }),
          mkRun({ id: 4, conclusion: 'cancelled' }),
          mkRun({ id: 5, conclusion: 'timed_out' }),
          mkRun({ id: 6, conclusion: 'neutral' }),
        ],
      },
    });
    // limit=10 so we exercise the conclusion filter, not the cap.
    const result = await fetchRecentFailuresForIssue(makeOctokit({ list }), 'o', 'r', 42, 10);
    expect(result.map((r) => r.id).sort()).toEqual([1, 3, 4, 5]);
  });

  it('respects limit', async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: Array.from({ length: 5 }, (_, i) => mkRun({ id: i + 1 })),
      },
    });
    const result = await fetchRecentFailuresForIssue(makeOctokit({ list }), 'o', 'r', 42, 2);
    expect(result).toHaveLength(2);
  });

  it('enriches with failed step name and log tail', async () => {
    const list = vi.fn().mockResolvedValue({
      data: { workflow_runs: [mkRun({ id: 7 })] },
    });
    const jobs = vi.fn().mockResolvedValue({
      data: {
        jobs: [
          {
            id: 700,
            conclusion: 'failure',
            steps: [
              { name: 'Set up job', conclusion: 'success' },
              { name: 'Run Claude Code', conclusion: 'failure' },
              { name: 'Cleanup', conclusion: 'skipped' },
            ],
          },
        ],
      },
    });
    const log = vi.fn().mockResolvedValue({
      data:
        Array.from({ length: 50 }, (_, i) => `2026-05-06T08:0${i}Z line${i}`).join('\n'),
    });
    const [r] = await fetchRecentFailuresForIssue(
      makeOctokit({ list, jobs, log }),
      'o', 'r', 42,
    );
    expect(r.failed_step).toBe('Run Claude Code');
    // Tail keeps last 30 non-empty lines
    expect(r.log_tail?.split('\n')).toHaveLength(30);
    expect(r.log_tail?.endsWith('line49')).toBe(true);
  });

  it('returns empty silently on 404 (workflow not present)', async () => {
    const list = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const result = await fetchRecentFailuresForIssue(makeOctokit({ list }), 'o', 'r', 42);
    expect(result).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('degrades to empty + warn on transient 5xx', async () => {
    const list = vi.fn().mockRejectedValue(Object.assign(new Error('upstream'), { status: 502 }));
    const result = await fetchRecentFailuresForIssue(makeOctokit({ list }), 'o', 'r', 42);
    expect(result).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it('keeps the run row even when log download fails (logs may have expired)', async () => {
    const list = vi.fn().mockResolvedValue({
      data: { workflow_runs: [mkRun({ id: 9 })] },
    });
    const jobs = vi.fn().mockResolvedValue({
      data: {
        jobs: [
          {
            id: 900,
            conclusion: 'failure',
            steps: [{ name: 'broken', conclusion: 'failure' }],
          },
        ],
      },
    });
    const log = vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { status: 410 }));
    const [r] = await fetchRecentFailuresForIssue(
      makeOctokit({ list, jobs, log }),
      'o', 'r', 42,
    );
    expect(r.id).toBe(9);
    expect(r.failed_step).toBe('broken');
    expect(r.log_tail).toBeNull();
  });
});
