import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { findOpenIssueForSpec } from '@/lib/find-spec-issue';

const SPEC = 'docs/superpowers/specs/2026-09-09-a-design.md';

/** Serve a fixed issue list through the paginate helper. */
function makeOctokit(issues: unknown[]): Octokit {
  return {
    paginate: vi.fn(async () => issues),
    issues: { listForRepo: vi.fn() },
  } as unknown as Octokit;
}

/** An open issue filed by one of the intake skills. */
function issue(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    html_url: 'https://github.com/q/r/issues/42',
    body: `Spec: ${SPEC}\nPlan: docs/superpowers/plans/2026-09-09-a.md\n`,
    labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
    ...over,
  };
}

describe('findOpenIssueForSpec', () => {
  it('finds the issue intake already filed for this spec', async () => {
    // Without this the panel filed a second issue for work already queued,
    // starting a duplicate run and stranding the original.
    const found = await findOpenIssueForSpec(makeOctokit([issue()]), 'q', 'r', SPEC);
    expect(found?.number).toBe(42);
    expect(found?.labels).toEqual(['state:spec-ready', 'kind:feature']);
  });

  it('returns null when no open issue names the spec', async () => {
    const other = issue({ body: 'Spec: docs/superpowers/specs/2026-01-01-b-design.md\n' });
    expect(await findOpenIssueForSpec(makeOctokit([other]), 'q', 'r', SPEC)).toBeNull();
  });

  it('ignores a pull request that happens to quote the path', async () => {
    const pr = issue({ number: 7, pull_request: { url: 'https://api/pulls/7' } });
    expect(await findOpenIssueForSpec(makeOctokit([pr]), 'q', 'r', SPEC)).toBeNull();
  });

  it('ignores a path that only appears inside a fenced block', async () => {
    // Same rule the approval gate applies, so the panel cannot decide an issue
    // is about one spec while the gate reads it as another.
    const quoted = issue({ body: `Example:\n\n\`\`\`\nSpec: ${SPEC}\n\`\`\`\n` });
    expect(await findOpenIssueForSpec(makeOctokit([quoted]), 'q', 'r', SPEC)).toBeNull();
  });

  it('picks the oldest when duplicates already exist', async () => {
    const found = await findOpenIssueForSpec(
      makeOctokit([issue({ number: 91 }), issue({ number: 42 })]),
      'q',
      'r',
      SPEC,
    );
    expect(found?.number).toBe(42);
  });

  it('propagates a listing failure rather than reporting no issue', async () => {
    // Reporting an unreadable list as "no issue" files the duplicate this
    // function exists to prevent.
    const octokit = {
      paginate: vi.fn().mockRejectedValue(new Error('rate limited')),
      issues: { listForRepo: vi.fn() },
    } as unknown as Octokit;
    await expect(findOpenIssueForSpec(octokit, 'q', 'r', SPEC)).rejects.toThrow('rate limited');
  });
});
