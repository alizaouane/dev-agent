import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { buildPmTools } from '@/lib/pm-tools';
import type { RepoInfo } from '@/lib/repos';

// fetchPipeline + runAllScouts go through their own thoroughly-tested
// modules; for the tool-layer tests we stub them so we're isolating the
// tool wrappers' behavior, not re-testing the scout machinery.
vi.mock('@/lib/pipeline', () => ({
  fetchPipeline: vi.fn(async () => [
    {
      repo: 'q/r',
      issue_number: 5,
      title: 'Implement auth',
      state: 'state:implementing',
      age_seconds: 3600,
      last_telemetry: null,
      blockers: [],
      html_url: 'https://github.com/q/r/issues/5',
    },
  ]),
}));
vi.mock('@/lib/scout', () => ({
  runAllScouts: vi.fn(async () => [
    {
      id: 'unfinished_plan:q/r:plan#L1',
      source: 'unfinished_plan',
      group: 'carry_over',
      repo: 'q/r',
      title: 'Wire up auth',
      description: 'Step 2 unchecked',
      url: 'https://github.com/q/r/blob/main/plan.md#L1',
    },
  ]),
}));

const REPO: RepoInfo = {
  owner: 'q',
  name: 'r',
  default_branch: 'main',
  wired_up: true,
  html_url: 'https://github.com/q/r',
  description: null,
};

function mockOctokit(over: Partial<{
  getContent: ReturnType<typeof vi.fn>;
  searchCode: ReturnType<typeof vi.fn>;
  listCommits: ReturnType<typeof vi.fn>;
}> = {}): Octokit {
  return {
    repos: {
      getContent: over.getContent ?? vi.fn(),
      listCommits: over.listCommits ?? vi.fn(),
    },
    search: { code: over.searchCode ?? vi.fn() },
  } as unknown as Octokit;
}

describe('buildPmTools — read_file', () => {
  it('returns the file content + total line count', async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('# Hello\nworld\n').toString('base64'),
      },
    }));
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.read_file.execute!(
      { path: 'README.md' },
      { messages: [], toolCallId: 't1' },
    );
    expect(result).toMatchObject({
      path: 'README.md',
      content: '# Hello\nworld\n',
      total_lines: 3,
    });
  });

  it('returns just the requested line range when range is given', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(lines).toString('base64'),
      },
    }));
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.read_file.execute!(
      { path: 'plan.md', range: { start: 3, end: 5 } },
      { messages: [], toolCallId: 't1' },
    );
    expect(result).toMatchObject({
      path: 'plan.md',
      range: { start: 3, end: 5 },
      content: 'line 3\nline 4\nline 5',
      total_lines: 10,
    });
  });

  it('returns an error object on 404 instead of throwing', async () => {
    const getContent = vi.fn(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.read_file.execute!(
      { path: 'missing.md' },
      { messages: [], toolCallId: 't1' },
    );
    expect(result).toMatchObject({ error: 'not found: missing.md' });
  });

  it('rejects a directory listing', async () => {
    const getContent = vi.fn(async () => ({ data: [{ name: 'README.md' }] }));
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.read_file.execute!(
      { path: 'docs' },
      { messages: [], toolCallId: 't1' },
    );
    expect(String((result as { error?: string }).error)).toMatch(/not a regular file/);
  });

  it('caps the response when file exceeds MAX_FILE_BYTES', async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('x'.repeat(100_000)).toString('base64'),
      },
    }));
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.read_file.execute!(
      { path: 'big.md' },
      { messages: [], toolCallId: 't1' },
    );
    expect(String((result as { error?: string }).error)).toMatch(/cap/);
  });
});

describe('buildPmTools — list_directory', () => {
  it('returns name + path + type for each entry', async () => {
    const getContent = vi.fn(async () => ({
      data: [
        { name: 'README.md', path: 'README.md', type: 'file', size: 100 },
        { name: 'src', path: 'src', type: 'dir', size: 0 },
      ],
    }));
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.list_directory.execute!(
      { path: '' },
      { messages: [], toolCallId: 't1' },
    );
    expect(result).toMatchObject({
      path: '/',
      truncated: false,
    });
    expect((result as { entries: Array<{ name: string }> }).entries).toHaveLength(2);
  });

  it('rejects when path resolves to a single file', async () => {
    const getContent = vi.fn(async () => ({
      data: { type: 'file', name: 'README.md' },
    }));
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.list_directory.execute!(
      { path: 'README.md' },
      { messages: [], toolCallId: 't1' },
    );
    expect(String((result as { error?: string }).error)).toMatch(/not a directory/);
  });
});

describe('buildPmTools — search_code', () => {
  it('scopes the query to the repo automatically', async () => {
    const searchCode = vi.fn(async () => ({
      data: { total_count: 2, items: [{ path: 'a.ts', html_url: 'u1', name: 'a' }, { path: 'b.ts', html_url: 'u2', name: 'b' }] },
    }));
    const tools = buildPmTools({ octokit: mockOctokit({ searchCode }), repo: REPO });
    const result = await tools.search_code.execute!(
      { query: 'authenticate' },
      { messages: [], toolCallId: 't1' },
    );
    expect(searchCode).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'authenticate repo:q/r' }),
    );
    expect((result as { hits: unknown[] }).hits).toHaveLength(2);
  });

  it('appends a path filter when provided', async () => {
    const searchCode = vi.fn(async () => ({ data: { total_count: 0, items: [] } }));
    const tools = buildPmTools({ octokit: mockOctokit({ searchCode }), repo: REPO });
    await tools.search_code.execute!(
      { query: 'foo', path_glob: 'lib/' },
      { messages: [], toolCallId: 't1' },
    );
    expect(searchCode).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'foo repo:q/r path:lib/' }),
    );
  });

  it('returns an error object when the API throws (rate limit, 422, etc.)', async () => {
    const searchCode = vi.fn(async () => {
      throw new Error('rate limited');
    });
    const tools = buildPmTools({ octokit: mockOctokit({ searchCode }), repo: REPO });
    const result = await tools.search_code.execute!(
      { query: 'x' },
      { messages: [], toolCallId: 't1' },
    );
    expect(String((result as { error?: string }).error)).toMatch(/rate limited/);
  });
});

describe('buildPmTools — read_recent_commits', () => {
  it('returns short SHA + first message line + author + date', async () => {
    const listCommits = vi.fn(async () => ({
      data: [
        {
          sha: 'abcdef1234567890',
          commit: {
            message: 'feat: add auth\n\nlonger body',
            author: { name: 'Jane', date: '2026-05-01T00:00:00Z' },
          },
          author: { login: 'jane' },
        },
      ],
    }));
    const tools = buildPmTools({ octokit: mockOctokit({ listCommits }), repo: REPO });
    const result = await tools.read_recent_commits.execute!(
      { limit: 1 },
      { messages: [], toolCallId: 't1' },
    );
    expect(result).toMatchObject({
      commits: [
        {
          sha: 'abcdef1',
          message: 'feat: add auth',
          author: 'Jane',
          date: '2026-05-01T00:00:00Z',
        },
      ],
    });
  });
});

describe('buildPmTools — read_pipeline + read_proposals', () => {
  it('read_pipeline returns the in-flight items in compact form', async () => {
    const tools = buildPmTools({ octokit: mockOctokit(), repo: REPO });
    const result = await tools.read_pipeline.execute!(
      {},
      { messages: [], toolCallId: 't1' },
    );
    expect(result).toMatchObject({
      pipeline: [
        {
          issue_number: 5,
          title: 'Implement auth',
          state: 'state:implementing',
          age_days: 0,
        },
      ],
    });
  });

  it('read_proposals returns scout output stripped to id+source+title+desc+url', async () => {
    const tools = buildPmTools({ octokit: mockOctokit(), repo: REPO });
    const result = await tools.read_proposals.execute!(
      {},
      { messages: [], toolCallId: 't1' },
    );
    expect(result).toMatchObject({
      proposals: [
        {
          id: 'unfinished_plan:q/r:plan#L1',
          source: 'unfinished_plan',
          title: 'Wire up auth',
        },
      ],
    });
  });
});

describe('buildPmTools — read_session_log', () => {
  const SAMPLE_LOG = [
    '# Session Log',
    '',
    '## 2026-05-04 14:30 UTC — implement — issue #42',
    '',
    '**Trigger:** newest entry.',
    '',
    '**Outcome:** success',
    '',
    '---',
    '',
    '## 2026-05-03 10:00 UTC — staging-deploy — issue #41',
    '',
    '**Trigger:** older entry.',
    '',
    '**Outcome:** success',
    '',
    '---',
    '',
  ].join('\n');

  it('returns recent entries newest-first when SESSION_LOG.md exists', async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(SAMPLE_LOG).toString('base64'),
      },
    }));
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.read_session_log.execute!(
      { limit: 5 },
      { messages: [], toolCallId: 't1' },
    );
    const r = result as { entries: string[]; entry_count: number; truncated: boolean };
    expect(r.entry_count).toBe(2);
    expect(r.entries[0]).toContain('issue #42');
    expect(r.entries[1]).toContain('issue #41');
    expect(r.truncated).toBe(false);
  });

  it('respects the `limit` argument', async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(SAMPLE_LOG).toString('base64'),
      },
    }));
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.read_session_log.execute!(
      { limit: 1 },
      { messages: [], toolCallId: 't1' },
    );
    const r = result as { entries: string[]; entry_count: number };
    expect(r.entry_count).toBe(1);
    expect(r.entries[0]).toContain('issue #42');
  });

  it('returns an empty array with a friendly note when the log file is absent (404)', async () => {
    const getContent = vi.fn(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.read_session_log.execute!(
      { limit: 5 },
      { messages: [], toolCallId: 't1' },
    );
    expect(result).toMatchObject({
      entries: [],
      note: expect.stringContaining('no SESSION_LOG.md'),
    });
  });

  it('returns an error object on non-404 failures (rate limit, etc.)', async () => {
    const getContent = vi.fn(async () => {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    });
    const tools = buildPmTools({ octokit: mockOctokit({ getContent }), repo: REPO });
    const result = await tools.read_session_log.execute!(
      { limit: 5 },
      { messages: [], toolCallId: 't1' },
    );
    expect(String((result as { error?: string }).error)).toMatch(/rate limited/);
  });
});
