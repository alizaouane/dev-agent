import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashStory } from '@/lib/story-approval';

/**
 * `dispatchFromStory` is a sibling of `dispatchFromSpec`, not a
 * generalisation of it — see `actions-dispatch-from-story` in the plan. This
 * file follows the same mocking shape as `actions.test.ts`'s `dispatchFromSpec`
 * block rather than inventing a second harness, but only wires up the pieces
 * `dispatchFromStory` actually touches.
 */

const mockOctokit = {
  // Defaults to "no issue names this story" (an empty workflow-runs list),
  // so tests that don't care about reuse keep exercising the create path.
  // The reuse path stages `paginate.mockResolvedValueOnce([...])` itself.
  paginate: vi.fn(
    async () => (await mockOctokit.actions.listWorkflowRuns()).data.workflow_runs as unknown[],
  ),
  repos: {
    getCollaboratorPermissionLevel: vi.fn(),
    getContent: vi.fn(),
    get: vi.fn(),
  },
  issues: {
    create: vi.fn(),
    get: vi.fn(),
    setLabels: vi.fn(),
    update: vi.fn(),
  },
  actions: {
    createWorkflowDispatch: vi.fn(),
    listWorkflowRuns: vi.fn(),
  },
};

vi.mock('@/lib/gh-secrets', () => ({
  pushRepoSecret: vi.fn(),
}));

vi.mock('@/lib/gh', () => ({
  getOctokit: vi.fn(() => Promise.resolve(mockOctokit)),
  getCurrentUsername: vi.fn(() => Promise.resolve('alizaouane')),
  UnauthorizedError: class extends Error {},
}));

// actions.ts imports this at module scope even though dispatchFromStory never
// calls it; unmocked, it would pull in the real './auth' (NextAuth) module.
const mockListAllowedRepos = vi.fn();
vi.mock('@/lib/repos', () => ({
  listAllowedRepos: (...args: unknown[]) => mockListAllowedRepos(...args),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`__redirect__:${url}`);
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockListAllowedRepos.mockResolvedValue([{ owner: 'x', name: 'y', wired_up: true }]);
  mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValue({
    data: { permission: 'write' },
  });
  mockOctokit.repos.get.mockResolvedValue({ data: { default_branch: 'main' } });
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
  // Default: the story exists on the branch and carries a matching approval.
  mockGetContentServing({ [STORY_PATH]: STORY_TEXT, [STORY_APPROVAL_PATH]: STORY_APPROVAL_JSON });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Serve `getContent` from a path → text map, 404ing anything absent. */
function mockGetContentServing(files: Record<string, string>): void {
  mockOctokit.repos.getContent.mockImplementation(async ({ path }: { path: string }) => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
    return { data: { type: 'file', content: Buffer.from(content, 'utf8').toString('base64') } };
  });
}

/** Build a story text + matching approval JSON pair for `storyPath`. */
function storyFixtures(storyPath: string): { text: string; approvalPath: string; approval: string } {
  const text = `# Story\n\n**Status:** Approved\n\nBody for ${storyPath}.\n`;
  const approvalPath = storyPath.replace(/\.md$/, '.approval.json');
  const approval = JSON.stringify({
    schema_version: 1,
    kind: 'story',
    story_path: storyPath,
    story_sha256: hashStory(text),
    source_spec_path: 'docs/superpowers/specs/2026-07-09-p-design.md',
    source_spec_sha256: 'a'.repeat(64),
    review_verdict: 'ok',
    review_rounds: 1,
    approved_by: 'ali@example.com',
    approved_at: '2026-09-12T10:00:00.000Z',
  });
  return { text, approvalPath, approval };
}

const STORY_PATH = 'docs/stories/epic-8/8.1-gate-hardening.md';
const {
  text: STORY_TEXT,
  approvalPath: STORY_APPROVAL_PATH,
  approval: STORY_APPROVAL_JSON,
} = storyFixtures(STORY_PATH);

describe('dispatchFromStory', () => {
  it('refuses with story_path is required when the field is blank', async () => {
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', '');
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    const result = await dispatchFromStory(fd);
    expect(result).toEqual({ error: 'story_path is required' });
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
  });

  it('refuses when the story is not on the default branch, naming the path', async () => {
    mockGetContentServing({}); // nothing exists on the branch
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', STORY_PATH);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    const result = await dispatchFromStory(fd);
    expect(result).toEqual({
      error: expect.stringContaining(STORY_PATH),
    });
    expect((result as { error: string }).error).toContain('main');
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
  });

  it('refuses when the gate refuses, and creates no issue', async () => {
    // Story exists, but no approval was ever recorded for it.
    mockGetContentServing({ [STORY_PATH]: STORY_TEXT });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', STORY_PATH);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    const result = await dispatchFromStory(fd);
    expect(result).toEqual({ error: expect.stringContaining('work cannot start') });
    // Load-bearing: an issue created before a refusal is an orphan nothing
    // comes back for.
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('reuses the spec-ready issue the intake filed instead of creating a second one', async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Story: ${STORY_PATH}\n`,
        labels: [{ name: 'state:spec-ready' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', STORY_PATH);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    await expect(dispatchFromStory(fd)).rejects.toThrow(/__redirect__:\/features\/77/);
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: expect.objectContaining({ issue_number: '77' }) }),
    );
  });

  it('refuses when a matching issue has already moved past spec-ready, naming its state', async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Story: ${STORY_PATH}\n`,
        labels: [{ name: 'state:implementing' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', STORY_PATH);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    const result = await dispatchFromStory(fd);
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining('state:implementing') }),
    );
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('refuses when a matching issue is closed, saying the story already went through the pipeline', async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 12,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/12',
        state: 'closed',
        body: `Story: ${STORY_PATH}\n`,
        labels: [{ name: 'state:done' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', STORY_PATH);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    const result = await dispatchFromStory(fd);
    expect(result).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('already been through the pipeline'),
      }),
    );
    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('refuses when a matching issue already has an active run, naming the count', async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Story: ${STORY_PATH}\n`,
        labels: [{ name: 'state:spec-ready' }],
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
    fd.append('story_path', STORY_PATH);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    const result = await dispatchFromStory(fd);
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining('1 active run(s)') }),
    );
    expect(mockOctokit.actions.createWorkflowDispatch).not.toHaveBeenCalled();
  });

  it('creates an issue carrying Story: <path> and no Spec: line when there is none', async () => {
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', STORY_PATH);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    await expect(dispatchFromStory(fd)).rejects.toThrow(/__redirect__:\/features\/77/);
    const body = mockOctokit.issues.create.mock.calls.at(-1)![0].body as string;
    expect(body).toContain(`Story: ${STORY_PATH}`);
    expect(body).not.toContain('Spec:');
  });

  it('labels a created issue kind:feature, state:spec-ready and epic:8 for an epic-8 story', async () => {
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', STORY_PATH);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    await expect(dispatchFromStory(fd)).rejects.toThrow(/__redirect__:/);
    expect(mockOctokit.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.arrayContaining(['kind:feature', 'state:spec-ready', 'epic:8']),
      }),
    );
    // The label flip that follows creation must not wipe epic:8 the moment
    // after it was applied — the flip's fallback (when there is no existing
    // issue to read labels off) has to be the labels just created, not a
    // hardcoded ['kind:feature'].
    expect(mockOctokit.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: expect.arrayContaining(['epic:8']) }),
    );
  });

  it('omits the epic label when the story is not in an epic directory', async () => {
    const plainPath = 'docs/stories/8.1-plain.md';
    const fixtures = storyFixtures(plainPath);
    mockGetContentServing({ [plainPath]: fixtures.text, [fixtures.approvalPath]: fixtures.approval });
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', plainPath);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    await expect(dispatchFromStory(fd)).rejects.toThrow(/__redirect__:/);
    const created = mockOctokit.issues.create.mock.calls.at(-1)![0] as { labels: string[] };
    expect(created.labels).not.toEqual(expect.arrayContaining([expect.stringMatching(/^epic:/)]));
    const flipped = mockOctokit.issues.setLabels.mock.calls.at(-1)![0] as { labels: string[] };
    expect(flipped.labels).not.toEqual(expect.arrayContaining([expect.stringMatching(/^epic:/)]));
  });

  it('dispatches dev-agent.yml with phase=implement and the issue number', async () => {
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', STORY_PATH);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    await expect(dispatchFromStory(fd)).rejects.toThrow(/__redirect__:/);
    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'x',
        repo: 'y',
        workflow_id: 'dev-agent.yml',
        ref: 'main',
        inputs: expect.objectContaining({ phase: 'implement', issue_number: '77' }),
      }),
    );
  });

  it('flips the issue to state:implementing, keeping its non-state labels', async () => {
    mockOctokit.paginate.mockResolvedValueOnce([
      {
        number: 77,
        title: 'Existing title',
        html_url: 'https://github.com/x/y/issues/77',
        state: 'open',
        body: `Story: ${STORY_PATH}\n`,
        labels: [{ name: 'state:spec-ready' }, { name: 'kind:bug' }, { name: 'quick-dev' }],
      },
    ]);
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', STORY_PATH);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    await expect(dispatchFromStory(fd)).rejects.toThrow(/__redirect__:/);
    expect(mockOctokit.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['kind:bug', 'quick-dev', 'state:implementing'] }),
    );
  });

  it('does not throw when the label flip fails after a successful dispatch', async () => {
    mockOctokit.issues.setLabels.mockRejectedValueOnce(new Error('boom'));
    // Spied so the expected failure doesn't print into the test run, and so
    // the swallow is asserted rather than merely not-thrown — a silently
    // dropped failure is a different bug from a reported one.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fd = new FormData();
      fd.append('repo', 'x/y');
      fd.append('story_path', STORY_PATH);
      fd.append('title', 'Foo feature');
      const { dispatchFromStory } = await import('@/lib/actions');
      // The redirect still fires — the label-flip failure is swallowed, not
      // reported as a failure of a dispatch that already succeeded.
      await expect(dispatchFromStory(fd)).rejects.toThrow(/__redirect__:\/features\/77/);
      expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('state:implementing label flip failed'),
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('accepts a ./-prefixed story_path and files the issue with the canonical spelling', async () => {
    const fd = new FormData();
    fd.append('repo', 'x/y');
    fd.append('story_path', `./${STORY_PATH}`);
    fd.append('title', 'Foo feature');
    const { dispatchFromStory } = await import('@/lib/actions');
    await expect(dispatchFromStory(fd)).rejects.toThrow(/__redirect__:/);
    const body = mockOctokit.issues.create.mock.calls.at(-1)![0].body as string;
    expect(body).toContain(`Story: ${STORY_PATH}`);
    expect(body).not.toContain(`./${STORY_PATH}`);
  });
});
