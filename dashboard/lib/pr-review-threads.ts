import 'server-only';

import type { Octokit } from '@octokit/rest';

/**
 * Counting the review feedback nobody has closed out yet.
 *
 * The dashboard's merge button used to hand the decision to GitHub, which
 * only refuses what branch protection makes it refuse. On a repo without that
 * rule configured it would merge straight over open review threads.
 */

const QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { isResolved }
        }
      }
    }
  }
`;

interface ThreadPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ isResolved: boolean }>;
      };
    };
  };
}

/**
 * Count the unresolved review threads on a pull request.
 *
 * Every page, because one page is 100 threads and a PR that has been round
 * the reviewers a few times exceeds that — and the number this returns is
 * what a merge decision gets made on.
 *
 * @param octokit - Authenticated client.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param prNumber - Pull request number.
 * @returns How many threads are open.
 * @throws Whatever the query throws. Zero because the query failed is not
 *   zero unresolved threads, and reporting it as such merges over feedback.
 */
export async function countUnresolvedThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number> {
  let cursor: string | null = null;
  let unresolved = 0;
  for (;;) {
    const data: ThreadPage = await octokit.graphql(QUERY, {
      owner,
      repo,
      number: prNumber,
      cursor,
    });
    const threads = data.repository.pullRequest.reviewThreads;
    unresolved += threads.nodes.filter((t) => !t.isResolved).length;
    if (!threads.pageInfo.hasNextPage) return unresolved;
    cursor = threads.pageInfo.endCursor;
  }
}
