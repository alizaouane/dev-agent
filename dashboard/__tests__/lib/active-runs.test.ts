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

describe('fetchActiveRunsForIssue strict', () => {
  /** A client whose strict path serves `runs` and whose default path serves them too. */
  const clientFor = (runs: unknown[], paginate?: ReturnType<typeof vi.fn>) =>
    ({
      actions: {
        listWorkflowRuns: vi.fn().mockResolvedValue({ data: { workflow_runs: runs } }),
      },
      paginate: paginate ?? vi.fn(async () => runs),
    }) as unknown as Parameters<typeof fetchActiveRunsForIssue>[0];

  it('rethrows a listing failure instead of reporting no runs', async () => {
    // The default is right for the visibility panel and wrong for a dispatch
    // guard: "could not list" is not "nothing running".
    const octokit = {
      actions: {
        listWorkflowRuns: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('rate limited'), { status: 403 })),
      },
      paginate: vi.fn().mockRejectedValue(Object.assign(new Error('rate limited'), { status: 403 })),
    } as unknown as Parameters<typeof fetchActiveRunsForIssue>[0];
    await expect(
      fetchActiveRunsForIssue(octokit, 'q', 'r', 7, { strict: true }),
    ).rejects.toThrow('rate limited');
    await expect(fetchActiveRunsForIssue(octokit, 'q', 'r', 7)).resolves.toEqual([]);
  });

  it('counts every non-completed status, not only the three it knows', async () => {
    // GitHub has more pre-execution statuses than queued/in_progress/waiting.
    // Listing only the ones it knows makes the guard report clear for the
    // ones it does not, which is how a duplicate dispatch gets through.
    const runs = [
      {
        id: 1,
        status: 'requested',
        display_title: 'implement → issue #7 (live)',
        html_url: 'u',
        created_at: '2026-09-10T00:00:00Z',
      },
    ];
    const octokit = clientFor(runs);
    await expect(fetchActiveRunsForIssue(octokit, 'q', 'r', 7)).resolves.toEqual([]);
    await expect(
      fetchActiveRunsForIssue(octokit, 'q', 'r', 7, { strict: true }),
    ).resolves.toHaveLength(1);
  });

  it('asks only for runs new enough to still be active', async () => {
    // A run older than GitHub's 35-day maximum cannot still be running, and
    // bounding on that rather than a page count keeps a repo with thousands
    // of completed runs behind it from becoming undispatchable.
    const paginate = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
    await fetchActiveRunsForIssue(clientFor([], paginate), 'q', 'r', 7, { strict: true });
    const params = paginate.mock.calls[0][1] as unknown as { created: string };
    expect(params.created).toMatch(/^>=\d{4}-\d{2}-\d{2}$/);
    const since = new Date(params.created.slice(2));
    const days = (Date.now() - since.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(34);
    expect(days).toBeLessThan(37);
  });

  it('finds a queued run that a single page would have missed', async () => {
    // paginate returns every page inside the window, so an older queued run
    // is not hidden behind newer completed ones.
    const runs = [
      ...Array.from({ length: 150 }, (_, i) => ({
        id: i,
        status: 'completed',
        display_title: 'implement → issue #999 (live)',
        html_url: 'u',
        created_at: '2026-09-10T00:00:00Z',
      })),
      {
        id: 5,
        status: 'queued',
        display_title: 'implement → issue #7 (live)',
        html_url: 'u',
        created_at: '2026-09-01T00:00:00Z',
      },
    ];
    await expect(
      fetchActiveRunsForIssue(clientFor(runs), 'q', 'r', 7, { strict: true }),
    ).resolves.toHaveLength(1);
  });
});
