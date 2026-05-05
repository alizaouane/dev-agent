import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { Proposal } from './types';

/**
 * "Freshness" annotation for a proposal: a deterministic heuristic
 * answer to "is this already done?". Surfaces on `/proposals` as a
 * pre-Resolve hint — dimmed row + pill — so the user can one-click
 * close items the queue surfaces but the world has already handled.
 *
 * **No LLM in v1.** Pure heuristics; runs on every page load. False
 * positives surface as a hint the user can ignore; the row never
 * auto-resolves. False negatives just leave the proposal looking
 * normal — recoverable.
 *
 * **Window for "since."** Proposals don't carry their own creation
 * timestamp (they're computed on demand), but the issue-backed sources
 * carry an issue_number which we use to fetch the real `created_at`.
 * Plan-derived proposals don't have one, so we fall back to a 14-day
 * "modified recently" window — reasonable for a checkbox the user
 * may have ticked offline since the last scan.
 */
export type FreshnessHint = {
  /** Single label so render code can branch on a stable string. */
  reason: string;
};

const PLAN_RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Per-source heuristics, dispatched in parallel. Each per-proposal
 * heuristic catches its own errors and returns `null` — the page-render
 * cost of one proposal misclassifying ("looks done but isn't") is
 * far smaller than the cost of one failure cascading and breaking the
 * whole hint pass.
 *
 * Returns a Map keyed by `Proposal.id`. Proposals without a hint are
 * absent from the map (caller checks `freshnessMap.has(p.id)` /
 * `.get(p.id)`).
 */
export async function enrichProposalsWithFreshness(
  octokit: Octokit,
  proposals: Proposal[],
): Promise<Map<string, FreshnessHint>> {
  const out = new Map<string, FreshnessHint>();
  const entries = await Promise.all(
    proposals.map(async (p) => {
      try {
        const hint = await hintForProposal(octokit, p);
        return hint ? ([p.id, hint] as const) : null;
      } catch {
        // Per-proposal failure → silently skip the hint. The proposal
        // still renders normally, just without the "likely done" pill.
        return null;
      }
    }),
  );
  for (const e of entries) {
    if (e) out.set(e[0], e[1]);
  }
  return out;
}

async function hintForProposal(
  octokit: Octokit,
  p: Proposal,
): Promise<FreshnessHint | null> {
  const repoMatch = p.repo.match(/^([^/]+)\/(.+)$/);
  if (!repoMatch) return null;
  const owner = repoMatch[1];
  const repo = repoMatch[2];

  switch (p.source) {
    case 'pending_spec':
      return hintPendingSpec(octokit, owner, repo, p);
    case 'unfinished_plan':
      return hintUnfinishedPlan(octokit, owner, repo, p);
    case 'bug_scout_finding':
    case 'unfinished_work_finding':
    case 'cleanup_finding':
      return hintIssueBackedFileFinding(octokit, owner, repo, p);
    case 'untriaged_issue':
      return hintUntriagedIssue(octokit, owner, repo, p);
    default:
      // Sources without a freshness signal in v1 (spec_drift,
      // stale_blocked_issue, competitor_watch).
      return null;
  }
}

/**
 * Pending spec: a merged PR's title or body references the spec slug.
 * The slug is in `meta.spec_slug`; we search the repo for merged PRs
 * mentioning it. Quote the slug so hyphenated names don't tokenize.
 */
async function hintPendingSpec(
  octokit: Octokit,
  owner: string,
  repo: string,
  p: Proposal,
): Promise<FreshnessHint | null> {
  const slug = String(p.meta?.spec_slug ?? '').trim();
  if (!slug) return null;
  const q = `"${slug}" repo:${owner}/${repo} type:pr is:merged`;
  const resp = await octokit.search.issuesAndPullRequests({ q, per_page: 1 });
  if ((resp.data.total_count ?? 0) === 0) return null;
  const pr = resp.data.items?.[0];
  const num = pr?.number;
  return {
    reason: num ? `merged PR #${num} mentions this spec` : 'a merged PR mentions this spec',
  };
}

/**
 * Per-line `unfinished_plan` proposals carry `meta.plan_file` and
 * `meta.line`. Without a per-proposal `created_at`, look for any
 * commit that touched the plan file in the last 14 days — if the
 * checkbox got flipped offline, we want to flag it for the user to
 * confirm.
 *
 * Rolled-up entries (no `#L<n>` in id) skip this hint: hinting
 * "the file was modified" on a 60-item rollup is noisy and the user
 * is going to open the file anyway.
 */
async function hintUnfinishedPlan(
  octokit: Octokit,
  owner: string,
  repo: string,
  p: Proposal,
): Promise<FreshnessHint | null> {
  if (!p.id.includes('#L')) return null;
  const planFile = String(p.meta?.plan_file ?? '').trim();
  if (!planFile) return null;

  const since = new Date(Date.now() - PLAN_RECENT_WINDOW_MS).toISOString();
  const resp = await octokit.repos.listCommits({
    owner,
    repo,
    path: planFile,
    since,
    per_page: 1,
  });
  const commits = (resp.data ?? []) as Array<{ commit?: { committer?: { date?: string } } }>;
  if (commits.length === 0) return null;
  const commitDate = commits[0]?.commit?.committer?.date;
  return {
    reason: commitDate
      ? `${planFile} modified ${formatRelativeAge(commitDate)} — checkbox may already be ticked`
      : `${planFile} modified recently — checkbox may already be ticked`,
  };
}

/**
 * Issue-backed scout finding (bug-scout / unfinished-work / cleanup):
 * the issue body contains `Location: \`<file>[:<line>]\``. If the file
 * has any commits since the issue was filed, the bug may have been
 * fixed in passing. Fetch the issue once for both `created_at` and
 * the location, then check commits.
 */
async function hintIssueBackedFileFinding(
  octokit: Octokit,
  owner: string,
  repo: string,
  p: Proposal,
): Promise<FreshnessHint | null> {
  const issueNumber = Number(p.meta?.issue_number ?? 0);
  if (!issueNumber) return null;

  const issue = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
  const body = (issue.data.body ?? '') as string;
  const file = parseLocationFile(body);
  if (!file) return null;
  const since = issue.data.created_at;
  if (!since) return null;

  const resp = await octokit.repos.listCommits({
    owner,
    repo,
    path: file,
    since,
    per_page: 1,
  });
  const commits = (resp.data ?? []) as Array<{ commit?: { committer?: { date?: string } } }>;
  if (commits.length === 0) return null;
  const commitDate = commits[0]?.commit?.committer?.date;
  return {
    reason: commitDate
      ? `${file} modified ${formatRelativeAge(commitDate)} after issue filed`
      : `${file} modified after issue filed`,
  };
}

/**
 * Untriaged issue: the body might reference a PR (`#<num>`) that's
 * already merged. Pull up to ~5 candidate refs from the body and check
 * each one's PR state. Anything merged → "addressed by PR #N."
 */
async function hintUntriagedIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  p: Proposal,
): Promise<FreshnessHint | null> {
  const issueNumber = Number(p.meta?.issue_number ?? 0);
  if (!issueNumber) return null;

  const issue = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
  const body = (issue.data.body ?? '') as string;
  const refs = parseHashRefs(body, issueNumber).slice(0, 5);
  if (refs.length === 0) return null;

  // Sequential is fine — at most 5 calls. Stops on first merged hit.
  for (const ref of refs) {
    try {
      const pr = await octokit.pulls.get({ owner, repo, pull_number: ref });
      if (pr.data.merged) {
        return { reason: `addressed by merged PR #${ref}` };
      }
    } catch {
      // 404 = not a PR (just an issue ref) or doesn't exist; skip.
      continue;
    }
  }
  return null;
}

/**
 * Pull a `Location: \`<file>[:<line>]\`` line out of an issue body.
 * Mirrors the format the scout workflows emit; tolerates with-or-
 * without the line suffix.
 */
function parseLocationFile(body: string): string | null {
  const m = body.match(/Location:\s*`([^`]+)`/);
  if (!m) return null;
  const raw = m[1].trim();
  // Strip trailing :<line> if present — listCommits takes a path.
  return raw.replace(/:\d+$/, '');
}

/**
 * Pull `#<num>` references from issue body. Excludes the issue's own
 * number (so a self-reference doesn't false-positive). Dedupes.
 */
function parseHashRefs(body: string, selfIssueNumber: number): number[] {
  const matches = body.matchAll(/(?:^|[^\w])#(\d+)\b/g);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of matches) {
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n === selfIssueNumber || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Compact relative-time string: "3d ago" / "2h ago" / "just now". Used
 * inside the freshness pill where we want a short hint, not a full
 * timestamp.
 */
function formatRelativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'recently';
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h ago`;
  return 'just now';
}
