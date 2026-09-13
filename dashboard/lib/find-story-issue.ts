import 'server-only';

import type { Octokit } from '@octokit/rest';

import { parseStoryRef } from './spec-approval-gate';

/**
 * Finding the issue a story was already filed under.
 *
 * The intake files a `state:spec-ready` issue the moment it records an
 * approval, and that issue's own body says to press **Start work**. Creating a
 * second one here would start a second run against the same story and leave
 * the original sitting in the queue with nobody coming back for it.
 */

/** An issue that already names a given story. */
export interface StoryIssue {
  /** Issue number. */
  number: number;
  /** Link, for the error path to point at. */
  html_url: string;
  /** Body as filed, so the gate reads the same text the workflow will. */
  body: string | null;
  /** Current labels, including any approval override a human added. */
  labels: string[];
  /** Whether the issue is still open. */
  open: boolean;
  /** Current title, so a reuse only renames when the user asked for a change. */
  title: string;
}

/**
 * Find every issue whose body declares this story, open or closed.
 *
 * Closed ones count: a story that has already been through the pipeline keeps
 * its approval artifact on disk while its issue is closed, so an open-only
 * lookup finds nothing and implements shipped work again.
 *
 * Matching goes through `parseStoryRef`, the same parser the approval gate and
 * the implement workflow use, so the panel cannot decide an issue is about one
 * story while the gate reads it as another. A path quoted inside a fenced
 * block or backticks does not count, for that reason.
 *
 * @param octokit - Authenticated client.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param storyPath - Repo-relative story path to match.
 * @returns Matching issues, open and closed, oldest first.
 * @throws Whatever the listing throws — an unreadable issue list is not the
 *   same as an absent issue, and treating it as one files a duplicate.
 */
export async function findIssuesForStory(
  octokit: Octokit,
  owner: string,
  repo: string,
  storyPath: string,
): Promise<StoryIssue[]> {
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    per_page: 100,
  });

  return issues
    // A pull request is an issue as far as this endpoint is concerned, and a
    // PR quoting the story path is not the handoff issue.
    .filter((i) => !('pull_request' in i && i.pull_request))
    .filter((i) => parseStoryRef(i.body)?.story_path === storyPath)
    .sort((a, b) => a.number - b.number)
    .map((issue) => ({
      number: issue.number,
      html_url: issue.html_url,
      body: issue.body ?? null,
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      open: issue.state === 'open',
      title: issue.title,
    }));
}
