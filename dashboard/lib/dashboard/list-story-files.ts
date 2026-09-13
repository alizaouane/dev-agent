import 'server-only';

import type { Octokit } from '@octokit/rest';

/** Every story and approval artifact under the configured tree. */
export interface StoryListing {
  /** Repo-relative paths to story markdown files. */
  stories: string[];
  /** Repo-relative paths to the `.approval.json` files beside them. */
  approvals: string[];
  /** Path to git blob SHA, so the verifier can skip unchanged files. */
  blobShas: Record<string, string>;
  /**
   * True when this listing may be short — the read failed for a reason other
   * than the tree being absent, or the tree came back truncated.
   */
  unreadable: boolean;
}

/**
 * List the story tree on `ref` in a single recursive call.
 *
 * One call, not one per epic directory. The per-directory lister the spec
 * picker uses ORs its `unreadable` flag across every directory it touched, so
 * recursing epics with it would be N+1 requests and one unreadable epic would
 * mark the entire list short.
 *
 * A truncated tree is reported as short. GitHub truncates large trees without
 * erroring, so a partial list is exactly the shape of a complete one — and an
 * approved story missing from the picker for that reason would be invisible.
 *
 * @param octokit - Authenticated client for the consumer repo.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param ref - Branch or commit to read the tree at.
 * @param storiesDir - Repo-relative story directory, without a trailing slash.
 * @returns The story paths, the approval paths beside them, their blob SHAs,
 *   and whether the listing can be trusted to be complete.
 */
export async function listStoryFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  storiesDir: string,
): Promise<StoryListing> {
  let entries: { path?: string; type?: string; sha?: string }[];
  let truncated: boolean;
  try {
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: '1',
    });
    entries = data.tree ?? [];
    truncated = data.truncated === true;
  } catch (err) {
    const absent = (err as { status?: number }).status === 404;
    return { stories: [], approvals: [], blobShas: {}, unreadable: !absent };
  }

  // The separator is load-bearing: without it `docs/stories-archive` matches
  // a `docs/stories` configuration and archived work is offered as startable.
  const prefix = `${storiesDir}/`;
  const stories: string[] = [];
  const approvals: string[] = [];
  const blobShas: Record<string, string> = {};

  for (const entry of entries) {
    const path = entry.path;
    if (entry.type !== 'blob' || typeof path !== 'string' || !path.startsWith(prefix)) continue;
    if (path.endsWith('.md')) stories.push(path);
    else if (path.endsWith('.approval.json')) approvals.push(path);
    else continue;
    // Only a real SHA goes in. A missing one makes the verifier read the file
    // rather than key a cache entry on a value that does not describe it.
    if (typeof entry.sha === 'string' && entry.sha !== '') blobShas[path] = entry.sha;
  }

  return { stories, approvals, blobShas, unreadable: truncated };
}
