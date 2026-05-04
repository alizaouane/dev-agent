import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { Proposal } from './types';
import { SOURCE_TO_GROUP } from './types';

/**
 * Find open issues that have NEVER entered the dev-agent pipeline —
 * i.e., they have no `state:*` label. These are typically bug reports
 * or feature requests filed directly by users (or by CodeRabbit, GitHub
 * Apps, etc.) that nobody has triaged.
 *
 * Surfaces them as `untriaged_issue` proposals on the `/proposals` page
 * so the user can see in one glance what's piling up. Compared to
 * carry-over sources, these rank lower by default — they're new ideas
 * that may or may not be worth doing, not commitments already made.
 *
 * **What we filter out:**
 * - Issues with any `state:*` label (already in flight, blocked, done...)
 * - Issues with `kind:user-intent` (these were created via the dashboard's
 *   approve flow; if they're missing a state label that's a separate bug).
 * - Pull requests (GitHub returns PRs from issues.list). We discriminate
 *   by the `pull_request` field.
 */
export async function scoutUntriagedIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<Proposal[]> {
  type ListedIssue = {
    number: number;
    title: string;
    html_url: string;
    body?: string | null;
    labels: Array<string | { name?: string }>;
    pull_request?: unknown;
    user?: { login?: string } | null;
    created_at: string;
  };

  let issues: ListedIssue[];
  try {
    issues = await octokit.paginate(octokit.issues.listForRepo, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });
  } catch {
    // Repo unreachable, rate-limited, etc. — return nothing rather than
    // breaking the whole proposals page.
    return [];
  }

  const out: Proposal[] = [];
  for (const issue of issues) {
    if (issue.pull_request) continue; // skip PRs masquerading as issues

    const labelNames = issue.labels
      .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
      .filter(Boolean);
    const hasState = labelNames.some((l) => l.startsWith('state:'));
    const isUserIntent = labelNames.includes('kind:user-intent');
    if (hasState || isUserIntent) continue;

    const author = issue.user?.login ?? 'unknown';
    const ageDays = Math.floor(
      (Date.now() - new Date(issue.created_at).getTime()) / (1000 * 60 * 60 * 24),
    );
    const bodyPreview = (issue.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

    out.push({
      id: `untriaged_issue:${owner}/${repo}:${issue.number}`,
      source: 'untriaged_issue',
      group: SOURCE_TO_GROUP.untriaged_issue,
      repo: `${owner}/${repo}`,
      title: issue.title,
      description:
        bodyPreview.length > 0
          ? `Filed ${ageDays}d ago by @${author}. ${bodyPreview}${bodyPreview.length === 200 ? '…' : ''}`
          : `Filed ${ageDays}d ago by @${author}. (no body)`,
      url: issue.html_url,
      meta: { issue_number: issue.number, age_days: ageDays, author },
    });
  }

  return out;
}
