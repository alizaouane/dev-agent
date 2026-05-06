import 'server-only';

import type { Octokit } from '@octokit/rest';

/**
 * The PR linked to a dev-agent feature issue, enriched with
 * mergeability + check status. Renders on the feature page so the
 * operator can see what's blocking merge (or merge directly) without
 * leaving the dashboard.
 */
export type FeaturePR = {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  /** Source branch — for dev-agent PRs, always feat/dev-agent-issue-N. */
  head_ref: string;
  base_ref: string;
  html_url: string;
  /** GitHub's mergeability flag — null while computing, true/false otherwise. */
  mergeable: boolean | null;
  /**
   * Aggregate state of head-ref status checks + check-runs.
   * Mirrors GitHub's combined-status response: 'success' | 'failure'
   * | 'pending' | 'neutral' | null (no checks yet).
   */
  checks_state: 'success' | 'failure' | 'pending' | 'neutral' | null;
  /** Per-check breakdown for the panel's expandable detail row. */
  check_runs: Array<{
    name: string;
    conclusion: string | null;
    status: string;
    html_url: string | null;
  }>;
};

/**
 * Find the PR linked to `issueNumber` and return enriched detail.
 *
 * Detection strategy: dev-agent's implement workflow opens PRs from
 * `feat/dev-agent-issue-<N>`, so we list PRs by head ref. Falls back
 * to `null` if no matching PR exists (issue may still be in scoping
 * / implementing, no PR yet).
 *
 * Failure mode: best-effort — any API failure returns null and warns,
 * matching active-runs / run-failures. The feature page must keep
 * rendering even if PR lookup is throttled.
 */
export async function fetchFeaturePR(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<FeaturePR | null> {
  let pr;
  try {
    // Look for the dev-agent branch first (the high-confidence path).
    const head = `${owner}:feat/dev-agent-issue-${issueNumber}`;
    const list = await octokit.pulls.list({
      owner,
      repo,
      state: 'all',
      head,
      per_page: 5,
    });
    // Take the most recent (closed PRs are still useful for showing
    // "merged" state on completed features).
    pr = list.data[0];
  } catch (err) {
    console.warn(`fetchFeaturePR: list failed for ${owner}/${repo}#${issueNumber}`, err);
    return null;
  }
  if (!pr) return null;

  // Per-PR detail call to get a definitive `mergeable` flag — the
  // list endpoint omits it.
  let detail;
  try {
    detail = await octokit.pulls.get({ owner, repo, pull_number: pr.number });
  } catch (err) {
    console.warn(`fetchFeaturePR: get(${pr.number}) failed`, err);
    return null;
  }

  // Combined status (legacy commit statuses) + check-runs (newer
  // GitHub Actions checks). For dev-agent PRs the latter is the
  // relevant signal, but we surface both.
  const checks = await fetchHeadChecks(octokit, owner, repo, detail.data.head.sha);

  return {
    number: detail.data.number,
    title: detail.data.title,
    state: detail.data.merged
      ? 'merged'
      : detail.data.state === 'closed'
        ? 'closed'
        : 'open',
    head_ref: detail.data.head.ref,
    base_ref: detail.data.base.ref,
    html_url: detail.data.html_url,
    mergeable: detail.data.mergeable ?? null,
    checks_state: checks.state,
    check_runs: checks.runs,
  };
}

async function fetchHeadChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<{
  state: 'success' | 'failure' | 'pending' | 'neutral' | null;
  runs: FeaturePR['check_runs'];
}> {
  try {
    const resp = await octokit.checks.listForRef({
      owner,
      repo,
      ref: sha,
      per_page: 30,
    });
    const runs = resp.data.check_runs.map((c) => ({
      name: c.name,
      conclusion: c.conclusion ?? null,
      status: c.status,
      html_url: c.html_url ?? null,
    }));
    return { state: aggregateChecks(runs), runs };
  } catch (err) {
    console.warn('fetchHeadChecks: failed', err);
    return { state: null, runs: [] };
  }
}

/**
 * Aggregate a set of check-runs into a single state. Failure dominates,
 * then pending, then success — mirroring GitHub's own UI logic.
 */
function aggregateChecks(
  runs: FeaturePR['check_runs'],
): 'success' | 'failure' | 'pending' | 'neutral' | null {
  if (runs.length === 0) return null;
  if (runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out')) return 'failure';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  if (runs.every((r) => r.conclusion === 'success' || r.conclusion === 'skipped')) return 'success';
  return 'neutral';
}
