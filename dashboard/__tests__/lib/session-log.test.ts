import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import {
  buildApprovedScopeEntry,
  prependEntryToContent,
  appendApprovedScopeEntry,
} from '@/lib/session-log';

describe('buildApprovedScopeEntry', () => {
  it('emits a structured entry with timestamp + approver + truncated scope', () => {
    const out = buildApprovedScopeEntry({
      timestamp: new Date('2026-05-04T14:30:00Z'),
      issue: 200,
      approver: 'alizaouane',
      title: 'Add refund button',
      scope: 'Add a refund button to the booking-detail page.\nStripe API only, no partial refunds.',
    });
    expect(out).toContain('## 2026-05-04 14:30 UTC — user-approved scope — issue #200');
    expect(out).toContain('**Trigger:** @alizaouane clicked "Approve and start"');
    expect(out).toContain('**Title:** Add refund button');
    expect(out).toContain('Stripe API only, no partial refunds');
    expect(out.endsWith('---\n')).toBe(true);
  });

  it('truncates very long scope text to <=280 chars on one line', () => {
    const out = buildApprovedScopeEntry({
      timestamp: new Date('2026-05-04T14:30:00Z'),
      issue: 1,
      approver: 'a',
      title: 't',
      scope: 'word '.repeat(200),
    });
    const scopeLine = out.split('\n').find((l) => l.startsWith('**Scope (one-line):**'))!;
    expect(scopeLine.length).toBeLessThan(320);
    expect(scopeLine.endsWith('…')).toBe(true);
  });
});

describe('prependEntryToContent', () => {
  it('initializes with H1 + entry when current content is empty', () => {
    const entry = '## 2026-05-04 14:30 UTC — user-approved scope — issue #1\n\n**Trigger:** test.\n\n---\n';
    const r = prependEntryToContent('', entry);
    expect(r.changed).toBe(true);
    expect(r.content).toMatch(/^# Session Log\n/);
    expect(r.content).toContain('issue #1');
  });

  it('prepends new entries above older ones (newest-first)', () => {
    const oldEntry = '## 2026-05-03 — older entry\n\nbody\n\n---\n';
    const current = `# Session Log\n\n${oldEntry}`;
    const newEntry = '## 2026-05-04 14:30 UTC — newer entry\n\nbody\n\n---\n';
    const r = prependEntryToContent(current, newEntry);
    expect(r.changed).toBe(true);
    const newIdx = r.content.indexOf('newer entry');
    const oldIdx = r.content.indexOf('older entry');
    expect(newIdx).toBeLessThan(oldIdx);
    expect(newIdx).toBeGreaterThan(0); // after the H1
  });

  it('is idempotent: same H2 already at top → no-op', () => {
    const entry = '## 2026-05-04 14:30 UTC — user-approved scope — issue #5\n\n**Trigger:** test.\n\n---\n';
    const first = prependEntryToContent('', entry);
    const second = prependEntryToContent(first.content, entry);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('handles content without an H1 by injecting one', () => {
    const entry = '## 2026-05-04 — entry\n\nbody\n\n---\n';
    const r = prependEntryToContent('just some text\n', entry);
    expect(r.changed).toBe(true);
    expect(r.content).toMatch(/^# Session Log\n/);
    expect(r.content).toContain('just some text');
    expect(r.content).toContain('## 2026-05-04 — entry');
  });
});

describe('appendApprovedScopeEntry (Octokit)', () => {
  function mockOctokit(over: Partial<{
    getContent: ReturnType<typeof vi.fn>;
    createOrUpdateFileContents: ReturnType<typeof vi.fn>;
  }> = {}): Octokit {
    return {
      repos: {
        getContent: over.getContent ?? vi.fn(),
        createOrUpdateFileContents: over.createOrUpdateFileContents ?? vi.fn(),
      },
    } as unknown as Octokit;
  }

  it('creates the file when SESSION_LOG.md does not exist (404)', async () => {
    const getContent = vi.fn(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    const createOrUpdateFileContents = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = mockOctokit({ getContent, createOrUpdateFileContents });

    await appendApprovedScopeEntry(octokit, 'q', 'r', 'main', {
      timestamp: new Date('2026-05-04T14:30:00Z'),
      issue: 7,
      approver: 'alizaouane',
      title: 'Test feature',
      scope: 'do the thing.',
    });

    expect(createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        path: 'SESSION_LOG.md',
        sha: undefined, // no current file → no sha
      }),
    );
    const call = createOrUpdateFileContents.mock.calls[0]?.[0] as
      | { content?: string }
      | undefined;
    const decoded = Buffer.from(call?.content ?? '', 'base64').toString('utf8');
    expect(decoded).toMatch(/^# Session Log\n/);
    expect(decoded).toContain('issue #7');
  });

  it('prepends to an existing file with the correct sha for optimistic concurrency', async () => {
    const existing = '# Session Log\n\n## 2026-05-03 — older\n\n**Trigger:** old.\n\n---\n';
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(existing).toString('base64'),
        sha: 'sha-existing',
      },
    }));
    const createOrUpdateFileContents = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = mockOctokit({ getContent, createOrUpdateFileContents });

    await appendApprovedScopeEntry(octokit, 'q', 'r', 'main', {
      timestamp: new Date('2026-05-04T14:30:00Z'),
      issue: 8,
      approver: 'alizaouane',
      title: 'New feature',
      scope: 'do another thing.',
    });

    const call = createOrUpdateFileContents.mock.calls[0]?.[0] as
      | { sha?: string; content?: string }
      | undefined;
    expect(call?.sha).toBe('sha-existing');
    const decoded = Buffer.from(call?.content ?? '', 'base64').toString('utf8');
    expect(decoded.indexOf('issue #8')).toBeLessThan(decoded.indexOf('older'));
  });

  it('rethrows non-404 errors so the caller can decide', async () => {
    const getContent = vi.fn(async () => {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    });
    const octokit = mockOctokit({ getContent });
    await expect(
      appendApprovedScopeEntry(octokit, 'q', 'r', 'main', {
        issue: 1,
        approver: 'a',
        title: 't',
        scope: 's',
      }),
    ).rejects.toThrow(/rate limited/);
  });
});
