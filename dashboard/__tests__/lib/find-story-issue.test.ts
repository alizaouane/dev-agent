import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { findIssuesForStory } from '@/lib/find-story-issue';

const STORY = 'docs/stories/epic-8-agent-reliability/8.1-gate.md';

/** An octokit whose paginate returns `issues`. */
function octokitOver(issues: unknown[]): Octokit {
  return {
    paginate: vi.fn(async () => issues),
    issues: { listForRepo: {} },
  } as unknown as Octokit;
}

/** A minimal issue payload. */
function issue(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    html_url: 'https://example.test/7',
    body: `Story: ${STORY}\n`,
    labels: [{ name: 'state:spec-ready' }],
    state: 'open',
    title: '8.1 — Gate',
    ...over,
  };
}

describe('findIssuesForStory', () => {
  it('matches the issue that names the story', async () => {
    const found = await findIssuesForStory(octokitOver([issue()]), 'o', 'r', STORY);
    expect(found.map((i) => i.number)).toEqual([7]);
  });

  it('includes closed issues', async () => {
    // A story that already shipped keeps its artifact on disk while its issue
    // is closed. An open-only lookup files a fresh issue and implements
    // shipped work a second time.
    const found = await findIssuesForStory(
      octokitOver([issue({ state: 'closed' })]), 'o', 'r', STORY,
    );
    expect(found).toHaveLength(1);
    expect(found[0].open).toBe(false);
  });

  it('ignores a pull request that quotes the story', async () => {
    const found = await findIssuesForStory(
      octokitOver([issue({ pull_request: { url: 'x' } })]), 'o', 'r', STORY,
    );
    expect(found).toEqual([]);
  });

  it('ignores a story path quoted inside a fenced block', async () => {
    // Goes through parseStoryRef, the same parser the gate and the workflow
    // use, so the panel cannot decide an issue is about one story while the
    // gate reads it as another.
    const body = ['Story: docs/stories/epic-9-x/9.1-other.md', '', '```', `Story: ${STORY}`, '```'].join('\n');
    const found = await findIssuesForStory(octokitOver([issue({ body })]), 'o', 'r', STORY);
    expect(found).toEqual([]);
  });

  it('ignores a spec issue', async () => {
    const found = await findIssuesForStory(
      octokitOver([issue({ body: 'Spec: docs/specs/a-design.md\n' })]), 'o', 'r', STORY,
    );
    expect(found).toEqual([]);
  });

  it('returns every match, oldest first', async () => {
    // Not just the oldest. A repo that already carries the duplicate this
    // exists to stop has an old spec-ready issue and a newer one implementing;
    // collapsing to the lowest number throws away the evidence work started.
    const found = await findIssuesForStory(
      octokitOver([issue({ number: 9 }), issue({ number: 4 })]), 'o', 'r', STORY,
    );
    expect(found.map((i) => i.number)).toEqual([4, 9]);
  });

  it('lets a listing failure propagate', async () => {
    // An unreadable issue list is not an absent issue. Swallowing it files
    // the duplicate this function exists to prevent.
    const octokit = {
      paginate: vi.fn(async () => {
        throw new Error('rate limit');
      }),
      issues: { listForRepo: {} },
    } as unknown as Octokit;
    await expect(findIssuesForStory(octokit, 'o', 'r', STORY)).rejects.toThrow('rate limit');
  });
});
