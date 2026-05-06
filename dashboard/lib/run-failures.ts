import 'server-only';

import type { Octokit } from '@octokit/rest';

/**
 * A failed phase run with its failed step + a tail of the step's
 * logs. The feature page renders this as inline diagnostics so the
 * operator doesn't have to drop into GitHub Actions UI to read the
 * red banner.
 */
export type FailedRun = {
  id: number;
  phase: string | null;
  invocation_mode: string | null;
  conclusion: string;
  created_at: string;
  html_url: string;
  /**
   * Name of the first step that failed within the run's primary job
   * (e.g., "Run Claude Code (live agent)"). Null if we couldn't
   * resolve a job/step (run may have been a startup_failure with no
   * jobs registered).
   */
  failed_step: string | null;
  /**
   * Last lines of the failed step's log. Null when logs aren't
   * available — startup_failure runs notably have no log archive.
   */
  log_tail: string | null;
};

const LOG_TAIL_LINES = 30;

/**
 * Fetch recent failed/cancelled/timed-out runs targeting `issueNumber`,
 * enriched with each run's first failed step name and a tail of its
 * logs. The feature page uses this to surface "why did the last run
 * fail" inline.
 *
 * Best-effort like `fetchActiveRunsForIssue`: any API failure (rate
 * limit, transient 5xx, log archive expired) returns an empty list
 * and warns server-side; the feature page must keep rendering.
 *
 * Limit: 3 most recent failed runs per issue. The panel is for "what
 * went wrong recently," not full history — telemetry comments + the
 * timeline already cover history.
 */
export async function fetchRecentFailuresForIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  limit = 3,
): Promise<FailedRun[]> {
  let resp;
  try {
    resp = await octokit.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: 'dev-agent.yml',
      per_page: 30,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) {
      console.warn(
        `fetchRecentFailuresForIssue: ${owner}/${repo}#${issueNumber} — listWorkflowRuns failed (status=${status ?? 'unknown'})`,
        err,
      );
    }
    return [];
  }

  // Same bounded match as active-runs.ts — issue #12 must NOT match
  // a run named for #123.
  const issueMarkerRe = new RegExp(`#${issueNumber}(?!\\d)`);
  const candidates = resp.data.workflow_runs
    .filter((r) =>
      r.status === 'completed' &&
      (r.conclusion === 'failure' ||
        r.conclusion === 'startup_failure' ||
        r.conclusion === 'timed_out' ||
        r.conclusion === 'cancelled'),
    )
    .filter((r) => issueMarkerRe.test(r.display_title ?? ''))
    .slice(0, limit);

  // Per-run enrichment runs in parallel. Each call has its own
  // try/catch so one bad run doesn't poison the whole list.
  const enriched = await Promise.all(
    candidates.map(async (r): Promise<FailedRun> => {
      const base: FailedRun = {
        id: r.id,
        phase: parseField(r.display_title ?? '', /^(\S+)\s*→/),
        invocation_mode: parseField(r.display_title ?? '', /\(([^)]+)\)\s*$/),
        conclusion: r.conclusion ?? 'unknown',
        created_at: r.created_at,
        html_url: r.html_url,
        failed_step: null,
        log_tail: null,
      };

      try {
        const jobs = await octokit.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: r.id,
        });
        // Match the candidate filter above: a run can fail because a
        // job was cancelled or timed_out, not just `failure`. If we
        // only enriched conclusion='failure' here, the diagnostics
        // panel would silently show no step / no log tail for those
        // run types — exactly the diagnostic surface they need.
        const failingConclusions = new Set(['failure', 'cancelled', 'timed_out']);
        const failedJob = jobs.data.jobs.find(
          (j) => j.conclusion !== null && failingConclusions.has(j.conclusion),
        );
        // Same expansion at the step level — a cancelled job has
        // its terminal step as conclusion='cancelled', not 'failure'.
        const failedStep = failedJob?.steps?.find(
          (s) => s.conclusion !== null && failingConclusions.has(s.conclusion ?? ''),
        );
        if (failedStep) base.failed_step = failedStep.name;

        if (failedJob?.id) {
          base.log_tail = await fetchJobLogTail(octokit, owner, repo, failedJob.id);
        }
      } catch (err) {
        console.warn(
          `fetchRecentFailuresForIssue: enrich run ${r.id} failed`,
          err,
        );
      }

      return base;
    }),
  );

  return enriched;
}

/**
 * Fetch the tail of a job's log archive. The Actions API returns the
 * full log as a redirect to a (potentially large) text blob — read
 * it, keep the last `LOG_TAIL_LINES` non-empty lines.
 *
 * Returns null on any error: logs go away after a retention window,
 * and a missing tail is preferable to a failed render.
 */
async function fetchJobLogTail(
  octokit: Octokit,
  owner: string,
  repo: string,
  jobId: number,
): Promise<string | null> {
  try {
    // octokit returns the raw response (redirected to a text blob).
    const resp = await octokit.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: jobId,
      // request: { redirect: 'follow' } is the default in fetch-based clients
    });
    const raw = typeof resp.data === 'string' ? resp.data : '';
    if (!raw) return null;
    const lines = raw
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    return lines.slice(-LOG_TAIL_LINES).join('\n');
  } catch (err) {
    const status = (err as { status?: number }).status;
    // 410 = logs expired; 404 = startup_failure run with no archive.
    // Either way, return null silently — the panel still shows the
    // step name and run link.
    if (status === 410 || status === 404) return null;
    console.warn(`fetchJobLogTail: job ${jobId} log fetch failed`, err);
    return null;
  }
}

function parseField(title: string, re: RegExp): string | null {
  const m = title.match(re);
  return m ? m[1] : null;
}
