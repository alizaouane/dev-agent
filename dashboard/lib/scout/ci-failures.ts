import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { Proposal } from './types';
import { SOURCE_TO_GROUP } from './types';

/**
 * Scan recent GitHub Actions runs for repeating failures. A workflow
 * that fails N times in M days is the dev-agent's lightest-weight
 * "bug scanner" — no log-aggregation integration needed, just
 * GitHub's own data.
 *
 * Heuristic:
 *   - Look back LOOKBACK_DAYS (7).
 *   - Group failed runs by workflow file name (the workflow's path,
 *     stable across renames of the workflow's `name:` field).
 *   - Emit a proposal for any group with >= MIN_FAILURES (3).
 *
 * Why workflow path, not workflow_id: re-creating a workflow file
 * yields a new workflow_id, which would erase the failure history.
 * Path is what humans recognize and what `gh workflow run` references.
 *
 * Limits:
 *   - Limited to 100 most recent runs per call (Octokit pagination
 *     is opt-in; for repos with very chatty CI we may miss older
 *     runs in the window). 100 is enough for the typical signal.
 *   - We don't try to parse logs — just count. The user opens the
 *     workflow URL to see what's actually failing.
 */
export async function scoutRecurringCIFailures(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<Proposal[]> {
  const LOOKBACK_DAYS = 7;
  const MIN_FAILURES = 3;
  const PER_PAGE = 100;

  const sinceMs = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();

  type RunRow = {
    id: number;
    name: string | null;
    path: string;
    conclusion: string | null;
    status: string | null;
    html_url: string;
    created_at: string;
  };

  let runs: RunRow[];
  try {
    const resp = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      // GitHub supports `created` as a search-syntax range, e.g. `>2026-05-01`.
      created: `>=${sinceIso.slice(0, 10)}`,
      per_page: PER_PAGE,
    });
    runs = (resp.data.workflow_runs ?? []) as RunRow[];
  } catch {
    return [];
  }

  type Group = {
    path: string;
    name: string;
    failures: number;
    latestUrl: string;
    latestAt: string;
  };
  const groups = new Map<string, Group>();
  for (const run of runs) {
    if (run.conclusion !== 'failure') continue;
    if (new Date(run.created_at).getTime() < sinceMs) continue;
    const existing = groups.get(run.path);
    if (existing) {
      existing.failures += 1;
      if (run.created_at > existing.latestAt) {
        existing.latestUrl = run.html_url;
        existing.latestAt = run.created_at;
      }
    } else {
      groups.set(run.path, {
        path: run.path,
        name: run.name ?? run.path,
        failures: 1,
        latestUrl: run.html_url,
        latestAt: run.created_at,
      });
    }
  }

  const out: Proposal[] = [];
  for (const g of groups.values()) {
    if (g.failures < MIN_FAILURES) continue;
    out.push({
      id: `recurring_ci_failure:${owner}/${repo}:${g.path}`,
      source: 'recurring_ci_failure',
      group: SOURCE_TO_GROUP.recurring_ci_failure,
      repo: `${owner}/${repo}`,
      title: `Workflow failing repeatedly: ${g.name}`,
      description: `\`${g.path}\` has ${g.failures} failed runs in the last ${LOOKBACK_DAYS} days. Likely a real bug or a flaky test. Latest failure: ${formatRelative(g.latestAt)}.`,
      url: g.latestUrl,
      meta: {
        workflow_path: g.path,
        failure_count: g.failures,
        lookback_days: LOOKBACK_DAYS,
      },
    });
  }
  return out;
}

/** "5h ago" / "2d ago" — short relative time for the description line. */
function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
