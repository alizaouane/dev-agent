import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { countUnresolvedThreads } from '@/lib/pr-review-threads';

/** Serve a fixed set of GraphQL pages. */
function makeOctokit(pages: Array<{ nodes: Array<{ isResolved: boolean }>; next?: string }>) {
  let call = 0;
  const graphql = vi.fn(async () => {
    const page = pages[call];
    call += 1;
    return {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: page.next !== undefined, endCursor: page.next ?? null },
            nodes: page.nodes,
          },
        },
      },
    };
  });
  return { graphql } as unknown as Octokit;
}

describe('countUnresolvedThreads', () => {
  it('counts only the threads nobody resolved', async () => {
    const octokit = makeOctokit([
      { nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] },
    ]);
    expect(await countUnresolvedThreads(octokit, 'q', 'r', 50)).toBe(2);
  });

  it('reads every page, not just the first', async () => {
    // A single page lies on any PR with a real review on it, and the count it
    // returns is the one a merge decision gets made on.
    const octokit = makeOctokit([
      { nodes: [{ isResolved: true }], next: 'cursor1' },
      { nodes: [{ isResolved: false }] },
    ]);
    expect(await countUnresolvedThreads(octokit, 'q', 'r', 50)).toBe(1);
  });

  it('propagates a failure rather than reporting zero', async () => {
    // Zero because the query failed is not zero unresolved threads, and the
    // difference is whether a merge goes ahead over open review feedback.
    const octokit = {
      graphql: vi.fn().mockRejectedValue(new Error('Bad credentials')),
    } as unknown as Octokit;
    await expect(countUnresolvedThreads(octokit, 'q', 'r', 50)).rejects.toThrow('Bad credentials');
  });
});
