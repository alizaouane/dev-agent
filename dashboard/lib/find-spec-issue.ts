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
 * Find every open issue whose body declares this spec.
 *
 * All of them, not just the oldest. A repo that already carries the duplicate
 * this change exists to stop has an old issue still at `state:spec-ready` and
 * a newer one already implementing; collapsing to the lowest number throws
 * away the only evidence that work has started, and the caller then clears a
 * guard by inspecting the wrong issue.
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
 * @returns Matching open issues, oldest first. Empty when there are none.
 * @throws Whatever the listing throws — an unreadable issue list is not the
 *   same as an absent issue, and treating it as one files the duplicate this
 *   exists to prevent.
 */
export async function findOpenIssuesForSpec(
  octokit: Octokit,
  owner: string,
  repo: string,
  specPath: string,
): Promise<SpecIssue[]> {
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

  // Oldest first: the first is the one intake filed, anything after it is a
  // duplicate, and the caller needs to see all of them to decide.
  return matches
    .sort((a, b) => a.number - b.number)
    .map((issue) => ({
      number: issue.number,
      html_url: issue.html_url,
      body: issue.body ?? null,
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    }));
}

/**
 * The state label an issue currently carries.
 *
 * @param issue - A matched issue.
 * @returns The `state:*` label, or null when it has none.
 */
export function stateLabel(issue: SpecIssue): string | null {
  return issue.labels.find((l) => l.startsWith('state:')) ?? null;
}
