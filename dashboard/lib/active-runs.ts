import 'server-only';

import type { Octokit } from '@octokit/rest';

/**
 * In-flight phase run for a single issue. The phase + invocation mode
 * are parsed from the run's display_title (set by `run-name:` in the
 * consumer's dev-agent.yml wrapper); we accept either label, including
 * runs missing one of them, so older wrappers still surface as plain
 * "running" rather than disappearing.
 */
export type ActiveRun = {
  /** GitHub Actions run id (numeric). */
  id: number;
  /** Phase label parsed from display_title (e.g., "implement"). */
  phase: string | null;
  /** "live" or "stub" if present. */
  invocation_mode: string | null;
  /** ISO timestamp the run was created. */
  created_at: string;
  /** "queued" | "in_progress" | other. */
  status: string;
  /** Convenience link to the run page on github.com. */
  html_url: string;
};

/**
 * Fetch in-flight runs of the consumer repo's `dev-agent.yml` wrapper
 * that target `issueNumber`. Used by the feature page to surface
 * "currently running" state — the existing telemetry comment is only
 * posted at phase completion, so without this the dashboard is blind
 * during the (often long) implement run.
 *
 * Matching: the wrapper sets `run-name:` to "<phase> → issue #<N> (<mode>)",
 * and we filter on `#<N>` in `display_title`. Runs from older wrappers
 * (no run-name) won't match here — that's fine, this becomes accurate
 * for any repo that re-installs the wire-up template.
 *
 * Status filter: GitHub's API treats `queued`/`in_progress`/`waiting`
 * as the in-flight bucket. Anything else is `completed`.
 *
 * @param options - `strict` switches this from best-effort visibility to a
 *   guard fit for a mutation: a listing failure rethrows instead of returning
 *   empty, every page is read rather than only the newest few, and every
 *   status GitHub has not marked `completed` counts as active — `requested`
 *   and `pending` included, which the default filter drops. A scan that hits
 *   its page limit with more to read throws too. An unreadable or partly-read
 *   run list is not an empty one, and a guard that cannot see is not a guard.
 */
export async function fetchActiveRunsForIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  options: { strict?: boolean } = {},
): Promise<ActiveRun[]> {
  // listWorkflowRuns supports `status` filter, but only one value at a
  // time. Pull recent runs (per_page=20 is plenty — anything older than
  // that and a phase is almost certainly hung, not still running) and
  // filter client-side. One round-trip is cheaper than three.
  //
  // Failure handling: this panel is best-effort visibility, while its
  // caller (FeaturePage) awaits us inside Promise.all alongside the
  // critical issue/comment fetches. A transient 403/5xx/rate-limit on
  // the Actions API must NOT take down the whole feature page — log
  // and return empty so the page still renders without the "Running
  // now" card.
  // How many pages of 100 a strict scan will read before giving up. Reaching
  // it is not "nothing found" — a run this never looked at is unknown, not
  // absent — so the scan throws rather than reporting clear.
  const STRICT_MAX_PAGES = 10;

  let runs: Array<{
    id: number;
    status?: string | null;
    display_title?: string | null;
    created_at: string;
    html_url: string;
  }>;
  try {
    if (options.strict) {
      runs = [];
      let pages = 0;
      const iterator = octokit.paginate.iterator(octokit.actions.listWorkflowRuns, {
        owner,
        repo,
        workflow_id: 'dev-agent.yml',
        per_page: 100,
      });
      for await (const page of iterator) {
        runs.push(...page.data);
        pages += 1;
        if (pages >= STRICT_MAX_PAGES) {
          if (page.data.length === 100) {
            throw new Error(
              `could not check ${owner}/${repo}#${issueNumber} exhaustively: more than ${STRICT_MAX_PAGES * 100} workflow runs to scan`,
            );
          }
          break;
        }
      }
    } else {
      const resp = await octokit.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: 'dev-agent.yml',
        per_page: 20,
      });
      runs = resp.data.workflow_runs;
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    // A caller guarding a dispatch cannot treat "could not list" as "nothing
    // running" — that is how the guard passes without checking and a second
    // run lands on a branch already being worked. Visibility callers still
    // degrade to empty; mutation callers ask for strict.
    if (options.strict) throw err;
    if (status !== 404) {
      console.warn(
        `fetchActiveRunsForIssue: ${owner}/${repo}#${issueNumber} — listWorkflowRuns failed (status=${status ?? 'unknown'}); panel will be hidden.`,
        err,
      );
    }
    return [];
  }

  // Bounded match — the marker must not be followed by another digit,
  // so issue #12 doesn't match a run named for #123. Pre-built once
  // per call, applied to each run.
  const issueMarkerRe = new RegExp(`#${issueNumber}(?!\\d)`);
  // Strict callers enumerate the terminal state instead of the live ones.
  // GitHub has more pre-execution statuses than the three below — `requested`
  // and `pending` among them — and a guard that lists only the ones it knows
  // reports clear for the ones it does not.
  const isActive = (status: string | null): boolean =>
    options.strict
      ? status !== 'completed'
      : status === 'queued' || status === 'in_progress' || status === 'waiting';
  return runs
    .filter((r) => isActive(r.status ?? null))
    .filter((r) => issueMarkerRe.test(r.display_title ?? ''))
    .map((r) => ({
      id: r.id,
      phase: parseField(r.display_title ?? '', /^(\S+)\s*→/),
      invocation_mode: parseField(r.display_title ?? '', /\(([^)]+)\)\s*$/),
      created_at: r.created_at,
      status: r.status ?? 'unknown',
      html_url: r.html_url,
    }));
}

function parseField(title: string, re: RegExp): string | null {
  const m = title.match(re);
  return m ? m[1] : null;
}
