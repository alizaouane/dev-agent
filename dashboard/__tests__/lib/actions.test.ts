import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashSpecAndPlan } from '@/lib/spec-approval';
import { WIRE_UP_FILES } from '@/lib/wire-up-template';

const mockOctokit = {
  // Defaults to "no issue names this spec", so existing dispatchFromSpec cases
  // keep exercising the create path. The reuse path has its own cases below.
  // Serves both the issue listing and the strict active-run scan. Issue
  // fixtures are queued with mockResolvedValueOnce; anything else falls
  // through to the workflow runs the test has staged.
  graphql: vi.fn(
    async (): Promise<{
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ isResolved: boolean }>;
          };
        };
      };
    }> => ({
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    }),
  ),
  paginate: vi.fn(
    async () => (await mockOctokit.actions.listWorkflowRuns()).data.workflow_runs as unknown[],
  ),
  repos: {
    getCollaboratorPermissionLevel: vi.fn(),
    getContent: vi.fn(),
    createOrUpdateFileContents: vi.fn(),
    get: vi.fn(),
  },
  issues: {
    create: vi.fn(),
    addLabels: vi.fn(),
    createLabel: vi.fn(),
    listForRepo: vi.fn(),
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

// The dashboard's own allowlist. `pushDashboardSecrets` writes the
// DASHBOARD's credentials into the named repo, so the allowlist — not the
// caller's write permission — is what bounds the target.
const mockListAllowedRepos = vi.fn();
vi.mock('@/lib/repos', () => ({
  listAllowedRepos: (...args: unknown[]) => mockListAllowedRepos(...args),
}));

// wireUpRepo also consults it, to check no other managed repo's name collapses
// to the same per-repo env var suffix. Default to a single, unambiguous repo.
beforeEach(() => {
  mockListAllowedRepos.mockResolvedValue([{ owner: 'x', name: 'y', wired_up: true }]);
});

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
  beforeEach(() => {
    // Approving dispatches a phase, and the dispatch is guarded by the
    // strict active-run check. Default to a repo with nothing in flight.
    mockOctokit.actions.listWorkflowRuns.mockResolvedValue({
      data: { workflow_runs: [], total_count: 0 },
    });
  });

  it('promotes spec-ready → implementing', async () => {
    // Approving now also runs the approval check and dispatches the phase,
    // so the fixture needs an approved spec on the branch.
    stubApprovedSpecOnBranch();
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:user-intent' }],
        body: APPROVED_BODY,
      },
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

  it('dispatches implement when it approves spec-ready', async () => {
    // The label says work started. Without the dispatch nothing runs, so the
    // issue sits at state:implementing with no run behind it — a state label
    // reporting something that never happened.
    stubApprovedSpecOnBranch();
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 5,
        labels: [{ name: 'state:spec-ready' }],
        body: APPROVED_BODY,
        html_url: 'https://github.com/q/r/issues/5',
      },
    });
    const { approveGate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '5');
    fd.append('promote', '0');
    await approveGate(fd);
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_id: 'dev-agent.yml',
        inputs: expect.objectContaining({ phase: 'implement', issue_number: '5' }),
      }),
    );
  });

  it('refuses to approve a spec-ready issue with no recorded approval', async () => {
    // Every other route into implement checks this. An unchecked one beside
    // them is a second front door standing next to a locked one.
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockImplementation(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 5,
        labels: [{ name: 'state:spec-ready' }],
        body: APPROVED_BODY,
        html_url: 'https://github.com/q/r/issues/5',
      },
    });
    const { approveGate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '5');
    fd.append('promote', '0');
    await expect(approveGate(fd)).rejects.toThrow(/work cannot start/);
    expect(mockOctokit.issues.setLabels).not.toHaveBeenCalled();
  });

  it('dispatches the staging deploy when it approves pr-review', async () => {
    // state:staging-deployed claims a deployment. Flipping the label without
    // dispatching the phase makes the claim without doing the deploy.
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 7,
        labels: [{ name: 'state:pr-review' }],
        html_url: 'https://github.com/q/r/issues/7',
      },
    });
    const { approveGate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '7');
    fd.append('promote', '0');
    await approveGate(fd);
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: expect.objectContaining({ phase: 'staging-deploy', issue_number: '7' }),
      }),
    );
  });

  it('dispatches the promotion when it approves ready-to-promote', async () => {
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 9,
        labels: [{ name: 'state:ready-to-promote' }],
        html_url: 'https://github.com/q/r/issues/9',
      },
    });
    const { approveGate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '9');
    fd.append('promote', '1');
    await approveGate(fd);
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: expect.objectContaining({ phase: 'promote-to-prod', issue_number: '9' }),
      }),
    );
  });

  it('refuses when a run is already in flight for the issue', async () => {
    // Every other dispatch route checks this. A new one beside them without
    // the guard puts a second agent on a branch already being worked.
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 7,
        labels: [{ name: 'state:pr-review' }],
        html_url: 'https://github.com/q/r/issues/7',
      },
    });
    const inFlight = [
      {
        id: 1,
        status: 'in_progress',
        display_title: 'staging-deploy → issue #7 (live)',
        html_url: 'https://github.com/q/r/actions/runs/1',
        created_at: new Date().toISOString(),
      },
    ];
    mockOctokit.actions.listWorkflowRuns.mockResolvedValueOnce({
      data: { workflow_runs: inFlight, total_count: 1 },
    });
    mockOctokit.paginate.mockResolvedValueOnce(inFlight);
    const { approveGate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '7');
    fd.append('promote', '0');
    await expect(approveGate(fd)).rejects.toThrow(/active run/);
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(mockOctokit.issues.setLabels).not.toHaveBeenCalled();
  });

  it('leaves the state alone when the dispatch fails', async () => {
    // A label flipped past a dispatch that never landed is the same lie in
    // the other direction: the issue reports progress nothing is making.
    mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 7,
        labels: [{ name: 'state:pr-review' }],
        html_url: 'https://github.com/q/r/issues/7',
      },
    });
    mockOctokit.actions.createWorkflowDispatch.mockRejectedValueOnce(
      Object.assign(new Error('workflow not found'), { status: 404 }),
    );
    const { approveGate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '7');
    fd.append('promote', '0');
    await expect(approveGate(fd)).rejects.toThrow();
    expect(mockOctokit.issues.setLabels).not.toHaveBeenCalled();
  });
});

// --- Approved-spec fixture ---------------------------------------------
// `dispatchExistingIssue` and `dispatchFromSpec` both refuse to start work
// they cannot tie back to a committed, hash-matched approval. These tests
// are about the dispatch mechanics, so they run against a repo where that
// approval is in place; `spec-approval-gate.test.ts` covers the refusals.
const APPROVED_SPEC = 'docs/superpowers/specs/2026-05-01-foo-design.md';
const APPROVED_PLAN = 'docs/superpowers/plans/2026-05-01-foo.md';
const APPROVED_APPROVAL = 'docs/superpowers/specs/2026-05-01-foo-design.approval.json';
const APPROVED_SPEC_TEXT = '# Foo\n\nAC-1: it works.\n';
const APPROVED_PLAN_TEXT = '# Plan\n\nTask 1 (AC: 1)\n';
const APPROVED_BODY = `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`;

/**
 * Point `repos.getContent` at a repo holding the spec, the plan, and a
 * matching approval. Responses carry both `type` (for the existence probes)
 * and `content` (for the gate's hash check).
 */
function stubApprovedSpecOnBranch(): void {
  const files: Record<string, string> = {
    [APPROVED_SPEC]: APPROVED_SPEC_TEXT,
    [APPROVED_PLAN]: APPROVED_PLAN_TEXT,
    [APPROVED_APPROVAL]: JSON.stringify({
      schema_version: 1,
      spec_path: APPROVED_SPEC,
      plan_path: APPROVED_PLAN,
      spec_sha256: hashSpecAndPlan(APPROVED_SPEC_TEXT, APPROVED_PLAN_TEXT),
      review_verdict: 'ok',
      review_rounds: 1,
      approved_by: 'tester@example.com',
      approved_at: '2026-05-01T00:00:00.000Z',
    }),
  };
  mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
    const content = files[path];
    if (content === undefined) {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    }
    return {
      data: { type: 'file', content: Buffer.from(content, 'utf8').toString('base64') },
    };
  });
}

describe('dispatchExistingIssue', () => {
  beforeEach(() => {
    stubApprovedSpecOnBranch();
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 42,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
        body: APPROVED_BODY,
        html_url: 'https://github.com/x/y/issues/42',
        state: 'open',
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
      data: { workflow_runs: [], total_count: 0 },
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
        state: 'open',
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

  it('refuses to start work on a spec with no recorded approval', async () => {
    // The wiring guard: `state:spec-ready` alone must not be enough. Without
    // this the gate could be deleted from the action and every other test
    // here would still pass.
    mockOctokit.repos.getContent.mockImplementation(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('issue', '42');
    const { dispatchExistingIssue } = await import('@/lib/actions');
    const result = await dispatchExistingIssue(fd);
    expect(result).toEqual({
      error: expect.stringContaining('work cannot start'),
      issue_url: 'https://github.com/x/y/issues/42',
    });
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(mockOctokit.issues.setLabels).not.toHaveBeenCalled();
  });

  it('refuses once the spec has been edited since it was approved', async () => {
    stubApprovedSpecOnBranch();
    const stale = mockOctokit.repos.getContent.getMockImplementation()!;
    mockOctokit.repos.getContent.mockImplementation(async (args: { path: string }) => {
      if (args.path !== APPROVED_SPEC) return stale(args);
      return {
        data: {
          type: 'file',
          content: Buffer.from(APPROVED_SPEC_TEXT + 'AC-2: sneaked in.\n', 'utf8').toString(
            'base64',
          ),
        },
      };
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('issue', '42');
    const { dispatchExistingIssue } = await import('@/lib/actions');
    const result = await dispatchExistingIssue(fd);
    expect(result).toEqual({
      error: expect.stringContaining('changed after approval'),
      issue_url: 'https://github.com/x/y/issues/42',
    });
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
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
        body: APPROVED_BODY,
        html_url: 'https://github.com/x/y/issues/42',
        state: 'open',
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
    // Spec, plan, and a matching approval all present on the default branch.
    stubApprovedSpecOnBranch();
    mockOctokit.issues.create.mockResolvedValue({
      data: {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
      },
    });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValue({});
    mockOctokit.issues.setLabels.mockResolvedValue({});
    mockOctokit.actions.listWorkflowRuns.mockResolvedValue({
      data: { workflow_runs: [], total_count: 0 },
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

  it('refuses to file an issue for a spec with no recorded approval', async () => {
    // This panel files AND dispatches in one step, so the gate runs before
    // `issues.create` — a refusal must not leave an orphan spec-ready issue.
    mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === APPROVED_APPROVAL) {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }
      return { data: { type: 'file', content: Buffer.from('x', 'utf8').toString('base64') } };
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual({ error: expect.stringContaining('work cannot start') });
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('dispatches the issue intake already filed instead of a second one', async () => {
    // Both intake skills file a state:spec-ready issue when they record the
    // approval, and that issue tells you to press this button. Creating
    // another started duplicate work and stranded the original in the queue.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:bug' }, { name: 'quick-dev' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    await expect(dispatchFromSpec(fd)).rejects.toThrow(/__redirect__:/);
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: expect.objectContaining({ issue_number: '77' }) }),
    );
  });

  it('keeps a reused issue kind and drops only its state label', async () => {
    // Overwriting with a hardcoded kind:feature would relabel a bug as a
    // feature on the way past, and lose the quick-dev provenance marker.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:bug' }, { name: 'quick-dev' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    await expect(dispatchFromSpec(fd)).rejects.toThrow(/__redirect__:/);
    expect(mockOctokit.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['kind:bug', 'quick-dev', 'state:implementing'] }),
    );
  });

  it('refuses to re-dispatch an issue that has already moved past spec-ready', async () => {
    // Reuse made this the same operation as dispatchExistingIssue, so it needs
    // the same guard: without it the button queued a second implement run onto
    // a feature branch that already had work on it.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:implementing' }, { name: 'kind:feature' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining('state:implementing') }),
    );
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('refuses when a run is already in flight for the reused issue', async () => {
    // A previous click whose dispatch succeeded but whose label flip failed
    // leaves the issue at spec-ready with a run going. The label alone lies.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
      },
    ]);
    const inFlight = [
      {
        id: 1,
        status: 'in_progress',
        display_title: 'implement → issue #77 (live)',
        html_url: 'https://github.com/x/y/actions/runs/1',
        created_at: new Date().toISOString(),
      },
    ];
    mockOctokit.actions.listWorkflowRuns.mockResolvedValueOnce({
      data: { workflow_runs: inFlight, total_count: 1 },
    });
    mockOctokit.paginate.mockResolvedValueOnce(inFlight);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining('active run') }),
    );
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('refuses when a newer duplicate has already started, not just the oldest', async () => {
    // The duplicate this reuse exists to stop leaves an old spec-ready issue
    // beside a newer implementing one. Inspecting only the oldest clears the
    // guard by reading the wrong issue.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 42,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/42',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
      },
      {
        number: 91,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/91',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:implementing' }, { name: 'kind:feature' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('#91') }));
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('refuses when it cannot read the run list, rather than assuming none', async () => {
    // fetchActiveRunsForIssue returns [] on any Actions API failure, which is
    // right for a visibility panel and wrong for a dispatch guard: a transient
    // 403 would otherwise wave a second run through.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
      },
    ]);
    mockOctokit.actions.listWorkflowRuns.mockRejectedValueOnce(
      Object.assign(new Error('rate limited'), { status: 403 }),
    );
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('refuses an issue carrying both spec-ready and a started state', async () => {
    // A half-applied label flip leaves both. Testing only for spec-ready
    // being present dispatched an issue already being implemented.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'state:implementing' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('#77') }));
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('brings a reused issue naming a stale plan in line with the approval', async () => {
    // The plan moved between the supported trees after the issue was filed.
    // Gating the stale body produced a path-mismatch refusal the user could
    // neither see nor fix from the dashboard.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: docs/plans/stale.md\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
      },
    ]);
    mockOctokit.issues.update.mockResolvedValue({});
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    await expect(dispatchFromSpec(fd)).rejects.toThrow(/__redirect__:/);
    const updated = mockOctokit.issues.update.mock.calls.at(-1)![0].body as string;
    expect(updated).toContain(`Plan: ${APPROVED_PLAN}`);
    expect(updated).not.toContain('docs/plans/stale.md');
  });

  it('prefers the issue that already names the approved pair', async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 42,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/42',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: docs/plans/stale.md\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
      },
      {
        number: 91,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/91',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    await expect(dispatchFromSpec(fd)).rejects.toThrow(/__redirect__:/);
    expect(mockOctokit.issues.update).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: expect.objectContaining({ issue_number: '91' }) }),
    );
  });

  it('refuses a spec whose issue is closed, rather than shipping it twice', async () => {
    // The approval artifact outlives the pipeline, so nothing on disk says
    // this spec already landed. Its closed issue is the only record.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 12,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/12',
        state: 'closed',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:done' }, { name: 'kind:feature' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('closed') }));
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('leaves a stale issue body alone when the gate refuses the dispatch', async () => {
    // Rewriting first meant a refused Start work left the handoff issue
    // pointing at a pair nobody had approved.
    mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === APPROVED_APPROVAL) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { data: { type: 'file', content: Buffer.from('x', 'utf8').toString('base64') } };
    });
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: docs/plans/stale.md\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Foo feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    const result = await dispatchFromSpec(fd);
    expect(result).toEqual({ error: expect.stringContaining('work cannot start') });
    expect(mockOctokit.issues.update).not.toHaveBeenCalled();
  });

  it('renames a reused issue when the user typed a different title', async () => {
    // The panel presents the field on both paths; ignoring it on the reuse
    // path meant the title most people type silently did nothing.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
      },
    ]);
    mockOctokit.issues.update.mockResolvedValue({});
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'A better title');
    fd.append('custom_title', 'A better title');
    const { dispatchFromSpec } = await import('@/lib/actions');
    await expect(dispatchFromSpec(fd)).rejects.toThrow(/__redirect__:/);
    expect(mockOctokit.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 77, title: 'A better title' }),
    );
  });

  it('leaves a reused issue title alone when the box was left blank', async () => {
    // The fallback title is the spec's name, not a choice anyone made.
    // Renaming on the strength of it is an edit the user did not ask for.
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Spec: ${APPROVED_SPEC}\nPlan: ${APPROVED_PLAN}\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', APPROVED_PLAN);
    fd.append('title', 'Approved spec');
    fd.append('custom_title', '');
    const { dispatchFromSpec } = await import('@/lib/actions');
    await expect(dispatchFromSpec(fd)).rejects.toThrow(/__redirect__:/);
    expect(mockOctokit.issues.update).not.toHaveBeenCalled();
  });

  it('starts a planless spec, which quick-dev produces and the picker offers', async () => {
    // Requiring a plan made every "(no plan)" option unstartable while the
    // picker presented it as ready — a choice that could only fail.
    mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === APPROVED_PLAN) throw Object.assign(new Error('Not Found'), { status: 404 });
      const files: Record<string, string> = {
        [APPROVED_SPEC]: APPROVED_SPEC_TEXT,
        [APPROVED_APPROVAL]: JSON.stringify({
          schema_version: 1,
          spec_path: APPROVED_SPEC,
          plan_path: null,
          spec_sha256: hashSpecAndPlan(APPROVED_SPEC_TEXT, null),
          review_verdict: 'ok',
          review_rounds: 1,
          approved_by: 'tester@example.com',
          approved_at: '2026-05-01T00:00:00.000Z',
        }),
      };
      const content = files[path];
      if (content === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { data: { type: 'file', content: Buffer.from(content, 'utf8').toString('base64') } };
    });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('spec_path', APPROVED_SPEC);
    fd.append('plan_path', '');
    fd.append('title', 'Planless feature');
    const { dispatchFromSpec } = await import('@/lib/actions');
    await expect(dispatchFromSpec(fd)).rejects.toThrow(/__redirect__:/);
    const body = mockOctokit.issues.create.mock.calls.at(-1)![0].body as string;
    // The Plan line is omitted rather than left blank: the workflow and the
    // gate both read it, and an empty one names a plan that is not there.
    expect(body).toContain(`Spec: ${APPROVED_SPEC}`);
    expect(body).not.toContain('Plan:');
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
      data: { workflow_runs: [], total_count: 0 },
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
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(WIRE_UP_FILES.length);
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

    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(WIRE_UP_FILES.length);
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
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(WIRE_UP_FILES.length);
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
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(WIRE_UP_FILES.length);
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
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(WIRE_UP_FILES.length);
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
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(WIRE_UP_FILES.length);

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

  it('refuses when the installed file is already up to date', async () => {
    const { INSTALLABLE_WORKFLOWS } = await import('@/lib/wire-up-template');
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockResolvedValueOnce({
      data: {
        type: 'file',
        sha: 'existing-sha',
        content: Buffer.from(INSTALLABLE_WORKFLOWS['bug-scout'].content, 'utf8').toString('base64'),
      },
    });

    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'bug-scout');
    await expect(installWorkflow(fd)).resolves.toEqual({
      error: expect.stringMatching(/up to date/),
    });
    expect(mockOctokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('upgrades an installed file whose content has changed', async () => {
    // A wrapper is the caller of a reusable workflow, so it caps that
    // workflow's token permissions. Refusing every existing file left
    // consumers with no way to receive a fix to a wrapper they already had —
    // which is how the missing `checks: read` would have stayed broken in
    // every repo despite being corrected in the template.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockResolvedValueOnce({
      data: {
        type: 'file',
        sha: 'stale-sha',
        content: Buffer.from('# an older version of this wrapper\n', 'utf8').toString('base64'),
      },
    });

    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'bug-scout');
    await installWorkflow(fd);
    // The sha is required on update; without it GitHub 422s mid-flow.
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'stale-sha', message: expect.stringContaining('update') }),
    );
  });

  it('does not overwrite a file it failed to read', async () => {
    // A non-404 read error must not be treated as absence: writing then would
    // clobber a file whose contents are unknown.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockRejectedValueOnce(
      Object.assign(new Error('Bad credentials'), { status: 401 }),
    );
    const { installWorkflow } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'bug-scout');
    await expect(installWorkflow(fd)).resolves.toEqual({
      error: expect.stringContaining('Bad credentials'),
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
  beforeEach(() => {
    // Re-running `implement` passes the same approval gate as Start work,
    // so these tests run against an approved issue unless they say otherwise.
    stubApprovedSpecOnBranch();
    mockOctokit.issues.get.mockResolvedValue({
      data: {
        number: 42,
        labels: [{ name: 'state:pr-review' }],
        body: APPROVED_BODY,
        html_url: 'https://github.com/q/r/issues/42',
      },
    });
  });

  it('refuses to re-run implement on an issue with no recorded approval', async () => {
    // The redispatch panel renders for an issue in any state and defaults its
    // phase select to `implement`, so it is a first-dispatch route as much as
    // a retry one. Ungated, it would be a second front door beside a locked
    // one — which is how this gate was bypassed before the guard landed.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockImplementation(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    const { redispatchPhase } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'implement');
    fd.append('invocation_mode', 'live');
    const result = await redispatchPhase(fd);
    expect((result as { error: string }).error).toMatch(/work cannot start/);
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('re-runs implement once the approval is in place', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});
    const { redispatchPhase } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'implement');
    fd.append('invocation_mode', 'live');
    expect(await redispatchPhase(fd)).toBeUndefined();
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalled();
  });

  it('marks a deliberate implement retry so the workflow gate lets it through', async () => {
    // The workflow discards a dispatch it judges overtaken, and a retry looks
    // exactly like one: past spec-ready, usually with a PR already open.
    // Without this the dashboard reported a successful dispatch that the
    // workflow then silently dropped.
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});
    mockOctokit.issues.addLabels.mockResolvedValueOnce({});
    const { redispatchPhase } = await import('@/lib/actions');
    const { FORCE_IMPLEMENT_LABEL } = await import('@/lib/find-spec-issue');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'implement');
    fd.append('invocation_mode', 'live');
    await redispatchPhase(fd);
    expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, labels: [FORCE_IMPLEMENT_LABEL] }),
    );
  });

  it('creates the retry label in a repo wired up before it existed', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});
    mockOctokit.issues.addLabels
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({});
    mockOctokit.issues.createLabel.mockResolvedValueOnce({});
    const { redispatchPhase } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'implement');
    fd.append('invocation_mode', 'live');
    await redispatchPhase(fd);
    expect(mockOctokit.issues.createLabel).toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalled();
  });

  it('does not mark the post-PR phases, which the gate never blocks', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockImplementation(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});
    const { redispatchPhase } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'staging-deploy');
    fd.append('invocation_mode', 'live');
    await redispatchPhase(fd);
    expect(mockOctokit.issues.addLabels).not.toHaveBeenCalled();
  });

  it('does not gate the post-PR phases, which act on work already shipped', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.repos.getContent.mockImplementation(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});
    const { redispatchPhase } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('issue', '42');
    fd.append('phase', 'rollback');
    fd.append('invocation_mode', 'live');
    expect(await redispatchPhase(fd)).toBeUndefined();
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalled();
  });

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
  /** One page of review threads with the given resolved states. */
  const threads = (...resolved: boolean[]) => ({
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: resolved.map((isResolved) => ({ isResolved })),
        },
      },
    },
  });

  it('refuses to merge over an unresolved review thread', async () => {
    // Handing the decision to GitHub only refuses what branch protection
    // makes it refuse, so on a repo without that rule this merged straight
    // over open review feedback.
    mockOctokit.graphql.mockResolvedValueOnce(threads(true, false));
    const { mergeFeaturePR } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('pr_number', '50');
    const result = await mergeFeaturePR(fd);
    expect(result).toEqual({ error: expect.stringContaining('unresolved') });
    expect(mockOctokit.pulls.merge).not.toHaveBeenCalled();
  });

  it('refuses when it cannot read the review threads', async () => {
    // Zero because the query failed is not zero unresolved threads.
    mockOctokit.graphql.mockRejectedValueOnce(new Error('Bad credentials'));
    const { mergeFeaturePR } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('pr_number', '50');
    const result = await mergeFeaturePR(fd);
    expect(result).toEqual({ error: expect.any(String) });
    expect(mockOctokit.pulls.merge).not.toHaveBeenCalled();
  });

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

describe('pushDashboardSecrets', () => {
  beforeEach(() => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValue({
      data: { permission: 'admin' },
    });
    mockListAllowedRepos.mockResolvedValue([
      { owner: 'x', name: 'y', wired_up: true },
      { owner: 'x', name: 'unwired', wired_up: false },
    ]);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  });

  afterEach(() => {
    if (ORIGINAL_ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
  });

  /** Submit the action for one repo. */
  async function push(repo: string) {
    const { pushDashboardSecrets } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', repo);
    return pushDashboardSecrets(fd);
  }

  it('pushes to a wired repo the dashboard manages', async () => {
    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    const result = await push('x/y');
    expect(result).toEqual({ message: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(pushRepoSecret).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'x', repo: 'y', name: 'ANTHROPIC_API_KEY' }),
    );
  });

  it('refuses a repo outside the allowlist even when the user can write to it', async () => {
    // The reason this action is not like the others: it copies the DASHBOARD's
    // credentials into the named repo. Write permission would let a signed-in
    // user name any repo they control and walk away with the Anthropic key
    // and the database URL.
    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    const result = await push('attacker/exfil');
    expect(result).toEqual({ error: expect.stringContaining("allowlist") });
    expect(pushRepoSecret).not.toHaveBeenCalled();
  });

  it('refuses a repo that is not wired up', async () => {
    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    const result = await push('x/unwired');
    expect(result).toEqual({ error: expect.stringContaining('not wired up') });
    expect(pushRepoSecret).not.toHaveBeenCalled();
  });

  it('refuses a malformed repo value without calling GitHub', async () => {
    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    for (const bad of ['justname', 'a/b/c', '/y', 'x/']) {
      expect(await push(bad)).toEqual({ error: expect.stringMatching(/owner\/name/) });
    }
    expect(pushRepoSecret).not.toHaveBeenCalled();
  });

  it('still refuses without write permission on an allowlisted repo', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    expect(await push('x/y')).toEqual({ error: expect.stringContaining('lacks write') });
  });

  it('refuses a per-repo secret when another managed repo reads the same variable', async () => {
    // `foo-bar` and `foo.bar` both collapse to X__FOO_BAR. Pushing on that
    // basis could send one repo's database URL to the other, which is the
    // exact cross-wiring the per-repo scheme exists to prevent.
    process.env['SUPABASE_DB_URL__X__FOO_BAR'] =
      'postgresql://postgres.abc:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres';
    mockListAllowedRepos.mockResolvedValue([
      { owner: 'x', name: 'foo-bar', wired_up: true },
      { owner: 'x', name: 'foo.bar', wired_up: true },
    ]);
    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    const result = await push('x/foo-bar');
    expect(result).toEqual({ message: expect.stringContaining('SUPABASE_DB_URL skipped') });
    expect(result).toEqual({ message: expect.stringContaining('x/foo.bar') });
    expect(pushRepoSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SUPABASE_DB_URL' }),
    );
    delete process.env['SUPABASE_DB_URL__X__FOO_BAR'];
  });

  it('still pushes shared secrets when a per-repo one is ambiguous', async () => {
    // One refused secret must not block the others: the Anthropic key is not
    // repo-specific, so a name collision says nothing about it.
    mockListAllowedRepos.mockResolvedValue([
      { owner: 'x', name: 'foo-bar', wired_up: true },
      { owner: 'x', name: 'foo.bar', wired_up: true },
    ]);
    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    await push('x/foo-bar');
    expect(pushRepoSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ANTHROPIC_API_KEY' }),
    );
  });

  it('revalidates the path the page is actually rendered at', async () => {
    // The route segment is the URL-encoded full name; revalidating the bare
    // repo name names a path that never renders, leaving the stale page up.
    const { revalidatePath } = await import('next/cache');
    await push('x/y');
    expect(revalidatePath).toHaveBeenCalledWith('/repos/x%2Fy');
  });

  it('reports a per-secret push failure instead of failing the whole action', async () => {
    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    vi.mocked(pushRepoSecret).mockRejectedValueOnce(
      Object.assign(new Error('Resource not accessible'), { status: 403 }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await push('x/y');
    expect(result).toEqual({ message: expect.stringContaining('skipped') });
    warnSpy.mockRestore();
  });
});
