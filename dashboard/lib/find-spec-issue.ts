import 'server-only';

import type { Octokit } from '@octokit/rest';

import { parseSpecRefs } from './spec-approval-gate';

/**
 * Finding the issue a spec was already filed under.
 *
 * Both intake skills file a `state:spec-ready` issue the moment they record an
 * approval, and that issue's own body says to press **Start work** in the
 * dashboard. The panel used to create an issue unconditionally, so the normal
 * path produced two issues for one spec: a second run against the same work,
 * and an original left in the queue with nobody coming back for it.
 */

/** An open issue that already names a given spec. */
export interface SpecIssue {
  /** Issue number. */
  number: number;
  /** Link, for the error path to point at. */
  html_url: string;
  /** Body as filed, so the gate reads the same text the workflow will. */
  body: string | null;
  /** Current labels, including any approval override a human added. */
  labels: string[];
  /** The plan the issue's own body names, which may be a stale one. */
  planPath: string | null;
}

/**
 * Find every open issue whose body declares this spec.
 *
 * All of them, not just the oldest. A repo that already carries the duplicate
 * this change exists to stop has an old issue still at `state:spec-ready` and
 * a newer one already implementing; collapsing to the lowest number throws
 * away the only evidence that work has started, and the caller then clears a
 * guard by inspecting the wrong issue.
 *
 * Matching goes through `parseSpecRefs`, the same parser the approval gate and
 * the implement workflow use, so the panel cannot decide an issue is about one
 * spec while the gate reads it as another. A path quoted inside a fenced block
 * or backticks does not count, for that reason.
 *
 * @param octokit - Authenticated client.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param specPath - Repo-relative spec path to match.
 * @returns Matching open issues, oldest first. Empty when there are none.
 * @throws Whatever the listing throws — an unreadable issue list is not the
 *   same as an absent issue, and treating it as one files the duplicate this
 *   exists to prevent.
 */
export async function findOpenIssuesForSpec(
  octokit: Octokit,
  owner: string,
  repo: string,
  specPath: string,
): Promise<SpecIssue[]> {
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  const matches = issues
    // A pull request is an issue as far as this endpoint is concerned, and a
    // PR quoting the spec path is not the handoff issue.
    .filter((i) => !('pull_request' in i && i.pull_request))
    .filter((i) => parseSpecRefs(i.body)?.spec_path === specPath);

  // Oldest first: the first is the one intake filed, anything after it is a
  // duplicate, and the caller needs to see all of them to decide.
  return matches
    .sort((a, b) => a.number - b.number)
    .map((issue) => ({
      number: issue.number,
      html_url: issue.html_url,
      body: issue.body ?? null,
      labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      planPath: parseSpecRefs(issue.body)?.plan_path ?? null,
    }));
}

/**
 * Whether an issue is still waiting to be started.
 *
 * Presence of `state:spec-ready` is not enough: an issue can carry two state
 * labels when an earlier label flip half-applied, and one that also says
 * `state:implementing` is work in progress rather than work waiting.
 *
 * @param issue - A matched issue.
 * @returns True only when `state:spec-ready` is its sole state label.
 */
export function isWaitingToStart(issue: SpecIssue): boolean {
  const states = issue.labels.filter((l) => l.startsWith('state:'));
  return states.length === 1 && states[0] === 'state:spec-ready';
}

/**
 * Rewrite the `Spec:` and `Plan:` lines of a handoff issue body.
 *
 * A reused issue can name a plan that has since moved between the supported
 * trees. The approval is the authority on which pair was approved, and the
 * implement workflow reads these lines, so the body is brought into line with
 * the approval rather than being dispatched stale — which the gate would
 * refuse on a path mismatch the user cannot see or fix from the dashboard.
 *
 * Lines inside fenced blocks are left alone, matching what `parseSpecRefs`
 * reads, so an example in the body is never mistaken for the real reference.
 *
 * @param body - The issue body as filed.
 * @param specPath - The approved spec path.
 * @param planPath - The approved plan path, or null when there is no plan.
 * @returns The body with its reference lines replaced.
 */
export function withSpecRefs(
  body: string,
  specPath: string,
  planPath: string | null,
): string {
  const lines = body.split(/\r?\n/);
  const fences = lines.flatMap((line, i) => (/^ {0,3}(```|~~~)/.test(line) ? [i] : []));
  const fenced = new Set<number>();
  for (let i = 0; i + 1 < fences.length; i += 2) {
    for (let n = fences[i]; n <= fences[i + 1]; n++) fenced.add(n);
  }
  const specLine = lines.findIndex(
    (l, i) => !fenced.has(i) && /^\s*Spec:\s*\S+\.md\s*$/.test(l),
  );
  const planLine = lines.findIndex(
    (l, i) => !fenced.has(i) && /^\s*Plan:\s*\S+\.md\s*$/.test(l),
  );
  const out = [...lines];
  if (specLine !== -1) out[specLine] = `Spec: ${specPath}`;
  if (planLine !== -1) {
    if (planPath) out[planLine] = `Plan: ${planPath}`;
    else out.splice(planLine, 1);
  } else if (planPath && specLine !== -1) {
    out.splice(specLine + 1, 0, `Plan: ${planPath}`);
  }
  return out.join('\n');
}

/**
 * The state label an issue currently carries.
 *
 * @param issue - A matched issue.
 * @returns The `state:*` label, or null when it has none.
 */
export function stateLabel(issue: SpecIssue): string | null {
  return issue.labels.find((l) => l.startsWith('state:')) ?? null;
}
