/**
 * PR blocker triage — what is stopping this pull request from being mergeable,
 * expressed as data rather than as a person noticing.
 *
 * The same rules already exist as a Stop hook on the operator's laptop
 * (`~/.claude/hooks/pr-review-loop.sh`). That hook only runs while a Claude
 * Code session is open and the machine is awake, which makes the loop depend on
 * exactly the attention it was written to replace. This module is the rules
 * half, extracted so a scheduled workflow can run them in the cloud.
 *
 * The rules are deliberately identical to the hook's, including the two that
 * are easy to leave out and are the usual reason a PR sits: a bot review is
 * stale whenever it sits on a commit older than HEAD (every push causes this,
 * whatever the push contained), and unresolved threads must be counted across
 * all pages, because an unpaginated first page reports "all resolved" while
 * unresolved ones sit on page two.
 */

/** Check conclusions that mean a check ran and did not pass. */
export const FAILED_CONCLUSIONS: readonly string[] = [
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
];

/** Check conclusions that mean a check has not finished yet. */
export const PENDING_CONCLUSIONS: readonly string[] = ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING'];

/** One check run or commit status on the PR head. */
export interface CheckState {
  name: string;
  /** Normalized conclusion, uppercased. Null while still running. */
  conclusion: string | null;
  /** True when the check is required by branch protection, when known. */
  required?: boolean;
}

/** One review left on the PR. */
export interface ReviewState {
  author: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED. */
  state: string;
  /** Commit the review was left on. */
  commitOid: string;
  /** True when the author is a review bot rather than a person. */
  isBot: boolean;
}

/** Label that pauses the autopilot on one pull request. */
export const OFF_LABEL = 'autopilot:off';

/** Everything the triage needs to know about one pull request. */
export interface PullRequestState {
  number: number;
  headRefName: string;
  /** The PR's label names. */
  labels: string[];
  headOid: string;
  isDraft: boolean;
  /** GitHub's own verdict: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null. */
  reviewDecision: string | null;
  checks: CheckState[];
  reviews: ReviewState[];
  /** Count of unresolved review threads, gathered across ALL pages. */
  unresolvedThreadCount: number;
}

/** Why a pull request is not ready, and what would clear it. */
export interface Blocker {
  kind: 'failing-check' | 'running-check' | 'unresolved-threads' | 'stale-bot-review' | 'changes-requested';
  /** One sentence naming the blocker, for an issue comment or a log line. */
  detail: string;
}

/** The triage verdict for one pull request. */
export interface PrTriage {
  number: number;
  headRefName: string;
  blockers: Blocker[];
  /** True when something needs doing and an agent could do it. */
  needsWork: boolean;
  /** True when the only thing to do is wait for a check to finish. */
  waitingOnly: boolean;
  /** Stable signature of the blocker set, for detecting a stuck loop. */
  signature: string;
}

/** Branch shapes dev-agent owns and may act on unattended. */
export const DEV_AGENT_BRANCH_PATTERNS: readonly RegExp[] = [
  /^feat\/dev-agent-issue-\d+$/,
  /^dev-agent\/spec-[A-Za-z0-9._-]+$/,
];

/**
 * Whether a branch is one dev-agent authored and may push to unattended.
 *
 * An allowlist, not a denylist: an agent that pushes to a branch a human is
 * working on is worse than one that does nothing.
 *
 * @param headRefName - The PR's head branch name.
 * @returns True when the branch matches a dev-agent-owned shape.
 */
export function isDevAgentBranch(headRefName: string): boolean {
  return DEV_AGENT_BRANCH_PATTERNS.some((re) => re.test(headRefName));
}

/**
 * Find every bot review that sits on a commit older than the PR head.
 *
 * A push stales a bot review whatever the push contained, so this is the
 * most frequent reason a PR looks reviewed while nothing has read the current
 * code. Only the newest review per bot counts — an older stale one behind a
 * fresh review from the same bot is just history.
 *
 * @param pr - The pull request's state.
 * @returns The bot logins whose latest review predates HEAD.
 */
export function staleBotReviews(pr: PullRequestState): string[] {
  const latest = new Map<string, ReviewState>();
  for (const review of pr.reviews) {
    if (!review.isBot) continue;
    // reviews arrive oldest-first, so a later entry replaces an earlier one.
    latest.set(review.author, review);
  }
  return [...latest.entries()]
    .filter(([, review]) => review.commitOid !== pr.headOid)
    .map(([author]) => author)
    .sort();
}

/**
 * Triage one pull request into the list of things stopping it.
 *
 * Two PRs return no blockers regardless of state. A draft is a deliberate
 * "not yet", and policing it would fight the author. A PR labelled
 * `autopilot:off` is a person saying they have taken it over — the wake
 * comment tells them to use that label, so it has to actually work.
 *
 * @param pr - The pull request's state.
 * @returns The blockers, with flags describing what kind of attention they need.
 */
export function triagePullRequest(pr: PullRequestState): PrTriage {
  const blockers: Blocker[] = [];

  if (!pr.isDraft && !pr.labels.includes(OFF_LABEL)) {
    const failing = pr.checks.filter(
      (c) => c.conclusion !== null && FAILED_CONCLUSIONS.includes(c.conclusion),
    );
    if (failing.length > 0) {
      blockers.push({
        kind: 'failing-check',
        detail: `${failing.length} failing check(s): ${failing.map((c) => c.name).join(', ')}`,
      });
    }

    const running = pr.checks.filter(
      (c) => c.conclusion === null || PENDING_CONCLUSIONS.includes(c.conclusion),
    );
    if (running.length > 0) {
      blockers.push({
        kind: 'running-check',
        detail: `${running.length} check(s) still running: ${running.map((c) => c.name).join(', ')}`,
      });
    }

    if (pr.unresolvedThreadCount > 0) {
      blockers.push({
        kind: 'unresolved-threads',
        detail: `${pr.unresolvedThreadCount} unresolved review thread(s)`,
      });
    }

    const stale = staleBotReviews(pr);
    if (stale.length > 0) {
      blockers.push({
        kind: 'stale-bot-review',
        detail: `stale bot review(s) — ${stale.join(', ')} last reviewed a commit older than ${pr.headOid.slice(0, 8)}`,
      });
    }

    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      blockers.push({ kind: 'changes-requested', detail: 'reviewDecision is CHANGES_REQUESTED' });
    }
  }

  // A check that is merely running needs time, not an agent. Dispatching a fix
  // run against it would spend a model call to discover that CI is still going.
  const actionable = blockers.filter((b) => b.kind !== 'running-check');

  return {
    number: pr.number,
    headRefName: pr.headRefName,
    blockers,
    needsWork: actionable.length > 0,
    waitingOnly: actionable.length === 0 && blockers.length > 0,
    signature: blockers.map((b) => b.kind).sort().join('|'),
  };
}

/**
 * Pick the pull requests a scheduled sweep should act on.
 *
 * @param prs - Every open pull request in the repo.
 * @returns Triage results for dev-agent branches that need an agent, newest last.
 */
export function selectActionable(prs: PullRequestState[]): PrTriage[] {
  return prs
    .filter((pr) => isDevAgentBranch(pr.headRefName))
    .map(triagePullRequest)
    .filter((t) => t.needsWork);
}

/** Marker that identifies a comment this autopilot wrote. */
export const AUTOPILOT_MARKER = '<!-- dev-agent:pr-autopilot -->';

/** Whether to wake the fixer on a PR, and why. */
export interface WakeDecision {
  wake: boolean;
  /** How many consecutive prior wakeups saw this exact blocker set. */
  repeats: number;
  reason: 'new-blockers' | 'unchanged-blockers' | 'wedged';
}

/**
 * Decide whether to wake the fixer, given what this autopilot already said.
 *
 * Two failure modes to avoid, and they pull in opposite directions. Waking on
 * every sweep turns a PR that genuinely needs a human into a comment thread
 * that costs a model call every twenty minutes. Never re-waking means one
 * missed run leaves the PR stuck forever.
 *
 * The compromise is the one the laptop hook already uses: re-wake on an
 * unchanged blocker set, but give up after `maxRepeats` and say so, because a
 * blocker set that has not moved in that many tries is not one more attempt
 * away from moving. A second, looser cap on total wakeups catches the case a
 * consecutive rule cannot see — blockers that alternate rather than repeat.
 *
 * @param signature - The current blocker signature.
 * @param priorSignatures - Signatures from this autopilot's own prior comments
 *   on the PR, oldest first.
 * @param maxRepeats - Consecutive unchanged wakeups before giving up; twice
 *   this many total wakeups also stands the autopilot down.
 * @returns Whether to wake, with the repeat count and the reason.
 */
export function shouldWake(
  signature: string,
  priorSignatures: string[],
  maxRepeats = 4,
): WakeDecision {
  let repeats = 0;
  for (let i = priorSignatures.length - 1; i >= 0; i--) {
    if (priorSignatures[i] !== signature) break;
    repeats++;
  }

  // A total cap as well as a consecutive one. Counting only an unchanged
  // signature misses the shape this loop actually produces: the fixer pushes,
  // the push stales the bot review, the bot posts a fresh review, and the
  // signature alternates between `stale-bot-review` and `changes-requested`
  // forever. Each flip resets the consecutive counter to zero, so a purely
  // consecutive rule never fires — and every wake costs a model call.
  const totalCap = maxRepeats * 2;
  if (priorSignatures.length >= totalCap) {
    return { wake: false, repeats: priorSignatures.length, reason: 'wedged' };
  }

  if (repeats === 0) return { wake: true, repeats, reason: 'new-blockers' };
  if (repeats >= maxRepeats) return { wake: false, repeats, reason: 'wedged' };
  return { wake: true, repeats, reason: 'unchanged-blockers' };
}

/**
 * Render the comment the autopilot posts to wake the fixer.
 *
 * The `@claude` mention is the trigger `phase-pr-review` already listens for,
 * which is why the autopilot posts a comment rather than dispatching a
 * workflow: that path works unchanged in every wired consumer repo. The
 * blocker list is the audit trail — it says what woke the fixer, so a person
 * reading the thread later can see the reasoning without opening the run.
 *
 * @param triage - The PR's blockers.
 * @param decision - The wake decision, whose signature is embedded for the
 *   next sweep to read back.
 * @returns The comment body.
 */
export function renderWakeComment(triage: PrTriage, decision: WakeDecision): string {
  const lines = [
    AUTOPILOT_MARKER,
    `<!-- signature:${triage.signature} -->`,
    '',
    '@claude This PR is not mergeable yet. Address every item below, push, and',
    'resolve each review thread you answer.',
    '',
    ...triage.blockers.map((b) => `- ${b.detail}`),
  ];
  if (decision.repeats > 0) {
    lines.push(
      '',
      `_Attempt ${decision.repeats + 1}: the same blockers were open on the last ` +
        'sweep. If they cannot be cleared here, say what decision is needed and ' +
        'label the PR `autopilot:off`._',
    );
  }
  return lines.join('\n');
}

/**
 * Render the comment posted once when a PR stops making progress.
 *
 * Said out loud rather than logged: a PR the autopilot has quietly given up on
 * looks identical to one it is still working, which is the situation this whole
 * mechanism exists to prevent.
 *
 * @param triage - The PR's blockers.
 * @param decision - The wake decision that concluded `wedged`.
 * @returns The comment body.
 */
export function renderWedgedComment(triage: PrTriage, decision: WakeDecision): string {
  return [
    AUTOPILOT_MARKER,
    `<!-- signature:${triage.signature} -->`,
    '<!-- wedged -->',
    '',
    `**Autopilot is standing down on this PR.** It has woken the fixer ` +
      `${decision.repeats} times without clearing these, so another attempt is ` +
      'unlikely to help:',
    '',
    ...triage.blockers.map((b) => `- ${b.detail}`),
    '',
    'This needs a decision rather than another attempt. Comment `@claude` to try',
    'again once something has changed.',
  ].join('\n');
}

/**
 * Extract the blocker signatures this autopilot recorded on a PR.
 *
 * @param commentBodies - Every comment on the PR, oldest first.
 * @returns Signatures from autopilot comments only, in order.
 */
export function priorSignatures(commentBodies: string[]): string[] {
  return commentBodies
    .filter((b) => b.includes(AUTOPILOT_MARKER))
    .map((b) => b.match(/<!-- signature:([^>]*) -->/)?.[1]?.trim() ?? '')
    .filter((s) => s !== '');
}
