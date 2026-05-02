import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notify, type NotifyContext } from '../../lib/notify';

const mockFetch = vi.fn();
const mockAppendFile = vi.fn();
const mockGhComment = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockAppendFile.mockReset();
  mockGhComment.mockReset();
});

const baseContext: NotifyContext = {
  config: {
    push: { provider: 'ntfy.sh', topic: 'test-topic' },
    email: { via: 'resend', secret_name: 'RESEND_API_KEY', to: 'test@example.com' },
    github_issue: true,
    status_file: true,
  },
  artifactsConfig: {
    status_file: '/tmp/status.md',
  },
  secrets: {
    RESEND_API_KEY: 'fake-resend-key',
  },
  issueNumber: 42,
  repo: 'alizaouane/test-repo',
  deps: {
    fetch: mockFetch as unknown as typeof fetch,
    appendStatusLine: mockAppendFile,
    commentOnIssue: mockGhComment,
  },
};

describe('notify', () => {
  it('fans out to all 4 channels when all enabled', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);
    mockAppendFile.mockResolvedValue(undefined);
    mockGhComment.mockResolvedValue(undefined);

    await notify(baseContext, { gate: 'pr-review', title: 'PR ready', body: 'open #42' });

    expect(mockFetch).toHaveBeenCalledTimes(2); // ntfy + resend
    expect(mockAppendFile).toHaveBeenCalledTimes(1);
    expect(mockGhComment).toHaveBeenCalledTimes(1);
  });

  it('continues other channels if push fails', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('ntfy')) throw new Error('network');
      return { ok: true, status: 200 } as Response;
    });
    mockAppendFile.mockResolvedValue(undefined);
    mockGhComment.mockResolvedValue(undefined);

    const result = await notify(baseContext, { gate: 'pr-review', title: 't', body: 'b' });

    expect(result.successes).toContain('email');
    expect(result.successes).toContain('github_issue');
    expect(result.successes).toContain('status_file');
    expect(result.failures).toEqual([{ channel: 'push', error: 'network' }]);
  });

  it('skips disabled channels', async () => {
    const ctx: NotifyContext = {
      ...baseContext,
      config: { github_issue: true, status_file: false }, // no push, no email, no status
    };
    mockGhComment.mockResolvedValue(undefined);

    await notify(ctx, { gate: 'spec-ready', title: 't', body: 'b' });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockAppendFile).not.toHaveBeenCalled();
    expect(mockGhComment).toHaveBeenCalledTimes(1);
  });
});
