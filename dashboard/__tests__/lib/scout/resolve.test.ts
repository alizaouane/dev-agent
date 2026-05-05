import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { resolveProposal } from '@/lib/scout/resolve';

function mkOctokit(over: Partial<{
  reposGet: ReturnType<typeof vi.fn>;
  getContent: ReturnType<typeof vi.fn>;
  createOrUpdateFileContents: ReturnType<typeof vi.fn>;
  issuesCreate: ReturnType<typeof vi.fn>;
  issuesUpdate: ReturnType<typeof vi.fn>;
  issuesCreateComment: ReturnType<typeof vi.fn>;
}> = {}): Octokit {
  return {
    repos: {
      get: over.reposGet ?? vi.fn(async () => ({ data: { default_branch: 'main' } })),
      getContent: over.getContent ?? vi.fn(),
      createOrUpdateFileContents:
        over.createOrUpdateFileContents ?? vi.fn(async (_args: Record<string, unknown>) => ({})),
    },
    issues: {
      create: over.issuesCreate ?? vi.fn(async (_args: Record<string, unknown>) => ({ data: { number: 999 } })),
      update: over.issuesUpdate ?? vi.fn(async (_args: Record<string, unknown>) => ({})),
      createComment:
        over.issuesCreateComment ?? vi.fn(async (_args: Record<string, unknown>) => ({})),
    },
  } as unknown as Octokit;
}

describe('resolveProposal — unfinished_plan (per-line)', () => {
  const planContent = [
    '# Plan',
    '',
    '## Step 1',
    '',
    '- [ ] do the thing',
    '- [x] already done',
    '* [ ] alt-bullet flavor',
    '1. [ ] numbered',
    '',
  ].join('\n');

  it('flips - [ ] to - [x] at the targeted line and commits', async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(planContent).toString('base64'),
        sha: 'sha-abc',
      },
    }));
    const createOrUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = mkOctokit({
      getContent,
      createOrUpdateFileContents: createOrUpdate,
    });

    const out = await resolveProposal(octokit, {
      proposalId: 'unfinished_plan:q/r:plan#L5',
      username: 'alice',
      meta: { plan_file: 'docs/plans/plan.md', line: 5 },
    });

    expect(out.kind).toBe('plan_checkbox_flipped');
    expect(out.description).toContain('docs/plans/plan.md:5');

    const call = createOrUpdate.mock.calls[0]?.[0] as { content?: string; sha?: string };
    expect(call?.sha).toBe('sha-abc');
    const decoded = Buffer.from(call?.content ?? '', 'base64').toString('utf8');
    const lines = decoded.split('\n');
    expect(lines[4]).toBe('- [x] do the thing');
    // Other lines untouched.
    expect(lines[5]).toBe('- [x] already done');
    expect(lines[6]).toBe('* [ ] alt-bullet flavor');
  });

  it('flips * [ ] (star bullet) too', async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(planContent).toString('base64'),
        sha: 'sha-abc',
      },
    }));
    const createOrUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = mkOctokit({ getContent, createOrUpdateFileContents: createOrUpdate });

    await resolveProposal(octokit, {
      proposalId: 'unfinished_plan:q/r:plan#L7',
      username: 'alice',
      meta: { plan_file: 'docs/plans/plan.md', line: 7 },
    });
    const call = createOrUpdate.mock.calls[0]?.[0] as { content?: string };
    const decoded = Buffer.from(call?.content ?? '', 'base64').toString('utf8');
    expect(decoded.split('\n')[6]).toBe('* [x] alt-bullet flavor');
  });

  it('flips numbered "1. [ ]" too', async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(planContent).toString('base64'),
        sha: 'sha-abc',
      },
    }));
    const createOrUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = mkOctokit({ getContent, createOrUpdateFileContents: createOrUpdate });

    await resolveProposal(octokit, {
      proposalId: 'unfinished_plan:q/r:plan#L8',
      username: 'alice',
      meta: { plan_file: 'docs/plans/plan.md', line: 8 },
    });
    const call = createOrUpdate.mock.calls[0]?.[0] as { content?: string };
    const decoded = Buffer.from(call?.content ?? '', 'base64').toString('utf8');
    expect(decoded.split('\n')[7]).toBe('1. [x] numbered');
  });

  it('is idempotent: already-checked line is a no-op success', async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(planContent).toString('base64'),
        sha: 'sha-abc',
      },
    }));
    const createOrUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = mkOctokit({ getContent, createOrUpdateFileContents: createOrUpdate });

    const out = await resolveProposal(octokit, {
      proposalId: 'unfinished_plan:q/r:plan#L6',
      username: 'alice',
      meta: { plan_file: 'docs/plans/plan.md', line: 6 },
    });
    expect(out.kind).toBe('plan_checkbox_flipped');
    expect(out.description).toMatch(/Already checked/i);
    expect(createOrUpdate).not.toHaveBeenCalled();
  });

  it('rejects rolled-up entries with a friendly snooze hint', async () => {
    const octokit = mkOctokit();
    await expect(
      resolveProposal(octokit, {
        proposalId: 'unfinished_plan:q/r:plan', // no #L suffix
        username: 'alice',
        meta: { plan_file: 'docs/plans/plan.md' },
      }),
    ).rejects.toThrow(/rolled-up.*Snooze/i);
  });

  it('rejects when meta is missing plan_file or line', async () => {
    const octokit = mkOctokit();
    await expect(
      resolveProposal(octokit, {
        proposalId: 'unfinished_plan:q/r:plan#L5',
        username: 'alice',
        meta: {},
      }),
    ).rejects.toThrow(/needs plan_file \+ line/);
  });

  it('rejects when the targeted line isn\'t actually a checkbox', async () => {
    const content = '# Plan\n\nJust prose.\n\nNot a list.\n';
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(content).toString('base64'),
        sha: 'sha-abc',
      },
    }));
    const octokit = mkOctokit({ getContent });
    await expect(
      resolveProposal(octokit, {
        proposalId: 'unfinished_plan:q/r:plan#L3',
        username: 'alice',
        meta: { plan_file: 'plan.md', line: 3 },
      }),
    ).rejects.toThrow(/doesn't look like an unchecked checkbox/);
  });
});

describe('resolveProposal — pending_spec', () => {
  it('files a kind:user-intent + state:scoping issue with the spec H1 as title', async () => {
    const specContent = '# Build refunds\n\nbody...\n';
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(specContent).toString('base64'),
      },
    }));
    const issuesCreate = vi.fn(async (_args: Record<string, unknown>) => ({ data: { number: 200 } }));
    const octokit = mkOctokit({ getContent, issuesCreate });

    const out = await resolveProposal(octokit, {
      proposalId: 'pending_spec:q/r:2026-05-04-refunds',
      username: 'alice',
      meta: { spec_path: 'docs/specs/2026-05-04-refunds.md' },
    });

    expect(out.kind).toBe('spec_filed_as_issue');
    expect(out.description).toContain('#200');

    const call = issuesCreate.mock.calls[0]?.[0] as {
      title?: string;
      body?: string;
      labels?: string[];
    };
    expect(call?.title).toBe('Build refunds');
    expect(call?.body).toContain('docs/specs/2026-05-04-refunds.md');
    expect(call?.body).toContain('@alice');
    expect(call?.labels).toEqual(['kind:user-intent', 'state:scoping']);
  });

  it('falls back to the slug when the spec has no H1', async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('no h1 here').toString('base64'),
      },
    }));
    const issuesCreate = vi.fn(async (_args: Record<string, unknown>) => ({ data: { number: 1 } }));
    const octokit = mkOctokit({ getContent, issuesCreate });

    await resolveProposal(octokit, {
      proposalId: 'pending_spec:q/r:slugged',
      username: 'alice',
      meta: { spec_path: 'docs/specs/slugged.md' },
    });
    const call = issuesCreate.mock.calls[0]?.[0] as { title?: string };
    expect(call?.title).toBe('slugged');
  });

  it('rejects when meta is missing spec_path', async () => {
    const octokit = mkOctokit();
    await expect(
      resolveProposal(octokit, {
        proposalId: 'pending_spec:q/r:s',
        username: 'alice',
        meta: {},
      }),
    ).rejects.toThrow(/needs spec_path/);
  });
});

describe('resolveProposal — issue-backed sources', () => {
  it('closes a bug-scout issue with an audit comment', async () => {
    const issuesCreateComment = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const issuesUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = mkOctokit({ issuesCreateComment, issuesUpdate });

    const out = await resolveProposal(octokit, {
      proposalId: 'bug_scout_finding:q/r:42',
      username: 'alice',
      meta: {},
    });

    expect(out.kind).toBe('issue_closed');
    expect(out.description).toContain('#42');

    expect(issuesCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        issue_number: 42,
        body: expect.stringContaining('@alice'),
      }),
    );
    expect(issuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        issue_number: 42,
        state: 'closed',
        state_reason: 'completed',
      }),
    );
  });

  it('closes an unfinished_work_finding issue', async () => {
    const issuesUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = mkOctokit({ issuesUpdate });
    await resolveProposal(octokit, {
      proposalId: 'unfinished_work_finding:q/r:7',
      username: 'alice',
      meta: {},
    });
    expect(issuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, state: 'closed' }),
    );
  });

  it('closes a cleanup_finding issue', async () => {
    const issuesUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = mkOctokit({ issuesUpdate });
    await resolveProposal(octokit, {
      proposalId: 'cleanup_finding:q/r:9',
      username: 'alice',
      meta: {},
    });
    expect(issuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 9, state: 'closed' }),
    );
  });

  it('closes an untriaged_issue', async () => {
    const issuesUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = mkOctokit({ issuesUpdate });
    await resolveProposal(octokit, {
      proposalId: 'untriaged_issue:q/r:11',
      username: 'alice',
      meta: {},
    });
    expect(issuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 11, state: 'closed' }),
    );
  });

  it('rejects when the id has no trailing :<number>', async () => {
    const octokit = mkOctokit();
    await expect(
      resolveProposal(octokit, {
        proposalId: 'bug_scout_finding:q/r:not-a-number',
        username: 'alice',
        meta: {},
      }),
    ).rejects.toThrow(/doesn't end with :<issue-number>/);
  });
});

describe('resolveProposal — unsupported sources', () => {
  it.each([
    ['spec_drift', 'spec_drift:q/r:slug@path'],
    ['competitor_watch', 'competitor_watch:q/r:https://x.com'],
    ['stale_blocked_issue', 'stale_blocked_issue:q/r:1'],
  ])('throws a friendly "use Snooze" error for %s', async (_label, id) => {
    const octokit = mkOctokit();
    await expect(
      resolveProposal(octokit, { proposalId: id, username: 'alice', meta: {} }),
    ).rejects.toThrow(/isn't wired.*Snooze/i);
  });
});

describe('resolveProposal — id parsing', () => {
  it('rejects malformed proposal ids', async () => {
    const octokit = mkOctokit();
    await expect(
      resolveProposal(octokit, { proposalId: 'no-route-here', username: 'a', meta: {} }),
    ).rejects.toThrow(/doesn't include owner\/repo/);
  });
});
