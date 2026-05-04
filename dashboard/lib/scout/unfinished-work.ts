import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { Proposal } from './types';
import { SOURCE_TO_GROUP } from './types';

/**
 * Surface unfinished-work findings (issues filed by the
 * phase-unfinished-work-scout workflow) as proposals on `/proposals`.
 * Distinct source from `bug_scout_finding` and the heuristic
 * `unfinished_plan` so the UI can render them differently —
 * "category" badges (stub / half-shipped / abandoned-migration / etc.)
 * — and so the user can snooze the LLM-scout queue independently.
 *
 * Filter: open issues labelled `kind:unfinished-work` AND
 * `state:proposed`.
 *   - `kind:unfinished-work` is the distinguishing label.
 *   - `state:proposed` means the user hasn't acted yet (closing the
 *     issue or flipping the state advances it out of the queue).
 */
export async function scoutUnfinishedWorkFindings(
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
      labels: 'kind:unfinished-work,state:proposed',
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
    const category = pickPrefixed(labelNames, 'unfinished-category:') ?? 'unknown';

    const ageDays = Math.floor(
      (Date.now() - new Date(i.created_at).getTime()) / (1000 * 60 * 60 * 24),
    );
    const bodyPreview = (i.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

    out.push({
      id: `unfinished_work_finding:${owner}/${repo}:${i.number}`,
      source: 'unfinished_work_finding',
      group: SOURCE_TO_GROUP.unfinished_work_finding,
      repo: `${owner}/${repo}`,
      title: i.title,
      description:
        bodyPreview.length > 0
          ? `${ageDays}d old. ${bodyPreview}${bodyPreview.length === 200 ? '…' : ''}`
          : `${ageDays}d old. (no body)`,
      url: i.html_url,
      meta: { issue_number: i.number, category, age_days: ageDays },
    });
  }

  // No severity ranking (LLM categories aren't ordinal). Sort oldest
  // first so items the user has been ignoring longest float to the top.
  return out.sort((a, b) => Number(b.meta?.age_days ?? 0) - Number(a.meta?.age_days ?? 0));
}

function pickPrefixed(labels: string[], prefix: string): string | null {
  for (const l of labels) {
    if (l.startsWith(prefix)) return l.slice(prefix.length);
  }
  return null;
}
