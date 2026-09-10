import 'server-only';

import type { Octokit } from '@octokit/rest';

import { parseSpecRefs } from './spec-approval-gate';

/**
 * Finding the issue a spec was already filed under.
 *
 * Both intake skills file a `state:spec-ready` issue the moment they record an
 * approval, and that issue's own body says to press **Start work** in the
 * dashboard. The panel used to create an issue unconditionally, so the normal
 * path produced two issues for one spec: a second run against the same work,
 * and an original left in the queue with nobody coming back for it.
 */

/** An open issue that already names a given spec. */
export interface SpecIssue {
  /** Issue number. */
  number: number;
  /** Link, for the error path to point at. */
  html_url: string;
  /** Body as filed, so the gate reads the same text the workflow will. */
  body: string | null;
  /** Current labels, including any approval override a human added. */
  labels: string[];
}

/**
 * Find the open issue whose body declares this spec.
 *
 * Matching goes through `parseSpecRefs`, the same parser the approval gate and
 * the implement workflow use, so the panel cannot decide an issue is about one
 * spec while the gate reads it as another. A path quoted inside a fenced block
 * or backticks does not count, for that reason.
 *
 * @param octokit - Authenticated client.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param specPath - Repo-relative spec path to match.
 * @returns The lowest-numbered matching open issue, or null when there is none.
 * @throws Whatever the listing throws — an unreadable issue list is not the
 *   same as an absent issue, and treating it as one files the duplicate this
 *   exists to prevent.
 */
export async function findOpenIssueForSpec(
  octokit: Octokit,
  owner: string,
  repo: string,
  specPath: string,
): Promise<SpecIssue | null> {
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  const matches = issues
    // A pull request is an issue as far as this endpoint is concerned, and a
    // PR quoting the spec path is not the handoff issue.
    .filter((i) => !('pull_request' in i && i.pull_request))
    .filter((i) => parseSpecRefs(i.body)?.spec_path === specPath);

  if (matches.length === 0) return null;
  // The oldest is the one intake filed; anything later is a duplicate someone
  // is about to notice.
  const issue = matches.reduce((a, b) => (a.number <= b.number ? a : b));
  return {
    number: issue.number,
    html_url: issue.html_url,
    body: issue.body ?? null,
    labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
  };
}
