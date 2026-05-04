import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { Proposal } from './types';
import { SOURCE_TO_GROUP } from './types';

/**
 * Surface bug-scout findings (issues filed by the phase-bug-scout
 * workflow) as proposals on `/proposals`. Distinct source from
 * `untriaged_issue` so the UI can render them differently —
 * severity badges, category icons — and so the user can snooze the
 * bug-scout queue independently from filed feature requests.
 *
 * Filter: open issues labelled `kind:bug-scout` AND `state:proposed`.
 *   - `kind:bug-scout` is the distinguishing label.
 *   - `state:proposed` means the user hasn't acted yet (closing the
 *     issue or flipping the state advances it out of the queue).
 */
export async function scoutBugFindings(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<Proposal[]> {
  type IssueRow = {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    labels: Array<string | { name?: string }>;
    pull_request?: unknown;
    created_at: string;
  };

  let issues: IssueRow[];
  try {
    issues = await octokit.paginate(octokit.issues.listForRepo, {
      owner,
      repo,
      state: 'open',
      labels: 'kind:bug-scout,state:proposed',
      per_page: 100,
    });
  } catch {
    return [];
  }

  const out: Proposal[] = [];
  for (const i of issues) {
    if (i.pull_request) continue; // never PRs

    const labelNames = i.labels
      .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
      .filter(Boolean);
    const severity = pickPrefixed(labelNames, 'severity:') ?? 'medium';
    const category = pickPrefixed(labelNames, 'bug-category:') ?? 'unknown';

    const ageDays = Math.floor(
      (Date.now() - new Date(i.created_at).getTime()) / (1000 * 60 * 60 * 24),
    );
    const bodyPreview = (i.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

    out.push({
      id: `bug_scout_finding:${owner}/${repo}:${i.number}`,
      source: 'bug_scout_finding',
      group: SOURCE_TO_GROUP.bug_scout_finding,
      repo: `${owner}/${repo}`,
      title: i.title,
      description:
        bodyPreview.length > 0
          ? `${ageDays}d old. ${bodyPreview}${bodyPreview.length === 200 ? '…' : ''}`
          : `${ageDays}d old. (no body)`,
      url: i.html_url,
      meta: { issue_number: i.number, severity, category, age_days: ageDays },
    });
  }

  // Highest severity first (security > broken_logic > code_smell).
  // Within a severity tier, oldest first (you've ignored these longest).
  const SEV_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => {
    const sa = SEV_RANK[String(a.meta?.severity ?? 'medium')] ?? 99;
    const sb = SEV_RANK[String(b.meta?.severity ?? 'medium')] ?? 99;
    if (sa !== sb) return sa - sb;
    return Number(b.meta?.age_days ?? 0) - Number(a.meta?.age_days ?? 0);
  });
}

function pickPrefixed(labels: string[], prefix: string): string | null {
  for (const l of labels) {
    if (l.startsWith(prefix)) return l.slice(prefix.length);
  }
  return null;
}
