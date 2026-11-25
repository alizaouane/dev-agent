/**
 * Where month-to-date spend is read from: the telemetry comments that the
 * phase workflows post on issues AND pull requests.
 *
 * Kept apart from `lib/cli/cost-watchdog.ts` because that file runs its own
 * `main()` on import: the budget gate used to import this function from there,
 * so every gate run also ran the nightly watchdog. This module has no side
 * effects, so both CLIs and the tests can import it.
 */

import type { Octokit } from '@octokit/rest';

/**
 * Midnight UTC on the first day of `d`'s month.
 *
 * @param d - Any instant in the month.
 * @returns The month's start, in UTC.
 */
export function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Only comments by this login count as telemetry; see collectIssuesWithComments. */
export const TELEMETRY_AUTHOR = 'github-actions[bot]';

/**
 * Collect every issue and pull request touched since `monthStart`, each once,
 * with its telemetry comments.
 *
 * Pull requests are included on purpose. GitHub numbers issues and PRs in one
 * sequence and `issues.listForRepo` returns both, and the PR fixer
 * (phase-pr-review) posts its telemetry on the PR, not on an issue. When this
 * function dropped PRs (`!i.pull_request`), the fixer's spend never reached the
 * month-to-date total, so the budget gate kept admitting runs past the cap.
 * Each number is kept once, so an item that moves between pages while they are
 * fetched is not counted twice.
 *
 * Only comments by `github-actions[bot]` count: dev-agent's phase workflows
 * post telemetry under it, so a person cannot inflate (or a forged comment
 * deflate) the total by pasting the telemetry shape.
 *
 * @param octokit - Authenticated client for the repository.
 * @param owner - Repository owner.
 * @param repo - Repository name.
 * @param monthStart - Lower bound for `since` (items updated since then).
 * @returns One entry per issue or PR number, with its trusted comments.
 */
export async function collectIssuesWithComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  monthStart: Date,
) {
  const items = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    since: monthStart.toISOString(),
    per_page: 100,
  });
  const seen = new Set<number>();
  const unique = items.filter((i) => {
    if (seen.has(i.number)) return false;
    seen.add(i.number);
    return true;
  });
  // Sequential pagination avoids secondary-rate-limit bursts on busy repos
  // (N items × paginated listComments would otherwise fan out concurrently).
  const results: Array<{ number: number; title: string; comments: { body: string; created_at: string }[] }> = [];
  for (const item of unique) {
    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: item.number,
      per_page: 100,
    });
    const trusted = comments.filter((c) => c.user?.login === TELEMETRY_AUTHOR);
    results.push({
      number: item.number,
      title: item.title,
      comments: trusted.map((c) => ({
        body: c.body ?? '',
        created_at: c.created_at,
      })),
    });
  }
  return results;
}
