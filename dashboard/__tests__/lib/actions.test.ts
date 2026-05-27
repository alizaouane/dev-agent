import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockOctokit = {
  repos: {
    getCollaboratorPermissionLevel: vi.fn(),
    getContent: vi.fn(),
    createOrUpdateFileContents: vi.fn(),
    get: vi.fn(),
  },
  issues: {
    create: vi.fn(),
    get: vi.fn(),
    setLabels: vi.fn(),
    createComment: vi.fn(),
    update: vi.fn(),
  },
  actions: {
    createWorkflowDispatch: vi.fn(),
    getRepoPublicKey: vi.fn(),
    createOrUpdateRepoSecret: vi.fn(),
    cancelWorkflowRun: vi.fn(),
    listWorkflowRuns: vi.fn(),
  },
  git: {
    getRef: vi.fn(),
    createRef: vi.fn(),
    updateRef: vi.fn(),
  },
  pulls: {
    list: vi.fn(),
    create: vi.fn(),
    merge: vi.fn(),
  },
};

// Stub pushRepoSecret entirely — the real implementation is exercised
// in gh-secrets.test.ts. Here we just want to assert that wireUpRepo
// calls (or skips) it correctly based on env state.
vi.mock('@/lib/gh-secrets', () => ({
  pushRepoSecret: vi.fn(),
}));

vi.mock('@/lib/gh', () => ({
  getOctokit: vi.fn(() => Promise.resolve(mockOctokit)),
  getCurrentUsername: vi.fn(() => Promise.resolve('alizaouane')),
  UnauthorizedError: class extends Error {},
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`__redirect__:${url}`);
  }),
}));

// Snapshot the original ANTHROPIC_API_KEY once so per-test mutations
// (set/clear) don't leak across describe blocks.
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'write' } });
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
});

describe('dropIntent', () => {
  it('creates an issue with state:scoping + kind:user-intent labels', async () => {
    mockOctokit.issues.create.mockResolvedValue({ data: { number: 42 } });
    const { dropIntent } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'qualiency/test-repo');
    fd.append('intent', 'add a refund button');
    try {
      await dropIntent(fd);
    } catch (e) {
      // redirect throws by design — we look for the URL in the error message
      expect((e as Error).message).toMatch(/__redirect__:\/features\/42/);
    }
    expect(mockOctokit.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'qualiency',
        repo: 'test-repo',
        labels: ['kind:user-intent', 'state:scoping'],
      }),
    );
  });

  it('refuses on a repo without write permission', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'read' } });
    const { dropIntent } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'qualiency/test-repo');
    fd.append('intent', 'foo');
    await expect(dropIntent(fd)).rejects.toThrow(/lacks write/);
  });
});

describe('approveGate', () => {
  it('promotes spec-ready → implementing', async () => {
    mockOctokit.issues.get.mockResolvedValue({
      data: { labels: [{ name: 'state:spec-ready' }, { name: 'kind:user-intent' }] },
    });
    const { approveGate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'qualiency/test-repo');
    fd.append('issue', '5');
    fd.append('promote', '0');
    await approveGate(fd);
    expect(mockOctokit.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.arrayContaining(['kind:user-intent', 'state:implementing']),
      }),
    );
    const setLabelsCall = mockOctokit.issues.setLabels.mock.calls[0][0];
    expect(setLabelsCall.labels).not.toContain('state:spec-ready');
  });

  it('rejects --promote on spec-ready', async () => {
    mockOctokit.issues.get.mockResolvedValue({
      data: { labels: [{ name: 'state:spec-ready' }] },
    });
    const { approveGate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '1');
    fd.append('promote', '1');
    await expect(approveGate(fd)).rejects.toThrow(/cannot promote/);
  });
});

describe('dispatchExistingIssue', () => {
  beforeEach(() => {
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 42,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
        html_url: 'https://github.com/x/y/issues/42',
      },
    });
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'admin' },
    });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValue({});
    mockOctokit.issues.setLabels.mockResolvedValue({});
    // Default: no active runs — the idempotency guard inside
    // dispatchExistingIssue calls fetchActiveRunsForIssue which calls
    // octokit.actions.listWorkflowRuns under the hood, so an empty
    // response makes the guard pass through.
    mockOctokit.actions.listWorkflowRuns.mockResolvedValue({
      data: { workflow_runs: [] },
    });
  });

  it('dispatches implement workflow and flips state:spec-ready → state:implementing', async () => {
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('issue', '42');
    const { dispatchExistingIssue } = await import('@/lib/actions');
    // redirect() throws (mocked above to `__redirect__:<url>`); we look at it
    // to confirm the success-path was reached without a thrown framework error.
    await expect(dispatchExistingIssue(fd)).rejects.toThrow(/__redirect__:\/features\/42/);
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: 'dev-agent.yml',
        ref: 'main',
        inputs: expect.objectContaining({
          phase: 'implement',
          issue_number: '42',
        }),
      }),
    );
    expect(mockOctokit.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'x',
        repo: 'y',
        issue_number: 42,
        labels: expect.arrayContaining(['state:implementing', 'kind:feature']),
      }),
    );
    // Ensure state:spec-ready is gone after the flip.
    const setLabelsCall = mockOctokit.issues.setLabels.mock.calls[0][0];
    expect(setLabelsCall.labels).not.toContain('state:spec-ready');
  });

  it('rejects when the issue is not at state:spec-ready', async () => {
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 42,
        labels: [{ name: 'state:scoping' }],
        html_url: 'https://github.com/x/y/issues/42',
      },
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('issue', '42');
    const { dispatchExistingIssue } = await import('@/lib/actions');
    const result = await dispatchExistingIssue(fd);
    expect(result).toEqual({
      error: expect.stringContaining('state:spec-ready'),
      issue_url: 'https://github.com/x/y/issues/42',
    });
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(mockOctokit.issues.setLabels).not.toHaveBeenCalled();
  });

  it('rejects non-numeric issue input without calling the dispatch', async () => {
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('issue', '42oops');
    const { dispatchExistingIssue } = await import('@/lib/actions');
    const result = await dispatchExistingIssue(fd);
    expect(result).toEqual({ error: expect.stringMatching(/issue/i) });
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(mockOctokit.issues.setLabels).not.toHaveBeenCalled();
  });

  it('refuses dispatch when an active run already targets the issue', async () => {
    // Idempotency guard: a previous approve hit a label-flip failure
    // (issue stuck at state:spec-ready) but the dispatch succeeded —
    // the second click must not queue a duplicate implement run.
    mockOctokit.actions.listWorkflowRuns.mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 999,
            status: 'in_progress',
            display_title: 'implement → issue #42 (live)',
            created_at: '2026-05-27T00:00:00Z',
            html_url: 'https://github.com/x/y/actions/runs/999',
          },
        ],
      },
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('issue', '42');
    const { dispatchExistingIssue } = await import('@/lib/actions');
    const result = await dispatchExistingIssue(fd);
    expect(result).toEqual({
      error: expect.stringContaining('active run'),
      issue_url: 'https://github.com/x/y/issues/42',
    });
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(mockOctokit.issues.setLabels).not.toHaveBeenCalled();
  });

  it('strips all state:* labels (not just state:spec-ready) when flipping to state:implementing', async () => {
    // Defensive against issues that ended up with two state labels (e.g.,
    // from a prior recovery step). Downstream consumers read a single
    // state — leaving the extra around would let them pick the wrong one.
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 42,
        labels: [
          { name: 'state:spec-ready' },
          { name: 'state:scoping' },
          { name: 'kind:feature' },
        ],
        html_url: 'https://github.com/x/y/issues/42',
      },
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('issue', '42');
    const { dispatchExistingIssue } = await import('@/lib/actions');
    await expect(dispatchExistingIssue(fd)).rejects.toThrow(/__redirect__:/);
    const setLabelsCall = mockOctokit.issues.setLabels.mock.calls[0][0];
    expect(setLabelsCall.labels).toEqual(['kind:feature', 'state:implementing']);
    expect(setLabelsCall.labels).not.toContain('state:spec-ready');
    expect(setLabelsCall.labels).not.toContain('state:scoping');
  });

  it('still redirects when post-dispatch label flip fails (idempotency guard handles re-clicks)', async () => {
    // setLabels failure after a successful dispatch is logged + swallowed
    // because the workflow is already queued. The next user-click is
    // protected by the active-runs idempotency guard (covered above), so
    // a stuck label can't cause duplicate dispatches.
    mockOctokit.issues.setLabels.mockRejectedValue(new Error('label-fail'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('issue', '42');
    const { dispatchExistingIssue } = await import('@/lib/actions');
    await expect(dispatchExistingIssue(fd)).rejects.toThrow(/__redirect__:\/features\/42/);
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('label flip failed'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

describe('dispatchFromSpec', () => {
  beforeEach(() => {
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'admin' },
    });
    // Both files present on the default branch by default.
    mockOctokit.repos.getContent.mockResolvedValue({ data: { type: 'file' } });
    mockOctokit.issues.create.mockResolvedValue({
      data: {
        number: 77,
        html_url: 'https://github.com/x/y/issues/77',
      },
    });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValue({});
    mockOctokit.issues.setLabels.mockResolvedValue({});
    mockOctokit.actions.listWorkflowRuns.mockResolvedValue({
      data: { workflow_runs: [] },
    });
  });

  it('creates a state:spec-ready issue from existing spec + plan paths and dispatches implement', async () => {
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', 'docs/superpowers/specs/2026-05-01-foo-design.md');
    fd.append('plan_path', 'docs/superpowers/plans/2026-05-01-foo.md');
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    await expect(dispatchFromSpec(fd)).rejects.toThrow(/__redirect__:\/features\/77/);

    expect(mockOctokit.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'x',
        repo: 'y',
        title: 'Foo feature',
        labels: expect.arrayContaining(['state:spec-ready', 'kind:feature']),
        body: expect.stringMatching(
          /Spec: docs\/superpowers\/specs\/2026-05-01-foo-design\.md[\s\S]*Plan: docs\/superpowers\/plans\/2026-05-01-foo\.md/,
        ),
      }),
    );
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: 'dev-agent.yml',
        ref: 'main',
        inputs: expect.objectContaining({
          phase: 'implement',
          issue_number: '77',
        }),
      }),
    );
    // After dispatch, the issue should be at state:implementing (not spec-ready).
    const setLabelsCall = mockOctokit.issues.setLabels.mock.calls.at(-1)?.[0];
    expect(setLabelsCall?.labels).toContain('state:implementing');
    expect(setLabelsCall?.labels).not.toContain('state:spec-ready');
  });

  it('refuses when spec_path does not exist on the default branch', async () => {
    mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'docs/superpowers/specs/missing.md') {
        const err = new Error('Not Found') as Error & { status: number };
        err.status = 404;
        throw err;
      }
      return { data: { type: 'file' } };
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', 'docs/superpowers/specs/missing.md');
    fd.append('plan_path', 'docs/superpowers/plans/2026-05-01-foo.md');
    fd.append('title', 'Foo');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual({ error: expect.stringContaining('spec_path') });
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('refuses when plan_path does not exist on the default branch', async () => {
    mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'docs/superpowers/plans/missing.md') {
        const err = new Error('Not Found') as Error & { status: number };
        err.status = 404;
        throw err;
      }
      return { data: { type: 'file' } };
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', 'docs/superpowers/specs/2026-05-01-foo-design.md');
    fd.append('plan_path', 'docs/superpowers/plans/missing.md');
    fd.append('title', 'Foo');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual({ error: expect.stringContaining('plan_path') });
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('refuses without write permission (returns error, does not throw)', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'read' },
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', 'docs/superpowers/specs/2026-05-01-foo-design.md');
    fd.append('plan_path', 'docs/superpowers/plans/2026-05-01-foo.md');
    fd.append('title', 'Foo');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual({ error: expect.stringMatching(/lacks write/) });
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });
});

describe('abandonFeature', () => {
  it('relabels state:abandoned and closes', async () => {
    mockOctokit.issues.get.mockResolvedValue({
      data: { labels: [{ name: 'state:implementing' }] },
    });
    const { abandonFeature } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '1');
    fd.append('reason', 'duplicate');
    await abandonFeature(fd);
    const setLabelsCall = mockOctokit.issues.setLabels.mock.calls[0][0];
    expect(setLabelsCall.labels).toContain('state:abandoned');
    expect(mockOctokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'closed' }),
    );
  });
});

describe('dispatchRollback', () => {
  it('dispatches phase-rollback.yml with the right inputs', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    const { dispatchRollback } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '5');
    await dispatchRollback(fd);
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: 'phase-rollback.yml',
        inputs: { issue_number: '5', invocation_mode: 'live' },
      }),
    );
  });

  it("dispatches on the repo's actual default branch, not a hardcoded 'main' (regression)", async () => {
    // Production bug: the rollback dispatch hardcoded ref='main', which
    // 404s on any consumer whose default branch is named differently.
    // Use 'develop' so a future regression to 'main' fails this test loudly.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'develop' } });
    const { dispatchRollback } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '7');
    await dispatchRollback(fd);
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'develop' }),
    );
  });
});

describe('setBugScoutSchedule', () => {
  const ACTIVE_YAML = [
    'name: dev-agent · bug-scout',
    '',
    'on:',
    '  schedule:',
    "    - cron: '0 9 * * *'",
    '  workflow_dispatch:',
    '    inputs: {}',
    '',
    'jobs:',
    '  bug-scout:',
    '    uses: alizaouane/dev-agent/.github/workflows/phase-bug-scout.yml@v1',
    '',
  ].join('\n');

  it('rejects an unknown preset', async () => {
    const { setBugScoutSchedule } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('preset', 'hourly');
    await expect(setBugScoutSchedule(fd)).rejects.toThrow(/invalid preset/);
  });

  it('refuses without write permission', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { setBugScoutSchedule } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('preset', 'weekly');
    await expect(setBugScoutSchedule(fd)).rejects.toThrow(/lacks write/);
  });

  it('reads default branch from the repo and writes the new cron', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({
      data: { default_branch: 'develop' },
    });
    mockOctokit.repos.getContent.mockResolvedValueOnce({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(ACTIVE_YAML, 'utf8').toString('base64'),
        sha: 'sha-abc',
      },
    });
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValueOnce({});

    const { setBugScoutSchedule } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('preset', 'weekly');
    await setBugScoutSchedule(fd);

    // It read the workflow file from the repo's actual default branch.
    expect(mockOctokit.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'develop', path: '.github/workflows/dev-agent-bug-scout.yml' }),
    );
    // It committed back with the SHA we read + new cron in the YAML.
    const writeCall = mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    expect(writeCall.sha).toBe('sha-abc');
    const decoded = Buffer.from(writeCall.content, 'base64').toString('utf8');
    expect(decoded).toContain("- cron: '0 9 * * 1'");
  });
});

describe('triggerUnfinishedWorkScan', () => {
  it('rejects bad input (missing /)', async () => {
    const { triggerUnfinishedWorkScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'just-a-name');
    await expect(triggerUnfinishedWorkScan(fd)).rejects.toThrow(/owner\/name format/);
  });

  it('refuses without write permission', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { triggerUnfinishedWorkScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    await expect(triggerUnfinishedWorkScan(fd)).rejects.toThrow(/lacks write/);
  });

  it('dispatches the unfinished-work-scout workflow on the repo default branch', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({
      data: { default_branch: 'develop' },
    });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});

    const { triggerUnfinishedWorkScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    await triggerUnfinishedWorkScan(fd);

    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        workflow_id: 'dev-agent-unfinished-work-scout.yml',
        ref: 'develop',
        inputs: {},
      }),
    );
  });
});

describe('triggerCleanupScan', () => {
  it('rejects bad input (missing /)', async () => {
    const { triggerCleanupScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'just-a-name');
    await expect(triggerCleanupScan(fd)).rejects.toThrow(/owner\/name format/);
  });

  it('refuses without write permission', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { triggerCleanupScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    await expect(triggerCleanupScan(fd)).rejects.toThrow(/lacks write/);
  });

  it('dispatches the cleanup-scout workflow on the repo default branch', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({
      data: { default_branch: 'develop' },
    });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});

    const { triggerCleanupScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    await triggerCleanupScan(fd);

    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        workflow_id: 'dev-agent-cleanup-scout.yml',
        ref: 'develop',
        inputs: {},
      }),
    );
  });
});

describe('triggerBugScoutScan', () => {
  it('rejects a repo that is not in owner/name format', async () => {
    const { triggerBugScoutScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'no-slash-here');
    await expect(triggerBugScoutScan(fd)).rejects.toThrow(/owner\/name format/);
  });

  it('refuses without write permission', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { triggerBugScoutScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    await expect(triggerBugScoutScan(fd)).rejects.toThrow(/lacks write/);
  });

  it("dispatches dev-agent-bug-scout.yml on the repo's default branch", async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});

    const { triggerBugScoutScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    await triggerBugScoutScan(fd);

    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        workflow_id: 'dev-agent-bug-scout.yml',
        ref: 'main',
        inputs: {},
      }),
    );
  });

  it('dispatches on the actual default branch, not a hardcoded main', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'develop' } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});

    const { triggerBugScoutScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    await triggerBugScoutScan(fd);

    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'develop' }),
    );
  });
});

describe('getLatestScanRun', () => {
  it('returns the latest run fields for a workflow', async () => {
    mockOctokit.actions.listWorkflowRuns.mockResolvedValueOnce({
      data: {
        workflow_runs: [
          {
            status: 'in_progress',
            conclusion: null,
            html_url: 'https://github.com/q/r/actions/runs/1',
            created_at: '2026-05-18T00:00:00Z',
          },
        ],
      },
    });

    const { getLatestScanRun } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'dev-agent-bug-scout.yml');
    const result = await getLatestScanRun(fd);

    expect(result).toEqual({
      status: 'in_progress',
      conclusion: null,
      html_url: 'https://github.com/q/r/actions/runs/1',
      created_at: '2026-05-18T00:00:00Z',
    });
    expect(mockOctokit.actions.listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        workflow_id: 'dev-agent-bug-scout.yml',
        per_page: 1,
      }),
    );
  });

  it('returns all-null when the workflow has no runs', async () => {
    mockOctokit.actions.listWorkflowRuns.mockResolvedValueOnce({
      data: { workflow_runs: [] },
    });
    const { getLatestScanRun } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'dev-agent-bug-scout.yml');
    expect(await getLatestScanRun(fd)).toEqual({
      status: null,
      conclusion: null,
      html_url: null,
      created_at: null,
    });
  });

  it('returns { error } instead of throwing when the API call fails', async () => {
    mockOctokit.actions.listWorkflowRuns.mockRejectedValueOnce(
      new Error('GitHub API 500'),
    );
    const { getLatestScanRun } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'dev-agent-bug-scout.yml');
    expect(await getLatestScanRun(fd)).toEqual({
      error: expect.stringContaining('GitHub API 500'),
    });
  });
});

function notFound() {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

describe('wireUpRepo', () => {
  it('commits template files directly to the default branch (no PR)', async () => {
    // Repo is not yet wired up. default_branch is resolved server-side via
    // repos.get rather than trusting form input.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'qualiency');
    fd.append('repo', 'test-repo');

    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    // All template files committed without a `branch` param, so they
    // land on the repo's default branch.
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(10);
    for (const call of mockOctokit.repos.createOrUpdateFileContents.mock.calls) {
      expect(call[0].branch).toBeUndefined();
    }
    // The PR-flow APIs are never touched on the wire-up path now.
    expect(mockOctokit.git.getRef).not.toHaveBeenCalled();
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
    expect(mockOctokit.pulls.list).not.toHaveBeenCalled();
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('uses the same direct-commit path for empty repos', async () => {
    // Empty repos behave identically — the API creates the initial commit
    // and branch ref on first createOrUpdateFileContents.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'qualiency');
    fd.append('repo', 'fresh-empty-repo');

    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(10);
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('returns "already wired up" error for an already-wired repo', async () => {
    // .dev-agent.yml already exists on the default branch.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockResolvedValueOnce({ data: { type: 'file' } });

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'already-wired');
    // Returns instead of throwing so the message survives prod's
    // Server Components error mask.
    await expect(wireUpRepo(fd)).resolves.toEqual({
      error: expect.stringMatching(/already wired up/),
    });
    // No file commits attempted on the already-wired path.
    expect(mockOctokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("uses the repo's actual default branch, not a form-supplied value", async () => {
    // Form-supplied default_branch is now ignored: server resolves the
    // branch via repos.get to defeat tampering. A repo whose actual
    // default is 'develop' should be probed against 'develop' regardless
    // of what the form claims.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'develop' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    fd.append('default_branch', 'main'); // tampered / stale — should be ignored

    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    expect(mockOctokit.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'develop' }),
    );
  });

  it('returns a write-permission error when the user lacks write', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    await expect(wireUpRepo(fd)).resolves.toEqual({
      error: expect.stringMatching(/lacks write/),
    });
  });

  it('pushes ANTHROPIC_API_KEY to the repo when the dashboard env is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    (pushRepoSecret as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    expect(pushRepoSecret).toHaveBeenCalledWith({
      octokit: expect.anything(),
      owner: 'q',
      repo: 'r',
      name: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-test',
    });
    // Files were committed directly to the default branch (no PR flow).
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(10);
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('skips pushRepoSecret when ANTHROPIC_API_KEY is unset on the dashboard', async () => {
    // No env var.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    (pushRepoSecret as ReturnType<typeof vi.fn>).mockClear();

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    expect(pushRepoSecret).not.toHaveBeenCalled();
    // Files still committed even without the secret.
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(10);
  });

  it('still commits files when secret-push fails (e.g. user lacks admin perm)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    (pushRepoSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
    );

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    // The wire-up still landed all three files; only the secret push failed.
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(10);
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("passes existing file's sha when a template file already exists on the default branch", async () => {
    // Repro: orphaned bug-scout workflow from a partial prior wire-up
    // (`.dev-agent.yml` was deleted by a cleanup commit but the workflow
    // files were left in place). Without sha, GitHub returns
    // "422 sha wasn't supplied" and the loop aborts mid-wire-up.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === '.github/workflows/dev-agent-bug-scout.yml') {
        return { data: { type: 'file', sha: 'EXISTING_SHA_123' } };
      }
      throw notFound();
    });
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    // All 10 template files committed despite the orphan.
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(10);

    const calls = mockOctokit.repos.createOrUpdateFileContents.mock.calls as Array<
      [{ path: string; sha?: string }]
    >;
    const bugScoutCall = calls.find(
      (c) => c[0].path === '.github/workflows/dev-agent-bug-scout.yml',
    );
    // The orphan's sha is forwarded so GitHub treats it as an update, not a create.
    expect(bugScoutCall?.[0].sha).toBe('EXISTING_SHA_123');

    // Files that don't exist must NOT carry a sha — GitHub rejects sha-on-create.
    const freshCall = calls.find((c) => c[0].path === '.dev-agent.yml');
    expect(freshCall?.[0]).not.toHaveProperty('sha');
  });
});

describe('installWorkflow', () => {
  it('commits the bug-scout workflow file when missing', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'bug-scout');
    await expect(installWorkflow(fd)).resolves.toBeUndefined();

    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        path: '.github/workflows/dev-agent-bug-scout.yml',
      }),
    );
    // Direct commit to default branch — no explicit branch arg.
    const callArgs = mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    expect(callArgs.branch).toBeUndefined();
  });

  it('commits the tier2-smoke workflow file when missing', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'tier2-smoke');
    await expect(installWorkflow(fd)).resolves.toBeUndefined();

    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '.github/workflows/dev-agent-tier2-smoke.yml',
      }),
    );
  });

  it('commits the swarm-override workflow file when missing', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'swarm-override');
    await expect(installWorkflow(fd)).resolves.toBeUndefined();

    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '.github/workflows/dev-agent-swarm-override.yml',
      }),
    );
    // Direct commit to default branch — no explicit branch arg.
    const callArgs = mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    expect(callArgs.branch).toBeUndefined();
    // Embedded content makes it onto the wire — the audit-anchor token
    // is the load-bearing part of the override workflow.
    const decoded = Buffer.from(callArgs.content, 'base64').toString('utf8');
    expect(decoded).toContain('<!-- dev-agent:event:b64 ');
    expect(decoded).toContain('override_type:"swarm-override"');
  });

  it('targets the correct path for each workflow key', async () => {
    const cases: Array<[string, string]> = [
      ['bug-scout', '.github/workflows/dev-agent-bug-scout.yml'],
      ['unfinished-work', '.github/workflows/dev-agent-unfinished-work-scout.yml'],
      ['cleanup', '.github/workflows/dev-agent-cleanup-scout.yml'],
      ['verification', '.github/workflows/dev-agent-verification.yml'],
      ['tier2-smoke', '.github/workflows/dev-agent-tier2-smoke.yml'],
      ['swarm-override', '.github/workflows/dev-agent-swarm-override.yml'],
    ];
    const { installWorkflow } = await import('@/lib/actions');

    for (const [key, expectedPath] of cases) {
      mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
      mockOctokit.repos.getContent.mockRejectedValue(notFound());
      mockOctokit.repos.createOrUpdateFileContents.mockClear();
      mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

      const fd = new FormData();
      fd.append('repo', 'q/r');
      fd.append('workflow', key);
      await installWorkflow(fd);

      expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
        expect.objectContaining({ path: expectedPath }),
      );
    }
  });

  it('commits the verification workflow file when missing', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'verification');
    await expect(installWorkflow(fd)).resolves.toBeUndefined();

    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '.github/workflows/dev-agent-verification.yml',
      }),
    );
  });

  it('returns an error when the workflow is already installed (idempotency guard)', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    // File already exists.
    mockOctokit.repos.getContent.mockResolvedValueOnce({ data: { type: 'file' } });

    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'bug-scout');
    await expect(installWorkflow(fd)).resolves.toEqual({
      error: expect.stringMatching(/already installed/),
    });
    expect(mockOctokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('returns an error for an unknown workflow key (validates input)', async () => {
    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'not-a-real-scout');
    await expect(installWorkflow(fd)).resolves.toEqual({
      error: expect.stringMatching(/unknown workflow/),
    });
    expect(mockOctokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('returns a write-permission error when the user lacks write', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'bug-scout');
    await expect(installWorkflow(fd)).resolves.toEqual({
      error: expect.stringMatching(/lacks write/),
    });
    expect(mockOctokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("uses the repo's actual default branch, not a form-supplied value", async () => {
    // No `default_branch` form input is read — server resolves via repos.get.
    // Verify the probe + commit target the repo's actual default ('develop').
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'develop' } });
    mockOctokit.repos.getContent.mockRejectedValue(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'cleanup');
    await installWorkflow(fd);

    expect(mockOctokit.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'develop' }),
    );
  });
});

describe('resolveProposalAction', () => {
  it('rejects when the proposal_id has no owner/repo segment', async () => {
    const { resolveProposalAction } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('proposal_id', 'no-route-here');
    await expect(resolveProposalAction(fd)).rejects.toThrow(/doesn't include owner\/repo/);
  });

  it('refuses without write permission on the routed repo', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { resolveProposalAction } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('proposal_id', 'bug_scout_finding:q/r:42');
    await expect(resolveProposalAction(fd)).rejects.toThrow(/lacks write/);
  });

  it('routes bug_scout_finding to the issue-close path', async () => {
    mockOctokit.issues.createComment.mockResolvedValueOnce({});
    mockOctokit.issues.update.mockResolvedValueOnce({});
    const { resolveProposalAction } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('proposal_id', 'bug_scout_finding:q/r:42');
    await resolveProposalAction(fd);
    expect(mockOctokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'q', repo: 'r', issue_number: 42 }),
    );
    expect(mockOctokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, state: 'closed' }),
    );
  });

  it('forwards meta_plan_file + meta_line for unfinished_plan ids', async () => {
    const planContent = '# Plan\n\n- [ ] do thing\n';
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockResolvedValueOnce({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(planContent).toString('base64'),
        sha: 'sha-abc',
      },
    });
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValueOnce({});

    const { resolveProposalAction } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('proposal_id', 'unfinished_plan:q/r:plan#L3');
    fd.append('meta_plan_file', 'docs/plans/plan.md');
    fd.append('meta_line', '3');
    await resolveProposalAction(fd);

    const writeCall = mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    const decoded = Buffer.from(writeCall.content, 'base64').toString('utf8');
    expect(decoded).toContain('- [x] do thing');
  });
});

describe('redispatchPhase', () => {
  it('dispatches the chosen phase + invocation_mode on the repo default branch', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'develop' } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});

    const { redispatchPhase } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'staging-deploy');
    fd.append('invocation_mode', 'stub');

    const result = await redispatchPhase(fd);
    expect(result).toBeUndefined();
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'q',
      repo: 'r',
      workflow_id: 'dev-agent.yml',
      ref: 'develop',
      inputs: { phase: 'staging-deploy', issue_number: '42', invocation_mode: 'stub' },
    });
  });

  it('rejects unknown phase', async () => {
    const { redispatchPhase } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'eat-cake');
    fd.append('invocation_mode', 'live');
    const result = await redispatchPhase(fd);
    expect((result as { error: string }).error).toMatch(/unknown phase/);
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('rejects unknown invocation_mode', async () => {
    const { redispatchPhase } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'implement');
    fd.append('invocation_mode', 'evil');
    const result = await redispatchPhase(fd);
    expect((result as { error: string }).error).toMatch(/unknown invocation_mode/);
  });

  it('returns error (does not throw) when dispatch fails', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.actions.createWorkflowDispatch.mockRejectedValueOnce(
      Object.assign(new Error('Resource not accessible'), { status: 403 }),
    );
    const { redispatchPhase } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'implement');
    fd.append('invocation_mode', 'live');
    const result = await redispatchPhase(fd);
    expect((result as { error: string }).error).toMatch(/Resource not accessible/);
  });

  it('refuses without write permission', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { redispatchPhase } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'implement');
    fd.append('invocation_mode', 'live');
    const result = await redispatchPhase(fd);
    expect((result as { error: string }).error).toMatch(/lacks write/);
  });
});

describe('cancelRun', () => {
  it('cancels a running workflow on the repo', async () => {
    mockOctokit.actions.cancelWorkflowRun.mockResolvedValueOnce({});
    const { cancelRun } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('run_id', '999');
    const result = await cancelRun(fd);
    expect(result).toBeUndefined();
    expect(mockOctokit.actions.cancelWorkflowRun).toHaveBeenCalledWith({
      owner: 'q',
      repo: 'r',
      run_id: 999,
    });
  });

  it('rejects bad run_id', async () => {
    const { cancelRun } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('run_id', 'not-a-number');
    const result = await cancelRun(fd);
    expect((result as { error: string }).error).toMatch(/run_id must be a positive integer/);
  });

  it('rejects partially-numeric run_id (parseInt would silently coerce)', async () => {
    // Without strict validation, "12oops" would parseInt to 12 and
    // we'd cancel the wrong run. The reviewer flagged this as a
    // wrong-target hazard; lock it down with a regression test.
    const { cancelRun } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('run_id', '12oops');
    const result = await cancelRun(fd);
    expect((result as { error: string }).error).toMatch(/run_id must be a positive integer/);
    expect(mockOctokit.actions.cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it('refuses without write permission', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { cancelRun } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('run_id', '999');
    const result = await cancelRun(fd);
    expect((result as { error: string }).error).toMatch(/lacks write/);
  });
});

describe('mergeFeaturePR', () => {
  it('squashes by default', async () => {
    mockOctokit.pulls.merge.mockResolvedValueOnce({});
    const { mergeFeaturePR } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('pr_number', '50');
    const result = await mergeFeaturePR(fd);
    expect(result).toBeUndefined();
    expect(mockOctokit.pulls.merge).toHaveBeenCalledWith({
      owner: 'q',
      repo: 'r',
      pull_number: 50,
      merge_method: 'squash',
    });
  });

  it('honors merge_method override', async () => {
    mockOctokit.pulls.merge.mockResolvedValueOnce({});
    const { mergeFeaturePR } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('pr_number', '50');
    fd.append('merge_method', 'rebase');
    await mergeFeaturePR(fd);
    expect(mockOctokit.pulls.merge.mock.calls[0][0].merge_method).toBe('rebase');
  });

  it('returns helpful error on 405 not-mergeable', async () => {
    mockOctokit.pulls.merge.mockRejectedValueOnce(
      Object.assign(new Error('Pull Request is not mergeable'), { status: 405 }),
    );
    const { mergeFeaturePR } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('pr_number', '50');
    const result = await mergeFeaturePR(fd);
    expect((result as { error: string }).error).toMatch(/PR cannot be merged \(405\)/);
  });

  it('rejects unknown merge_method', async () => {
    const { mergeFeaturePR } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('pr_number', '50');
    fd.append('merge_method', 'wat');
    const result = await mergeFeaturePR(fd);
    expect((result as { error: string }).error).toMatch(/unknown merge_method/);
  });

  it('refuses without write permission', async () => {
    // Same security gate as dispatchExistingIssue / cancelRun /
    // redispatchPhase — the action calls assertWritePermission
    // before mutating, and a read-only collaborator must be turned
    // away before pulls.merge fires.
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { mergeFeaturePR } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('pr_number', '50');
    const result = await mergeFeaturePR(fd);
    expect((result as { error: string }).error).toMatch(/lacks write/);
    expect(mockOctokit.pulls.merge).not.toHaveBeenCalled();
  });
});
