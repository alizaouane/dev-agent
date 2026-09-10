import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { findIssuesForSpec, isWaitingToStart, withSpecRefs } from '@/lib/find-spec-issue';

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
    title: 'A feature',
    html_url: 'https://github.com/q/r/issues/42',
    body: `Spec: ${SPEC}\nPlan: docs/superpowers/plans/2026-09-09-a.md\n`,
    labels: [{ name: 'state:spec-ready' }, { name: 'kind:feature' }],
    state: 'open',
    ...over,
  };
}

describe('findIssuesForSpec', () => {
  it('finds the issue intake already filed for this spec', async () => {
    // Without this the panel filed a second issue for work already queued,
    // starting a duplicate run and stranding the original.
    const found = await findIssuesForSpec(makeOctokit([issue()]), 'q', 'r', SPEC);
    expect(found[0].number).toBe(42);
    expect(found[0].labels).toEqual(['state:spec-ready', 'kind:feature']);
  });

  it('returns nothing when no open issue names the spec', async () => {
    const other = issue({ body: 'Spec: docs/superpowers/specs/2026-01-01-b-design.md\n' });
    expect(await findIssuesForSpec(makeOctokit([other]), 'q', 'r', SPEC)).toEqual([]);
  });

  it('ignores a pull request that happens to quote the path', async () => {
    const pr = issue({ number: 7, pull_request: { url: 'https://api/pulls/7' } });
    expect(await findIssuesForSpec(makeOctokit([pr]), 'q', 'r', SPEC)).toEqual([]);
  });

  it('ignores a path that only appears inside a fenced block', async () => {
    // Same rule the approval gate applies, so the panel cannot decide an issue
    // is about one spec while the gate reads it as another.
    const quoted = issue({ body: `Example:\n\n\`\`\`\nSpec: ${SPEC}\n\`\`\`\n` });
    expect(await findIssuesForSpec(makeOctokit([quoted]), 'q', 'r', SPEC)).toEqual([]);
  });

  it('returns every duplicate, oldest first, rather than collapsing them', async () => {
    // A repo already carrying the duplicate this exists to stop has an old
    // spec-ready issue beside a newer one that is implementing. Returning
    // only the oldest discards the evidence that work has started.
    const found = await findIssuesForSpec(
      makeOctokit([
        issue({ number: 91, labels: [{ name: 'state:implementing' }] }),
        issue({ number: 42 }),
      ]),
      'q',
      'r',
      SPEC,
    );
    expect(found.map((i: { number: number }) => i.number)).toEqual([42, 91]);
  });

  it('returns closed issues too, so shipped work is visible', async () => {
    // The approval artifact outlives the pipeline. Without the closed
    // state:done issue there is nothing left to say the spec already shipped.
    const found = await findIssuesForSpec(
      makeOctokit([issue({ number: 12, state: 'closed', labels: [{ name: 'state:done' }] })]),
      'q',
      'r',
      SPEC,
    );
    expect(found[0].open).toBe(false);
  });

  it('propagates a listing failure rather than reporting no issue', async () => {
    // Reporting an unreadable list as "no issue" files the duplicate this
    // function exists to prevent.
    const octokit = {
      paginate: vi.fn().mockRejectedValue(new Error('rate limited')),
      issues: { listForRepo: vi.fn() },
    } as unknown as Octokit;
    await expect(findIssuesForSpec(octokit, 'q', 'r', SPEC)).rejects.toThrow('rate limited');
  });
});

describe('isWaitingToStart', () => {
  const withLabels = (labels: string[], open = true) => ({
    number: 1,
    html_url: 'u',
    body: null,
    labels,
    planPath: null,
    open,
    title: 'A feature',
  });

  it('accepts an issue whose only state is spec-ready', () => {
    expect(isWaitingToStart(withLabels(['state:spec-ready', 'kind:feature']))).toBe(true);
  });

  it('rejects an issue carrying two state labels', () => {
    // A half-applied label flip leaves both behind. Testing for spec-ready
    // being present accepted the issue and dispatched work already running.
    expect(isWaitingToStart(withLabels(['state:spec-ready', 'state:implementing']))).toBe(false);
  });

  it('rejects an issue with no state label at all', () => {
    expect(isWaitingToStart(withLabels(['kind:feature']))).toBe(false);
  });

  it('rejects a closed issue however it is labelled', () => {
    // A shipped spec keeps its approval artifact but its issue is closed.
    // Treating that as startable re-implements work that already landed.
    expect(isWaitingToStart(withLabels(['state:spec-ready'], false))).toBe(false);
  });
});

describe('withSpecRefs', () => {
  it('rewrites a stale plan line to the approved one', () => {
    const out = withSpecRefs(
      `Spec: ${SPEC}\nPlan: docs/plans/old.md\n\n## TL;DR\n`,
      SPEC,
      'docs/superpowers/plans/2026-09-09-a.md',
    );
    expect(out).toContain('Plan: docs/superpowers/plans/2026-09-09-a.md');
    expect(out).not.toContain('docs/plans/old.md');
  });

  it('adds a plan line to an issue filed without one', () => {
    const out = withSpecRefs(`Spec: ${SPEC}\n\n## TL;DR\n`, SPEC, 'docs/plans/p.md');
    expect(out.split('\n').slice(0, 2)).toEqual([`Spec: ${SPEC}`, 'Plan: docs/plans/p.md']);
  });

  it('removes the plan line when the approval names no plan', () => {
    const out = withSpecRefs(`Spec: ${SPEC}\nPlan: docs/plans/p.md\n`, SPEC, null);
    expect(out).not.toContain('Plan:');
  });

  it('leaves a reference inside a fenced block alone', () => {
    // parseSpecRefs ignores fenced content, so rewriting it would edit an
    // example while leaving the line the workflow actually reads untouched.
    const body = `Spec: ${SPEC}\n\n\`\`\`\nSpec: docs/specs/example-design.md\n\`\`\`\n`;
    expect(withSpecRefs(body, SPEC, null)).toContain('Spec: docs/specs/example-design.md');
  });
});
