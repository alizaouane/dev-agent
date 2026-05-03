import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockOctokit = {
  repos: { getCollaboratorPermissionLevel: vi.fn() },
  issues: {
    create: vi.fn(),
    get: vi.fn(),
    setLabels: vi.fn(),
    createComment: vi.fn(),
    update: vi.fn(),
  },
  actions: { createWorkflowDispatch: vi.fn() },
};

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

beforeEach(() => {
  vi.clearAllMocks();
  mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValue({ data: { permission: 'write' } });
});

afterEach(() => vi.restoreAllMocks());

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
});
