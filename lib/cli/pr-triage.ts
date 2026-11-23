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
 * Having decided, it wakes the fixer by dispatching the consumer's fixer
 * wrapper (`gh workflow run <FIXER_WORKFLOW> -f pr_number=N`). It used to post
 * `@claude` instead, but this runs on GITHUB_TOKEN, and a comment created with
 * GITHUB_TOKEN starts no `issue_comment` run — so every wake was a no-op while
 * the report said "Woken". A `workflow_dispatch` is the documented exception
 * that does start a run
 * (https://docs.github.com/en/actions/concepts/security/github_token), and it
 * needs no credential beyond `actions: write`.
 *
 * It still posts a comment per wake, without the mention: the comment is the
 * audit trail (what woke the fixer and why), the record the stand-down count
 * is read back from, and the blocker list the dispatched fixer is told to
 * read. Dropping the mention keeps the comment from ever becoming a second
 * trigger, should a consumer run the sweep on a token whose comments do start
 * runs.
 *
 * Optional env:
 *   PR_NUMBER        Triage only this PR instead of sweeping the repo.
 *   DRY_RUN          `true` reports what it would post without posting.
 *   MAX_REPEATS      Consecutive unchanged wakeups before standing down (4).
 *   FIXER_WORKFLOW   File name of the fixer wrapper to dispatch
 *                    (default `dev-agent-pr-review.yml`).
 *   GH_TOKEN         Passed through to `gh`. Needs `actions: write` to dispatch.
 *
 * Output: JSON to stdout — `{ actionable, waiting, woken, wakeFailed, wakeUnrecorded, writeFailed, labelFailed, wedged, ready }`.
 * Exit code: 0 when the sweep did what it reported; 2 when the GitHub reads
 * fail; 3 when any wake dispatch failed (the report is still printed). "Nothing
 * to do" is a normal, successful outcome and must not read as an error, but a
 * wake that did not happen must not read as one that did.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AUTOPILOT_AUTHORS,
  READY_LABEL,
  alreadyAnnouncedReady,
  isDevAgentBranch,
  isReadyToMerge,
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
import { alreadyAnnouncedFixCap } from '../fix-rounds';

/** Logins that leave reviews as bots rather than as people. */
const REVIEW_BOTS = new Set([
  'coderabbitai',
  'chatgpt-codex-connector',
  'claude',
  'github-actions',
]);

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
  /** True when any nested connection had a further page we did not read. */
  truncated?: boolean;
}

/**
 * Read every open pull request, asking for exactly the fields the triage uses.
 *
 * Deliberately not `gh pr list --json statusCheckRollup`. That flag expands to
 * a fixed fragment which also pulls `checkSuite.workflowRun` — a field nothing
 * here reads, and one the workflow token cannot see without `actions: read`.
 * The whole query then fails with "Resource not accessible by integration", so
 * every pull request goes untriaged. Two sweeps were lost to that, each time
 * granting one more permission to satisfy a field we do not want.
 *
 * Asking for less is the fix: this needs only `checks: read` and
 * `statuses: read`, and cannot break again when the canned fragment grows.
 *
 * @param repo - owner/name.
 * @returns Every open pull request, in the shape `toPullRequestState` expects.
 */
export function readOpenPullRequests(repo: string): RawPr[] {
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$endCursor:String){
    repository(owner:$owner,name:$name){
      pullRequests(states:OPEN,first:50,after:$endCursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          number headRefName isDraft reviewDecision
          labels(first:100){pageInfo{hasNextPage} nodes{name}}
          commits(last:1){nodes{commit{
            oid
            statusCheckRollup{contexts(first:100){
              pageInfo{hasNextPage}
              nodes{
                __typename
                ... on CheckRun{name status conclusion}
                ... on StatusContext{context state}
              }
            }}
          }}}
          reviews(last:100){pageInfo{hasNextPage} nodes{author{login} state commit{oid}}}
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
      '--jq', '.data.repository.pullRequests.nodes[]',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const n = JSON.parse(l) as {
        number: number;
        headRefName: string;
        isDraft: boolean;
        reviewDecision: string | null;
        labels?: { pageInfo?: { hasNextPage?: boolean }; nodes?: Array<{ name?: string }> };
        commits?: { nodes?: Array<{ commit?: { oid?: string; statusCheckRollup?: { contexts?: { pageInfo?: { hasNextPage?: boolean }; nodes?: unknown[] } } } }> };
        reviews?: { pageInfo?: { hasNextPage?: boolean }; nodes?: Array<{ author?: { login?: string } | null; state?: string; commit?: { oid?: string } | null }> };
      };
      const commit = n.commits?.nodes?.[0]?.commit;
      // Each of these is a bounded page. A truncated one is not evidence of
      // absence — the unseen entry could be the opt-out label, the stale
      // review, or the failing check — so the caller is told the view is
      // partial rather than being handed a confident-looking subset.
      const truncated =
        n.labels?.pageInfo?.hasNextPage === true ||
        n.reviews?.pageInfo?.hasNextPage === true ||
        commit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage === true;
      return {
        number: n.number,
        headRefName: n.headRefName,
        isDraft: n.isDraft,
        // GraphQL returns null where `gh pr list` returned "" for no decision.
        reviewDecision: n.reviewDecision ?? null,
        headRefOid: commit?.oid ?? '',
        statusCheckRollup: (commit?.statusCheckRollup?.contexts?.nodes ?? []) as RawPr['statusCheckRollup'],
        reviews: n.reviews?.nodes ?? [],
        labels: n.labels?.nodes ?? [],
        truncated,
      };
    });
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
    truncated: raw.truncated,
  };
}

/** What the sweep found and what it did about it. */
export interface TriageReport {
  /** PRs that need an agent. */
  actionable: PrTriage[];
  /** PRs whose only blocker is a check still running. */
  waiting: PrTriage[];
  /** PRs the sweep woke the fixer on (the dispatch was accepted). */
  woken: number[];
  /** PRs that needed a wake whose dispatch failed; nothing was recorded on them. */
  wakeFailed: number[];
  /** PRs woken (dispatch accepted) whose wake comment could not be posted. */
  wakeUnrecorded: number[];
  /** PRs where a ready or stood-down comment could not be written. */
  writeFailed: number[];
  /** PRs whose ready label could not be changed (reported; does not fail the job). */
  labelFailed: number[];
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
 * Add or remove a label on a PR.
 *
 * The label is a convenience for scanning the PR list; the comment is the
 * actual signal. A failure throws so the sweep can report it (`labelFailed`);
 * the sweep does not fail the job for it, because a repo that has never
 * created this label should not turn a successful sweep into a failed one.
 *
 * @param repo - owner/name.
 * @param number - PR number.
 * @param label - Label to set.
 * @param present - True to add, false to remove.
 * @throws Error when `gh pr edit` fails.
 */
export function setLabel(repo: string, number: number, label: string, present: boolean): void {
  const flag = present ? '--add-label' : '--remove-label';
  execFileSync('gh', ['pr', 'edit', String(number), '--repo', repo, flag, label], {
    encoding: 'utf8',
  });
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

/** Fixer wrapper the sweep dispatches when the caller names none. */
export const DEFAULT_FIXER_WORKFLOW = 'dev-agent-pr-review.yml';

/**
 * Check a fixer workflow file name before it reaches `gh workflow run`.
 *
 * It comes from a workflow input, so it is held to a bare `*.yml` / `*.yaml`
 * file name: no path, no leading dash that `gh` would read as a flag.
 *
 * @param name - Candidate file name.
 * @returns The same name when it is safe.
 * @throws Error when it is not a bare workflow file name.
 */
export function validateFixerWorkflow(name: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*\.ya?ml$/.test(name)) {
    throw new Error(`FIXER_WORKFLOW must be a workflow file name like dev-agent-pr-review.yml, got: ${name}`);
  }
  return name;
}

/**
 * Wake the fixer on one PR by dispatching the consumer's fixer wrapper.
 *
 * A dispatch, not a comment: this runs on GITHUB_TOKEN, and only
 * `workflow_dispatch` / `repository_dispatch` events created with that token
 * start a workflow run. The run is on the repository's default branch, which
 * is where GitHub reads the wrapper's `workflow_dispatch` trigger from.
 *
 * @param repo - owner/name.
 * @param number - PR number, passed as the wrapper's `pr_number` input.
 * @param workflow - Fixer wrapper file name (already validated).
 * @throws Error when `gh` cannot dispatch (missing `actions: write`, no such
 *   workflow, or a wrapper without a `workflow_dispatch` trigger).
 */
export function dispatchFixer(repo: string, number: number, workflow: string): void {
  execFileSync(
    'gh',
    ['workflow', 'run', workflow, '--repo', repo, '-f', `pr_number=${number}`],
    { encoding: 'utf8' },
  );
}

/** The side effects the sweep performs, injectable so tests can see them. */
export interface TriageEffects {
  postComment: (repo: string, number: number, body: string) => void;
  dispatchFixer: (repo: string, number: number, workflow: string) => void;
  setLabel: (repo: string, number: number, label: string, present: boolean) => void;
  readOpenPullRequests: (repo: string) => RawPr[];
  countUnresolvedThreads: (repo: string, number: number) => number;
  readComments: (repo: string, number: number) => CommentRecord[];
}

/** The real `gh`-backed effects. */
const GH_EFFECTS: TriageEffects = {
  postComment,
  dispatchFixer,
  setLabel,
  readOpenPullRequests,
  countUnresolvedThreads,
  readComments,
};

/**
 * Sweep a repo (or one PR), wake the fixer where it is needed, and report.
 *
 * A wake is dispatch first, comment second. The comment is what the next
 * sweep counts towards the stand-down cap, so it is written only once the
 * dispatch succeeded: a failed dispatch must not use up one of the attempts,
 * and must not be reported as woken. It goes in `wakeFailed` instead, and the
 * sweep carries on with the other PRs.
 *
 * @param repo - owner/name.
 * @param opts.onlyPr - Restrict to this PR number when given.
 * @param opts.dryRun - Decide and report, but post and dispatch nothing.
 * @param opts.maxRepeats - Unchanged wakeups before standing down.
 * @param opts.fixerWorkflow - Fixer wrapper file name to dispatch.
 * @param opts.effects - Side effects; the real `gh` calls unless a test
 *   substitutes them.
 * @returns What was found and what was done about it.
 */
export function runTriage(
  repo: string,
  {
    onlyPr,
    dryRun = false,
    maxRepeats = 4,
    fixerWorkflow = DEFAULT_FIXER_WORKFLOW,
    effects = GH_EFFECTS,
  }: {
    onlyPr?: number;
    dryRun?: boolean;
    maxRepeats?: number;
    fixerWorkflow?: string;
    effects?: TriageEffects;
  } = {},
): TriageReport {
  const { postComment, dispatchFixer, setLabel, readOpenPullRequests, countUnresolvedThreads, readComments } =
    effects;
  validateFixerWorkflow(fixerWorkflow);
  const all = readOpenPullRequests(repo);
  const prs: RawPr[] = onlyPr === undefined ? all : all.filter((p) => p.number === onlyPr);

  const report: TriageReport = {
    actionable: [], waiting: [], woken: [], wakeFailed: [], wakeUnrecorded: [], writeFailed: [], labelFailed: [], wedged: [], ready: [],
  };
  // A failed write on one PR must not end the sweep: every later PR would go
  // unexamined. Each write reports its failure and the loop moves on.
  const tryWrite = (pr: number, what: string, write: () => void, failed = report.writeFailed): boolean => {
    try {
      write();
      return true;
    } catch (err) {
      process.stderr.write(
        `could not ${what} on #${pr}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      failed.push(pr);
      return false;
    }
  };
  for (const raw of prs) {
    // Skip the thread query for branches we would never act on — it is the
    // expensive call in this sweep and most open PRs are not ours.
    if (!isDevAgentBranch(raw.headRefName)) continue;
    const state = toPullRequestState(raw, countUnresolvedThreads(repo, raw.number));
    const triage = triagePullRequest(state);
    const ready = isReadyToMerge(triage, state.checks.length);

    // Reconcile the label on every sweep, not only when announcing. Coupling
    // it to the one-time announcement left two holes: a failed label write was
    // never retried, and a PR that picked up a blocker after being announced
    // kept a `ready-to-merge` label that was no longer true — a list-scanning
    // signal that lies is worse than none.
    const labelled = state.labels.includes(READY_LABEL);
    if (!dryRun && ready !== labelled) {
      tryWrite(
        triage.number,
        'set the ready label',
        () => setLabel(repo, triage.number, READY_LABEL, ready),
        report.labelFailed,
      );
    }

    if (!triage.needsWork) {
      if (triage.waitingOnly) {
        report.waiting.push(triage);
        continue;
      }
      // Nothing blocking at all. Say so, once. An autopilot that reports only
      // problems and stays silent on success still makes you go and look,
      // which is the habit it exists to replace.
      //
      // `isReadyToMerge` is what separates "finished" from "not examined": a
      // draft, an opted-out PR, and one whose CI never ran all produce an
      // empty blocker list too.
      if (!ready) continue;

      // The label answers "already announced?" from data already in hand.
      // Reading every comment on every clean PR, on every sweep, forever, is a
      // permanent cost for a question the label settles for free; the comment
      // scan stays as the fallback for when a previous label write failed.
      if (labelled || alreadyAnnouncedReady(readComments(repo, triage.number))) continue;

      if (!dryRun && !tryWrite(triage.number, 'post the ready comment', () =>
        postComment(repo, triage.number, renderReadyComment(state)))) continue;
      report.ready.push(triage.number);
      continue;
    }
    report.actionable.push(triage);

    const comments = readComments(repo, triage.number);
    // The fixer already stood down on this PR and said so (lib/fix-rounds.ts).
    // A wake comment would start a run that refuses at once; its own notice is
    // the hand-over, so report the PR as stood down without posting again.
    if (alreadyAnnouncedFixCap(comments)) {
      report.wedged.push(triage.number);
      continue;
    }
    const decision = shouldWake(triage.signature, priorSignatures(comments), maxRepeats);

    if (decision.wake) {
      if (!dryRun) {
        try {
          dispatchFixer(repo, triage.number, fixerWorkflow);
        } catch (err) {
          process.stderr.write(
            `could not dispatch ${fixerWorkflow} for #${triage.number}: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
          report.wakeFailed.push(triage.number);
          continue;
        }
        // The fixer is already running, so this PR IS woken whatever happens to
        // the comment. A failed write must not end the sweep (later PRs would go
        // unexamined); it is reported in `wakeUnrecorded`, which fails the job.
        // Without the comment this wake is not counted toward the stand-down
        // cap; the fixer's own fix-round cap (lib/fix-rounds.ts) still bounds it.
        try {
          postComment(repo, triage.number, renderWakeComment(triage, decision));
        } catch (err) {
          process.stderr.write(
            `dispatched the fixer for #${triage.number} but could not post its wake comment: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
          report.wakeUnrecorded.push(triage.number);
        }
      }
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
      tryWrite(triage.number, 'post the stood-down comment', () =>
        postComment(repo, triage.number, renderWedgedComment(triage, decision)));
    }
    report.wedged.push(triage.number);
  }
  return report;
}

/**
 * CLI entry point: sweep, print JSON, and set exit code 3 if any wake or write failed.
 *
 * @returns Nothing.
 * @throws Error on invalid env input or a failed GitHub read (exit 2).
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
    fixerWorkflow: process.env.FIXER_WORKFLOW || DEFAULT_FIXER_WORKFLOW,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  // A wake that did not happen must not leave a green run behind it: that is
  // the silent failure this dispatch path replaced.
  if (report.wakeFailed.length > 0 || report.wakeUnrecorded.length > 0 || report.writeFailed.length > 0) {
    process.exitCode = 3;
  }
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
