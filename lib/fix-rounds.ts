/**
 * Fix-round cap for the comment-triggered PR fixer (`phase-pr-review`).
 *
 * WHY
 *   The fixer pushes, the push makes every review bot re-review, the bot's new
 *   comments mention the fixer, and the fixer pushes again. Each lap costs a
 *   model run and a paid bot review of every changed file. `pr-autopilot` has
 *   its own stand-down, but a bot that mentions `@claude` directly bypasses the
 *   autopilot entirely, so the limit has to live in the fixer itself.
 *
 * WHAT IS COUNTED
 *   Commits on the PR whose git author name is the fixer's (`claude[bot]`,
 *   pinned as `bot_name` in the workflow). That is durable — it lives in the
 *   PR's history, survives any runner, and cannot be reset by re-running a job.
 *   A round that makes two commits counts twice, so the cap can only bite early,
 *   never late.
 */
import type { CommentRecord } from './pr-blockers';
import { AUTOPILOT_AUTHORS } from './pr-blockers';

/** Git author name the fixer commits under; the workflow pins it as `bot_name`. */
export const FIXER_COMMIT_AUTHOR = 'claude[bot]';

/** Fixer commits allowed on one PR when `pr_review.max_fix_rounds` is unset. */
export const DEFAULT_MAX_FIX_ROUNDS = 3;

/** Marker on the one-time comment announcing that the cap was reached. */
export const FIX_CAP_MARKER = '<!-- dev-agent:fix-round-cap -->';

/** The verdict of the cap gate for one fixer run. */
export interface FixRoundDecision {
  /** True when the fixer may run. */
  allow: boolean;
  /** Fixer commits already on the PR. */
  rounds: number;
  /** The configured cap. */
  maxRounds: number;
  /** Why the verdict was reached. */
  reason: 'under-cap' | 'cap-reached';
}

/**
 * Count the fixer's commits on a pull request.
 *
 * @param authorNames - Git author name of every commit on the PR.
 * @param fixerName - Author name that identifies the fixer.
 * @returns How many commits the fixer authored (exact name match only).
 */
export function countFixRounds(
  authorNames: readonly string[],
  fixerName: string = FIXER_COMMIT_AUTHOR,
): number {
  return authorNames.filter((n) => n === fixerName).length;
}

/**
 * Decide whether another fixer run may start.
 *
 * @param input.rounds - Fixer commits already on the PR.
 * @param input.maxRounds - The cap; reaching it (not exceeding it) refuses.
 * @returns Allow/refuse with the counts that produced the verdict.
 */
export function fixRoundDecision({
  rounds,
  maxRounds,
}: {
  rounds: number;
  maxRounds: number;
}): FixRoundDecision {
  const allow = rounds < maxRounds;
  return { allow, rounds, maxRounds, reason: allow ? 'under-cap' : 'cap-reached' };
}

/**
 * Read the cap from a parsed `.dev-agent.yml`.
 *
 * @param config - Parsed config, or undefined when the repo has none.
 * @returns `pr_review.max_fix_rounds`, or {@link DEFAULT_MAX_FIX_ROUNDS}.
 */
export function resolveMaxFixRounds(
  config: { pr_review?: { max_fix_rounds?: number } } | undefined,
): number {
  return config?.pr_review?.max_fix_rounds ?? DEFAULT_MAX_FIX_ROUNDS;
}

/**
 * Render the one-time notice that the fixer has stopped on this PR.
 *
 * Deliberately contains no `@claude` mention: the consumer wrapper lets the
 * workflow identity wake the fixer, so a mention here would restart the loop.
 *
 * @param input.prNumber - The pull request.
 * @param input.rounds - Fixer commits found on it.
 * @param input.maxRounds - The cap that was reached.
 * @returns The comment body.
 */
export function renderFixCapComment({
  prNumber,
  rounds,
  maxRounds,
}: {
  prNumber: number;
  rounds: number;
  maxRounds: number;
}): string {
  return [
    FIX_CAP_MARKER,
    '',
    `**Automated fix cap reached on #${prNumber}.** The fixer has pushed ${rounds} ` +
      `commit(s) here (cap: ${maxRounds}) and will not run again on this PR.`,
    '',
    'A human should take over the remaining review feedback. Further mentions of',
    'the fixer on this PR, from bots or people, are ignored, so no more model runs',
    'or re-review pushes happen here.',
    '',
    '_To allow more automated rounds across the repo, raise `pr_review.max_fix_rounds`',
    'in `.dev-agent.yml`._',
  ].join('\n');
}

/**
 * Whether this workflow identity has already announced the cap on the PR.
 *
 * Author-checked: a pasted marker from anyone else must not count.
 *
 * @param comments - Every comment on the PR.
 * @returns True when the workflow's own cap notice is present.
 */
export function alreadyAnnouncedFixCap(comments: readonly CommentRecord[]): boolean {
  return comments.some(
    (c) => AUTOPILOT_AUTHORS.includes(c.author) && c.body.includes(FIX_CAP_MARKER),
  );
}
