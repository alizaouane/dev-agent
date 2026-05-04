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

function notFound() {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

describe('wireUpRepo', () => {
  it('commits template files directly to the default branch (no PR)', async () => {
    // Repo is not yet wired up.
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'qualiency');
    fd.append('repo', 'test-repo');
    fd.append('default_branch', 'main');

    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    // All three template files committed without a `branch` param, so they
    // land on the repo's default branch.
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(4);
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
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

    const { wireUpRepo } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('owner', 'qualiency');
    fd.append('repo', 'fresh-empty-repo');
    fd.append('default_branch', 'main');

    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(4);
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

  it('accepts heading variations: extra hashes, capitalization, trailing punctuation', async () => {
    mockOctokit.issues.create.mockResolvedValue({ data: { number: 100 } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValue({});

    const { approveAndStart } = await import('@/lib/actions');
    const variations = [
      '### AGREED SCOPE\n\nbuild the thing.',
      '## Agreed Scope:\n\nbuild the thing.',
      '## Agreed scope —\n\nbuild the thing.',
    ];
    for (const variant of variations) {
      mockOctokit.issues.create.mockClear();
      const fd = new FormData();
      fd.append('repo', 'q/r');
      fd.append('title', 'X');
      fd.append('pm_final_message', variant);
      try {
        await approveAndStart(fd);
      } catch (e) {
        // redirect
        if (!(e instanceof Error) || !e.message.includes('NEXT_REDIRECT') && !e.message.includes('__redirect__')) throw e;
      }
      expect(mockOctokit.issues.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('build the thing'),
        }),
      );
    }
  });

  it("stops scope extraction at the next H2-or-deeper heading (e.g. ## pm.md update doesn't bleed in)", async () => {
    mockOctokit.issues.create.mockResolvedValueOnce({ data: { number: 101 } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});

    const { approveAndStart } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('title', 'X');
    fd.append(
      'pm_final_message',
      [
        'Sounds good.',
        '',
        '## Agreed scope',
        '',
        'Build the refund button.',
        '',
        '## pm.md update',
        '',
        '```markdown',
        '---',
        'goals: { q2: "x" }',
        '---',
        '```',
      ].join('\n'),
    );
    try {
      await approveAndStart(fd);
    } catch (e) {
      // redirect
      if (!(e instanceof Error) || (!e.message.includes('NEXT_REDIRECT') && !e.message.includes('__redirect__'))) throw e;
    }
    const body = mockOctokit.issues.create.mock.calls[0][0].body as string;
    expect(body).toContain('Build the refund button.');
    // The pm.md update block must NOT be in the issue body.
    expect(body).not.toContain('pm.md update');
    expect(body).not.toContain('goals: { q2:');
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
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

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
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(4);
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
  });

  it('skips pushRepoSecret when ANTHROPIC_API_KEY is unset on the dashboard', async () => {
    // No env var.
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({});

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
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    expect(pushRepoSecret).not.toHaveBeenCalled();
    // Files still committed even without the secret.
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(4);
  });

  it('still commits files when secret-push fails (e.g. user lacks admin perm)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockOctokit.repos.getContent.mockRejectedValueOnce(notFound());
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
    fd.append('default_branch', 'main');
    try {
      await wireUpRepo(fd);
    } catch (e) {
      expect((e as Error).message).toMatch(/__redirect__:\/repos$/);
    }

    // The wire-up still landed all three files; only the secret push failed.
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(4);
    expect(mockOctokit.pulls.create).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
