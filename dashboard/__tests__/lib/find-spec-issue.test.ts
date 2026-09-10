import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { findOpenIssuesForSpec } from '@/lib/find-spec-issue';

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

describe('findOpenIssuesForSpec', () => {
  it('finds the issue intake already filed for this spec', async () => {
    // Without this the panel filed a second issue for work already queued,
    // starting a duplicate run and stranding the original.
    const found = await findOpenIssuesForSpec(makeOctokit([issue()]), 'q', 'r', SPEC);
    expect(found[0].number).toBe(42);
    expect(found[0].labels).toEqual(['state:spec-ready', 'kind:feature']);
  });

  it('returns nothing when no open issue names the spec', async () => {
    const other = issue({ body: 'Spec: docs/superpowers/specs/2026-01-01-b-design.md\n' });
    expect(await findOpenIssuesForSpec(makeOctokit([other]), 'q', 'r', SPEC)).toEqual([]);
  });

  it('ignores a pull request that happens to quote the path', async () => {
    const pr = issue({ number: 7, pull_request: { url: 'https://api/pulls/7' } });
    expect(await findOpenIssuesForSpec(makeOctokit([pr]), 'q', 'r', SPEC)).toEqual([]);
  });

  it('ignores a path that only appears inside a fenced block', async () => {
    // Same rule the approval gate applies, so the panel cannot decide an issue
    // is about one spec while the gate reads it as another.
    const quoted = issue({ body: `Example:\n\n\`\`\`\nSpec: ${SPEC}\n\`\`\`\n` });
    expect(await findOpenIssuesForSpec(makeOctokit([quoted]), 'q', 'r', SPEC)).toEqual([]);
  });

  it('returns every duplicate, oldest first, rather than collapsing them', async () => {
    // A repo already carrying the duplicate this exists to stop has an old
    // spec-ready issue beside a newer one that is implementing. Returning
    // only the oldest discards the evidence that work has started.
    const found = await findOpenIssuesForSpec(
      makeOctokit([
        issue({ number: 91, labels: [{ name: 'state:implementing' }] }),
        issue({ number: 42 }),
      ]),
      'q',
      'r',
      SPEC,
    );
    expect(found.map((i) => i.number)).toEqual([42, 91]);
  });

  it('propagates a listing failure rather than reporting no issue', async () => {
    // Reporting an unreadable list as "no issue" files the duplicate this
    // function exists to prevent.
    const octokit = {
      paginate: vi.fn().mockRejectedValue(new Error('rate limited')),
      issues: { listForRepo: vi.fn() },
    } as unknown as Octokit;
    await expect(findOpenIssuesForSpec(octokit, 'q', 'r', SPEC)).rejects.toThrow('rate limited');
  });
});
