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
  },
  git: {
    getRef: vi.fn(),
    createRef: vi.fn(),
    updateRef: vi.fn(),
  },
  pulls: {
    list: vi.fn(),
    create: vi.fn(),
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

function notFound() {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

describe('wireUpRepo', () => {

  it('opens a PR on a normal repo (default branch tip exists)', async () => {
    // Repo is not yet wired up, has commits on main, no existing wire-up PR.
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'abc123' } } });
    mockOctokit.pulls.list.mockResolvedValueOnce({ data: [] });
    mockOctokit.git.createRef.mockResolvedValueOnce({});
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});
    mockOctokit.pulls.create.mockResolvedValueOnce({
      data: { html_url: 'https://github.com/qualiency/test-repo/pull/99' },
    });

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'qualiency');
    fd.append('repo', 'test-repo');
    fd.append('default_branch', 'main');

    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:.*\/pull\/99/);
    }

    // Branch was created from the resolved tip SHA.
    expect(mockOctokit.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'refs/heads/chore/wire-up-dev-agent', sha: 'abc123' }),
    );
    // All template files (.dev-agent.yml, workflow, pm.md) were committed
    // via the wire-up branch.
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(3);
    expect(mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0]).toMatchObject({
      branch: 'chore/wire-up-dev-agent',
    });
    // PR was opened.
    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ head: 'chore/wire-up-dev-agent', base: 'main' }),
    );
  });

  it('falls back to direct commit on the default branch for an empty repo', async () => {
    // Empty repo: getContent for .dev-agent.yml 404s (good — not yet wired
    // up), AND getRef for heads/main also 404s (the default branch has no
    // commits yet). Action should commit the template files directly to
    // the default branch and skip the PR flow.
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.git.getRef.mockRejectedValueOnce(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'qualiency');
    fd.append('repo', 'fresh-empty-repo');
    fd.append('default_branch', 'main');

    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:https:\/\/github\.com\/qualiency\/fresh-empty-repo$/);
    }

    // Template files were committed WITHOUT a `branch` parameter, so they
    // hit the repo's default branch (creating it if needed).
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(3);
    for (const call of mockOctokit.repos.createOrUpdateFileContents.mock.calls) {
      expect(call[0].branch).toBeUndefined();
    }
    // No branch + no PR was created on the empty-repo path.
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('redirects to an existing wire-up PR rather than failing', async () => {
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'abc' } } });
    mockOctokit.pulls.list.mockResolvedValueOnce({
      data: [{ html_url: 'https://github.com/q/r/pull/7' }],
    });

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    fd.append('default_branch', 'main');

    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:.*\/pull\/7/);
    }
    // Should NOT have tried to create a new branch or PR.
    expect(mockOctokit.git.createRef).not.toHaveBeenCalled();
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('refuses to wire up an already-wired repo', async () => {
    // .dev-agent.yml already exists on the default branch.
    mockOctokit.repos.getContent.mockResolvedValueOnce({ data: { type: 'file' } });

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'already-wired');
    fd.append('default_branch', 'main');
    await expect(wireUpRepo(fd)).rejects.toThrow(/already wired up/);
  });

  it('refuses without write permission', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    await expect(wireUpRepo(fd)).rejects.toThrow(/lacks write/);
  });
});

describe('approveAndStart', () => {
  it('files an issue with the agreed scope and dispatches the implement workflow', async () => {
    mockOctokit.issues.create.mockResolvedValueOnce({ data: { number: 77 } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});

    const { approveAndStart } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('title', 'Add refunds');
    fd.append(
      'pm_final_message',
      [
        'Sounds good. Here is the scope.',
        '',
        '## Agreed scope',
        '',
        'Add a refund button to the booking-detail page.',
        'Stripe API only — no UI for partial refunds in this iteration.',
      ].join('\n'),
    );

    try {
      await approveAndStart(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/features\/77/);
    }

    expect(mockOctokit.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        title: 'Add refunds',
        labels: ['kind:user-intent', 'state:implementing'],
      }),
    );
    // Issue body must contain the agreed-scope content so the implement
    // agent has something to read.
    const createCall = mockOctokit.issues.create.mock.calls[0][0];
    expect(createCall.body).toContain('Add a refund button to the booking-detail page.');

    // Workflow dispatched with phase=implement against the consumer's
    // wrapper workflow.
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        workflow_id: 'dev-agent.yml',
        ref: 'main',
        inputs: {
          phase: 'implement',
          issue_number: '77',
          invocation_mode: 'live',
        },
      }),
    );
  });

  it('refuses when the PM message has no "## Agreed scope" section', async () => {
    const { approveAndStart } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('title', 'Something');
    fd.append('pm_final_message', 'Sure, let me know more about how this fits with...');
    await expect(approveAndStart(fd)).rejects.toThrow(/Agreed scope.*not converged/);
    // No issue created, no workflow dispatched.
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('refuses without write permission on the target repo', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { approveAndStart } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('title', 'Anything');
    fd.append(
      'pm_final_message',
      '## Agreed scope\n\nA real scope block to clear the converged check.',
    );
    await expect(approveAndStart(fd)).rejects.toThrow(/lacks write/);
  });
});

describe('applyPmMdUpdate', () => {
  it('opens a PR replacing .dev-agent/pm.md with the proposed content', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({
      data: { default_branch: 'main' },
    });
    mockOctokit.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'tip' } } });
    mockOctokit.repos.getContent.mockResolvedValueOnce({
      data: { sha: 'old-pm-sha', content: 'irrelevant', encoding: 'base64' },
    });
    mockOctokit.git.createRef.mockResolvedValueOnce({});
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValueOnce({});
    mockOctokit.pulls.create.mockResolvedValueOnce({
      data: { html_url: 'https://github.com/q/r/pull/12' },
    });

    const { applyPmMdUpdate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('new_content', '---\ngoals: {}\n---\n\nUpdated body.');
    fd.append('summary', 'chore(pm.md): record refund decision');

    try {
      await applyPmMdUpdate(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:.*\/pull\/12/);
    }

    // Branch was created off main tip.
    expect(mockOctokit.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'tip' }),
    );
    // The branch name carries a date-stamp prefix.
    const refArg = mockOctokit.git.createRef.mock.calls[0][0];
    expect(refArg.ref).toMatch(/^refs\/heads\/chore\/pm-md-update-\d{4}-\d{2}-\d{2}T/);

    // File was committed with the existing sha (so the API treats it as
    // an update rather than a create-conflict).
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '.dev-agent/pm.md',
        sha: 'old-pm-sha',
        message: 'chore(pm.md): record refund decision',
      }),
    );

    expect(mockOctokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        head: refArg.ref.replace('refs/heads/', ''),
        base: 'main',
        title: 'chore(pm.md): record refund decision',
      }),
    );
  });

  it('creates the file fresh when pm.md does not yet exist on the default branch', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({
      data: { default_branch: 'main' },
    });
    mockOctokit.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'tip' } } });
    // 404 on getContent — no existing pm.md
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.git.createRef.mockResolvedValueOnce({});
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValueOnce({});
    mockOctokit.pulls.create.mockResolvedValueOnce({
      data: { html_url: 'https://github.com/q/r/pull/13' },
    });

    const { applyPmMdUpdate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('new_content', 'fresh content');

    try {
      await applyPmMdUpdate(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__/);
    }

    // No `sha` arg means the API will create rather than update.
    const fileArg = mockOctokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    expect(fileArg.sha).toBeUndefined();
  });

  it('rejects empty new_content', async () => {
    const { applyPmMdUpdate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('new_content', '   ');
    await expect(applyPmMdUpdate(fd)).rejects.toThrow(/empty/);
  });

  it('refuses without write permission', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { applyPmMdUpdate } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('new_content', 'content');
    await expect(applyPmMdUpdate(fd)).rejects.toThrow(/lacks write/);
  });

  it('pushes ANTHROPIC_API_KEY to the repo when the dashboard env is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'abc' } } });
    mockOctokit.pulls.list.mockResolvedValueOnce({ data: [] });
    mockOctokit.git.createRef.mockResolvedValueOnce({});
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});
    mockOctokit.pulls.create.mockResolvedValueOnce({
      data: { html_url: 'https://github.com/q/r/pull/1' },
    });

    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    (pushRepoSecret as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    fd.append('default_branch', 'main');
    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__/);
    }

    expect(pushRepoSecret).toHaveBeenCalledWith({
      octokit: expect.anything(),
      owner: 'q',
      repo: 'r',
      name: 'ANTHROPIC_API_KEY',
      value: 'sk-ant-test',
    });
    // PR body should reflect the auto-push.
    const prBody = mockOctokit.pulls.create.mock.calls[0][0].body as string;
    expect(prBody).toMatch(/pushed to this repo's Actions secrets automatically/);
  });

  it('falls back gracefully when ANTHROPIC_API_KEY is not configured on the dashboard', async () => {
    // No env var set.
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'abc' } } });
    mockOctokit.pulls.list.mockResolvedValueOnce({ data: [] });
    mockOctokit.git.createRef.mockResolvedValueOnce({});
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});
    mockOctokit.pulls.create.mockResolvedValueOnce({
      data: { html_url: 'https://github.com/q/r/pull/2' },
    });

    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    (pushRepoSecret as ReturnType<typeof vi.fn>).mockClear();

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    fd.append('default_branch', 'main');
    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__/);
    }

    // pushRepoSecret should NOT have been called — no key to push.
    expect(pushRepoSecret).not.toHaveBeenCalled();
    // PR body should explain the manual step.
    const prBody = mockOctokit.pulls.create.mock.calls[0][0].body as string;
    expect(prBody).toMatch(/NOT auto-pushed/);
  });

  it('still opens the PR when secret-push fails (e.g. user lacks admin perm)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.git.getRef.mockResolvedValueOnce({ data: { object: { sha: 'abc' } } });
    mockOctokit.pulls.list.mockResolvedValueOnce({ data: [] });
    mockOctokit.git.createRef.mockResolvedValueOnce({});
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});
    mockOctokit.pulls.create.mockResolvedValueOnce({
      data: { html_url: 'https://github.com/q/r/pull/3' },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { pushRepoSecret } = await import('@/lib/gh-secrets');
    (pushRepoSecret as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
    );

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'q');
    fd.append('repo', 'r');
    fd.append('default_branch', 'main');
    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__/);
    }

    // PR was still opened despite the secret-push failure.
    expect(mockOctokit.pulls.create).toHaveBeenCalled();
    // PR body explains the failure so the user knows to paste manually.
    const prBody = mockOctokit.pulls.create.mock.calls[0][0].body as string;
    expect(prBody).toMatch(/Tried to push.*automatically but failed/);
    warnSpy.mockRestore();
  });
});
