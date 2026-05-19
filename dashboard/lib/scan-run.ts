/**
 * Shared types + pure decision logic for surfacing scout-run status in
 * the dashboard. `getLatestScanRun` (lib/actions.ts) produces a
 * `ScanRunStatus`; `interpretScanRun` turns it into a `ScanPhase` the
 * `ScanRunStatus` component renders. Kept framework-free so the decision
 * is unit-testable without a DOM.
 */

/** Latest-run snapshot returned by the `getLatestScanRun` server action. */
export type ScanRunStatus = {
  /** queued | in_progress | completed — or null when the repo has no runs. */
  status: string | null;
  /** success | failure | startup_failure | ... — null until completed. */
  conclusion: string | null;
  html_url: string | null;
  created_at: string | null;
};

/** What the UI should show for an in-flight scan. */
export type ScanPhase =
  | { kind: 'queued' }
  | { kind: 'running'; runUrl: string | null }
  | { kind: 'done'; ok: boolean; runUrl: string | null }
  | { kind: 'error'; message: string };

/** 60s of slack absorbs clock skew between the browser and GitHub. */
const SKEW_MS = 60_000;

/**
 * Classify the latest-run lookup for a scan dispatched at `since` (ms).
 * A run whose `created_at` predates `since - SKEW_MS` is treated as a
 * previous run — our dispatch hasn't registered yet → `queued`.
 */
export function interpretScanRun(
  result: ScanRunStatus | { error: string },
  since: number,
): ScanPhase {
  if ('error' in result) return { kind: 'error', message: result.error };

  // Date.parse yields NaN for a malformed timestamp; treat that (and a
  // missing created_at) as epoch 0 so the run classifies as `queued`
  // rather than silently falling through to `running`/`done`.
  const parsed = result.created_at ? Date.parse(result.created_at) : 0;
  const created = Number.isNaN(parsed) ? 0 : parsed;
  if (!result.status || created < since - SKEW_MS) {
    return { kind: 'queued' };
  }
  // `queued | waiting | requested | pending` are GitHub's pre-execution
  // run statuses — the run exists but no job has started. Show "queued",
  // not "running" (which is reserved for `in_progress`).
  if (['queued', 'waiting', 'requested', 'pending'].includes(result.status)) {
    return { kind: 'queued' };
  }
  if (result.status !== 'completed') {
    return { kind: 'running', runUrl: result.html_url };
  }
  return {
    kind: 'done',
    ok: result.conclusion === 'success',
    runUrl: result.html_url,
  };
}
