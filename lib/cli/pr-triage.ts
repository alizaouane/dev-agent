#!/usr/bin/env tsx
/**
 * pr-triage — list the dev-agent pull requests that need an agent's attention.
 *
 * The sweep half of the autopilot. It answers one question for a whole repo:
 * which open dev-agent PRs are sitting on a failing check, an unresolved review
 * thread, a stale bot review, or a changes-requested verdict?
 *
 * This exists because the loop that used to answer it ran as a Stop hook on the
 * operator's laptop, so it only ran while a session was open and the machine
 * awake — which made the automation depend on the attention it was written to
 * replace. In a scheduled workflow it runs whether or not anyone is looking.
 *
 * Reads are done through the GitHub CLI, which is present on every runner and
 * already authenticated there. Review threads are paginated deliberately: an
 * unpaginated first page reports "all resolved" while unresolved threads sit on
 * page two, which is how a PR silently looks finished.
 *
 * Required env:
 *   REPO             owner/name of the repo to sweep.
 *
 * Having decided, it wakes the fixer the way a human would: by posting
 * `@claude` on the PR. That is the trigger `phase-pr-review` already listens
 * for, so this works unchanged in every wired consumer repo with no new
 * plumbing, and the comment doubles as the audit trail — anyone reading the
 * thread later can see what woke it and why.
 *
 * Optional env:
 *   PR_NUMBER        Triage only this PR instead of sweeping the repo.
 *   DRY_RUN          `true` reports what it would post without posting.
 *   MAX_REPEATS      Consecutive unchanged wakeups before standing down (4).
 *   GH_TOKEN         Passed through to `gh`.
 *
 * Output: JSON to stdout — `{ actionable, waiting, woken, wedged }`.
 * Exit code: 0 always, unless the GitHub calls themselves fail (2). "Nothing to
 * do" is a normal, successful outcome and must not read as an error.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AUTOPILOT_AUTHORS,
  READY_LABEL,
  alreadyAnnouncedReady,
  isDevAgentBranch,
  priorSignatures,
  renderReadyComment,
  renderWakeComment,
  renderWedgedComment,
  shouldWake,
  triagePullRequest,
  type CommentRecord,
  type PrTriage,
  type PullRequestState,
} from '../pr-blockers';

/** Logins that leave reviews as bots rather than as people. */
const REVIEW_BOTS = new Set([
  'coderabbitai',
  'chatgpt-codex-connector',
  'claude',
  'github-actions',
]);

/**
 * Run a `gh` command and parse its stdout as JSON.
 *
 * @param args - Arguments after `gh`.
 * @returns The parsed response.
 * @throws If `gh` exits non-zero or emits unparseable output.
 */
function gh<T>(args: string[]): T {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out) as T;
}

/** Shape of one PR as `gh pr list` returns it with the fields we ask for. */
interface RawPr {
  number: number;
  headRefName: string;
  isDraft: boolean;
  reviewDecision: string | null;
  headRefOid: string;
  statusCheckRollup?: Array<{
    name?: string;
    context?: string;
    conclusion?: string | null;
    status?: string | null;
    state?: string | null;
  }> | null;
  reviews?: Array<{
    author?: { login?: string } | null;
    state?: string;
    commit?: { oid?: string } | null;
  }> | null;
  labels?: Array<{ name?: string }> | null;
}

/**
 * Normalize `gh`'s check rollup, which mixes two shapes.
 *
 * A CheckRun carries `status` plus `conclusion`; a StatusContext carries only
 * `state`. Flattening them here keeps the branching out of the triage rules,
 * where a missed shape would read as "no checks" and pass a broken PR.
 *
 * @param rollup - The `statusCheckRollup` field.
 * @returns Checks with a single uppercase conclusion, null while running.
 */
export function normalizeChecks(rollup: RawPr['statusCheckRollup']): PullRequestState['checks'] {
  return (rollup ?? []).map((c) => {
    const name = c.name ?? c.context ?? 'unnamed check';
    // StatusContext: `state` is the whole story.
    if (c.state) return { name, conclusion: c.state.toUpperCase() };
    // CheckRun: a conclusion only exists once it finished.
    if (c.status && c.status.toUpperCase() !== 'COMPLETED') return { name, conclusion: null };
    return { name, conclusion: c.conclusion ? c.conclusion.toUpperCase() : null };
  });
}

/**
 * Count unresolved review threads across every page.
 *
 * @param repo - owner/name.
 * @param number - PR number.
 * @returns How many threads are still open.
 */
export function countUnresolvedThreads(repo: string, number: number): number {
  const [owner, name] = repo.split('/');
  // The cursor variable MUST be named `endCursor`: that is the name `gh api
  // graphql --paginate` injects between requests. Called anything else, page
  // two is never fetched — and `gh` errors on the undefined variable, which
  // would abort the sweep for every other PR in the repo. Which is the exact
  // failure this function exists to prevent, since an unpaginated first page
  // reports "all resolved" while unresolved threads sit on page two.
  const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        reviewThreads(first:100,after:$endCursor){
          pageInfo{hasNextPage endCursor}
          nodes{isResolved}
        }
      }
    }
  }`;
  const raw = execFileSync(
    'gh',
    [
      'api', 'graphql', '--paginate',
      '-f', `query=${query}`,
      // -f keeps these strings. -F would coerce a numeric-only owner or repo
      // name to a JSON number, which fails the String! type and aborts the
      // whole sweep, not just this PR.
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-F', `number=${number}`,
      '--jq', '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)]|length',
    ],
    { encoding: 'utf8' },
  );
  // --paginate emits one count per page; they sum to the total.
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .reduce((sum, l) => sum + Number(l), 0);
}

/**
 * Turn one raw PR plus its thread count into the triage input shape.
 *
 * @param raw - The PR as `gh` returned it.
 * @param unresolvedThreadCount - Threads still open on it.
 * @returns The normalized state.
 */
export function toPullRequestState(
  raw: RawPr,
  unresolvedThreadCount: number,
): PullRequestState {
  return {
    number: raw.number,
    headRefName: raw.headRefName,
    labels: (raw.labels ?? []).map((l) => l.name ?? '').filter((n) => n !== ''),
    headOid: raw.headRefOid,
    isDraft: raw.isDraft,
    reviewDecision: raw.reviewDecision,
    checks: normalizeChecks(raw.statusCheckRollup),
    reviews: (raw.reviews ?? []).map((r) => {
      const author = (r.author?.login ?? '').replace(/\[bot\]$/, '');
      return {
        author,
        state: r.state ?? 'COMMENTED',
        commitOid: r.commit?.oid ?? '',
        isBot: REVIEW_BOTS.has(author),
      };
    }),
    unresolvedThreadCount,
  };
}

/** What the sweep found and what it did about it. */
export interface TriageReport {
  /** PRs that need an agent. */
  actionable: PrTriage[];
  /** PRs whose only blocker is a check still running. */
  waiting: PrTriage[];
  /** PRs the sweep woke the fixer on. */
  woken: number[];
  /** PRs the sweep stood down on, having tried and not moved them. */
  wedged: number[];
  /** PRs announced as ready to merge on this sweep. */
  ready: number[];
}

/**
 * Read every comment on a PR, oldest first, with its author.
 *
 * Paginated, and via GraphQL rather than `gh pr view --json comments`, which
 * caps at 100. On exactly the PRs this feature targets — several bot review
 * cycles deep — that cap silently hides the autopilot's own recent history,
 * so every sweep would read "no prior attempts" and wake the fixer again with
 * the stand-down cap counting a truncated list.
 *
 * The author travels with the body because the caller must not count a comment
 * it did not write; see `priorSignatures`.
 *
 * @param repo - owner/name.
 * @param number - PR number.
 * @returns Every comment, oldest first.
 */
export function readComments(repo: string, number: number): CommentRecord[] {
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        comments(first:100,after:$endCursor){
          pageInfo{hasNextPage endCursor}
          nodes{ body author{login} }
        }
      }
    }
  }`;
  const raw = execFileSync(
    'gh',
    [
      'api', 'graphql', '--paginate',
      '-f', `query=${query}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-F', `number=${number}`,
      '--jq', '.data.repository.pullRequest.comments.nodes[] | {author: (.author.login // ""), body: (.body // "")}',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  // --jq emits one JSON object per line, across every page.
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as CommentRecord);
}

/**
 * Add a label to a PR, ignoring a failure.
 *
 * The label is a convenience for scanning the PR list; the comment is the
 * actual signal. A repo that has never created this label should not turn a
 * successful announcement into a failed sweep.
 *
 * @param repo - owner/name.
 * @param number - PR number.
 * @param label - Label to add.
 */
export function addLabel(repo: string, number: number, label: string): void {
  try {
    execFileSync('gh', ['pr', 'edit', String(number), '--repo', repo, '--add-label', label], {
      encoding: 'utf8',
    });
  } catch (err) {
    process.stderr.write(
      `could not add ${label} to #${number}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Post a comment on a PR.
 *
 * @param repo - owner/name.
 * @param number - PR number.
 * @param body - Comment body, passed as a file to avoid any shell quoting.
 */
export function postComment(repo: string, number: number, body: string): void {
  execFileSync('gh', ['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'], {
    input: body,
    encoding: 'utf8',
  });
}

/**
 * Sweep a repo (or one PR), wake the fixer where it is needed, and report.
 *
 * @param repo - owner/name.
 * @param opts.onlyPr - Restrict to this PR number when given.
 * @param opts.dryRun - Decide and report, but post nothing.
 * @param opts.maxRepeats - Unchanged wakeups before standing down.
 * @returns What was found and what was done about it.
 */
export function runTriage(
  repo: string,
  { onlyPr, dryRun = false, maxRepeats = 4 }: {
    onlyPr?: number;
    dryRun?: boolean;
    maxRepeats?: number;
  } = {},
): TriageReport {
  const fields =
    'number,headRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup,reviews,labels';
  const prs: RawPr[] = onlyPr
    ? [gh<RawPr>(['pr', 'view', String(onlyPr), '--repo', repo, '--json', fields])]
    : gh<RawPr[]>(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', fields]);

  const report: TriageReport = { actionable: [], waiting: [], woken: [], wedged: [], ready: [] };
  for (const raw of prs) {
    // Skip the thread query for branches we would never act on — it is the
    // expensive call in this sweep and most open PRs are not ours.
    if (!isDevAgentBranch(raw.headRefName)) continue;
    const triage = triagePullRequest(
      toPullRequestState(raw, countUnresolvedThreads(repo, raw.number)),
    );
    if (!triage.needsWork) {
      if (triage.waitingOnly) {
        report.waiting.push(triage);
        continue;
      }
      // Nothing blocking at all. Say so, once. An autopilot that reports only
      // problems and stays silent on success still makes you go and look,
      // which is the habit it exists to replace.
      const comments = readComments(repo, triage.number);
      if (!alreadyAnnouncedReady(comments)) {
        if (!dryRun) {
          const state = toPullRequestState(raw, 0);
          postComment(repo, triage.number, renderReadyComment(state));
          addLabel(repo, triage.number, READY_LABEL);
        }
        report.ready.push(triage.number);
      }
      continue;
    }
    report.actionable.push(triage);

    const comments = readComments(repo, triage.number);
    const decision = shouldWake(triage.signature, priorSignatures(comments), maxRepeats);

    if (decision.wake) {
      if (!dryRun) postComment(repo, triage.number, renderWakeComment(triage, decision));
      report.woken.push(triage.number);
      continue;
    }
    // Stood down. Say so once, then stay quiet: a PR the autopilot has
    // silently given up on looks exactly like one it is still working, which
    // is the situation this whole mechanism exists to prevent.
    const alreadySaid = comments.some(
      (c) => AUTOPILOT_AUTHORS.includes(c.author) && c.body.includes('<!-- wedged -->'),
    );
    if (!alreadySaid && !dryRun) {
      postComment(repo, triage.number, renderWedgedComment(triage, decision));
    }
    report.wedged.push(triage.number);
  }
  return report;
}

/**
 * CLI entry point: sweep, print JSON, exit 0.
 *
 * @returns Nothing.
 */
function main(): void {
  const repo = process.env.REPO;
  if (!repo || !repo.includes('/')) throw new Error('REPO required, as owner/name');
  const onlyPr = process.env.PR_NUMBER ? Number(process.env.PR_NUMBER) : undefined;
  if (onlyPr !== undefined && !Number.isInteger(onlyPr)) {
    throw new Error(`PR_NUMBER must be an integer, got: ${process.env.PR_NUMBER}`);
  }
  // `max_repeats` is an unrestricted `number` on the reusable workflow, so a
  // direct workflow_call can pass 0, a negative, or a fraction. Zero or less
  // stands the autopilot down on the first PR it looks at — the feature
  // silently disabled by a plausible-looking input.
  let maxRepeats: number | undefined;
  if (process.env.MAX_REPEATS) {
    maxRepeats = Number(process.env.MAX_REPEATS);
    if (!Number.isInteger(maxRepeats) || maxRepeats < 1) {
      throw new Error(`MAX_REPEATS must be a positive integer, got: ${process.env.MAX_REPEATS}`);
    }
  }

  const report = runTriage(repo, {
    onlyPr,
    dryRun: process.env.DRY_RUN === 'true',
    maxRepeats,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`pr-triage failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
