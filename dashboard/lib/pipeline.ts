import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { RepoInfo } from './repos';
import { parseTelemetry, type ParsedTelemetry } from '@/lib/telemetry';

/**
 * The full state-label vocabulary used by the engine. Mirrors the labels
 * applied by the workflow and the engine's spec→implement→ship pipeline.
 *
 * Keep in sync with the engine's state machine — in particular, terminal vs.
 * non-terminal classification (see {@link TERMINAL_STATES}) is what determines
 * whether an issue is fetched from the open or closed bucket.
 */
export type StateLabel =
  | 'state:proposed'
  | 'state:scoping'
  | 'state:spec-ready'
  | 'state:implementing'
  | 'state:pr-review'
  | 'state:staging-deployed'
  | 'state:ready-to-promote'
  | 'state:promoting'
  | 'state:done'
  | 'state:blocked'
  | 'state:abandoned'
  | 'state:rolled-back';

/**
 * One row in the dashboard's pipeline view. Aggregates the issue's identity,
 * its current state, and the most recent telemetry comment (if any) so the
 * UI can render activity without an extra round-trip per issue.
 */
export type FeatureItem = {
  repo: string;
  issue_number: number;
  title: string;
  state: StateLabel;
  age_seconds: number;
  last_telemetry: ParsedTelemetry | null;
  blockers: string[];
  html_url: string;
};

const TERMINAL_STATES = new Set<StateLabel>([
  'state:done',
  'state:abandoned',
  'state:rolled-back',
]);

/**
 * Open-bucket state labels — issues we expect to see on the live
 * pipeline. Each one is queried independently since GitHub's REST
 * filter is AND across labels (see `listIssuesByAnyLabel` below).
 */
const OPEN_STATE_LABELS: readonly StateLabel[] = [
  'state:scoping',
  'state:spec-ready',
  'state:implementing',
  'state:pr-review',
  'state:staging-deployed',
  'state:ready-to-promote',
  'state:promoting',
  'state:blocked',
];

const CLOSED_STATE_LABELS: readonly StateLabel[] = [
  'state:done',
  'state:abandoned',
  'state:rolled-back',
];

const NEEDS_ACTION_STATES = new Set<StateLabel>([
  'state:spec-ready',
  'state:pr-review',
  'state:ready-to-promote',
  'state:blocked',
]);

/**
 * True if `state` is one of the terminal labels (done / abandoned / rolled-back).
 * Accepts a plain string so callers don't need to narrow before calling.
 */
export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state as StateLabel);
}

/**
 * True if the issue is in a state that requires a human to act before the
 * pipeline can move forward — used to drive the dashboard's "needs action"
 * filter. In-flight states (implementing, staging-deployed, promoting) are
 * deliberately excluded: the agent is doing the work, not the human.
 */
export function needsActionFilter(item: FeatureItem): boolean {
  return NEEDS_ACTION_STATES.has(item.state);
}

function pickStateLabel(labels: Array<string | { name?: string }>): StateLabel | null {
  for (const l of labels) {
    const name = typeof l === 'string' ? l : l.name ?? '';
    if (name.startsWith('state:')) return name as StateLabel;
  }
  return null;
}

/**
 * Server-only: fetch all state-labeled issues across the given repos and
 * shape them into `FeatureItem`s suitable for the dashboard pipeline view.
 *
 * For each repo we:
 *  1. List all open issues that carry one of the non-terminal `state:*` labels
 *     (one paginated GitHub call per repo, scoped via the `labels` filter so
 *     untagged issues — bug reports, discussion, etc. — are skipped server-side).
 *  2. If `include_terminal` is true, additionally fetch closed issues with
 *     terminal `state:*` labels so the UI can show recently-shipped work.
 *  3. For each surviving issue, walk its comments newest-first to find the
 *     latest one that parses as a telemetry block — this becomes
 *     `last_telemetry` and powers the "last activity" summary.
 *
 * Per-repo errors (404, network blip, rate limit) are logged and the loop
 * continues with the next repo: one misbehaving repo should not blank out
 * the dashboard for every other repo the user owns.
 */
export async function fetchPipeline(
  octokit: Octokit,
  repos: RepoInfo[],
  opts: { include_terminal?: boolean } = {},
): Promise<FeatureItem[]> {
  const include_terminal = opts.include_terminal ?? false;
  const all: FeatureItem[] = [];

  for (const r of repos) {
    let issues: Array<{
      number: number;
      title: string;
      labels: Array<string | { name?: string }>;
      updated_at: string;
      html_url: string;
      comments: number;
    }>;
    // GitHub's REST `issues.listForRepo` treats a comma-separated
    // `labels` filter as AND — the issue must carry every label in the
    // list. The pipeline wants OR (any one of the state labels), and
    // since no issue can simultaneously be `state:scoping` AND
    // `state:implementing` AND `state:done`, the old multi-label query
    // returned zero issues and the page silently rendered empty. Fix:
    // one paginated call per state label, then dedupe by issue number.
    // The per-label calls run in parallel; one bad call doesn't poison
    // the result set.
    try {
      issues = await listIssuesByAnyLabel(
        octokit,
        r.owner,
        r.name,
        'open',
        OPEN_STATE_LABELS,
      );
      if (include_terminal) {
        const closed = await listIssuesByAnyLabel(
          octokit,
          r.owner,
          r.name,
          'closed',
          CLOSED_STATE_LABELS,
        );
        // Defensive dedupe across open/closed buckets: a misbehaving
        // server (or a test fixture that ignores the `state` filter)
        // could return the same issue in both. Key on issue number.
        const seen = new Set<number>(issues.map((i) => i.number));
        for (const c of closed) {
          if (!seen.has(c.number)) {
            issues.push(c);
            seen.add(c.number);
          }
        }
      }
    } catch (err) {
      console.warn(`fetchPipeline: failed for ${r.owner}/${r.name}:`, err);
      continue;
    }

    for (const i of issues) {
      const state = pickStateLabel(i.labels);
      if (!state) continue;
      if (!include_terminal && isTerminalState(state)) continue;

      let lastTelemetry: ParsedTelemetry | null = null;
      try {
        // listComments returns oldest-first by default. A single page of 30
        // would return the OLDEST 30 comments, missing all recent activity
        // — so we paginate fully and walk newest-first to find the latest
        // telemetry. Per-issue comment counts are typically small (telemetry
        // + approvals only), so the cost is minimal.
        const comments: Array<{ body?: string }> = await octokit.paginate(
          octokit.issues.listComments,
          {
            owner: r.owner,
            repo: r.name,
            issue_number: i.number,
            per_page: 100,
          },
        );
        for (let idx = comments.length - 1; idx >= 0; idx--) {
          const t = parseTelemetry(comments[idx].body ?? '');
          if (t) {
            lastTelemetry = t;
            break;
          }
        }
      } catch (err) {
        console.warn(
          `fetchPipeline: comments fetch failed for ${r.owner}/${r.name}#${i.number}:`,
          err,
        );
      }

      const updated = new Date(i.updated_at).getTime();
      const ageSec = Math.max(0, Math.floor((Date.now() - updated) / 1000));

      all.push({
        repo: `${r.owner}/${r.name}`,
        issue_number: i.number,
        title: i.title,
        state,
        age_seconds: ageSec,
        last_telemetry: lastTelemetry,
        blockers: state === 'state:blocked' ? ['see issue comments'] : [],
        html_url: i.html_url,
      });
    }
  }

  return all;
}

/**
 * OR-filter helper for GitHub's issues.listForRepo. We make one
 * paginated call per label and merge results, deduping by issue
 * number. Per-label calls run in parallel; a single failed call
 * (e.g., a transient 5xx) is logged and treated as empty so the
 * other label buckets still surface.
 *
 * Why this exists: the REST endpoint's `labels=a,b,c` filter is AND,
 * not OR. Multiple state labels passed as a single comma string
 * silently returned zero issues — the bug that hid every in-flight
 * feature from the pipeline view until this fix.
 */
type PipelineIssue = {
  number: number;
  title: string;
  labels: Array<string | { name?: string }>;
  updated_at: string;
  html_url: string;
  comments: number;
};

async function listIssuesByAnyLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  state: 'open' | 'closed',
  labels: readonly StateLabel[],
): Promise<PipelineIssue[]> {
  const buckets = await Promise.all(
    labels.map(async (label): Promise<PipelineIssue[]> => {
      try {
        return (await octokit.paginate(octokit.issues.listForRepo, {
          owner,
          repo,
          state,
          labels: label,
          per_page: 100,
        })) as PipelineIssue[];
      } catch (err) {
        console.warn(
          `listIssuesByAnyLabel: ${owner}/${repo} state=${state} label=${label} failed`,
          err,
        );
        return [];
      }
    }),
  );

  const seen = new Map<number, PipelineIssue>();
  for (const bucket of buckets) {
    for (const issue of bucket) {
      if (!seen.has(issue.number)) seen.set(issue.number, issue);
    }
  }
  return Array.from(seen.values());
}
