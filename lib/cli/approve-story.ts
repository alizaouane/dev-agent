import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  approvalPathForSpec,
  parseSpecApproval,
  type ReviewVerdict,
} from '../spec-approval';
import {
  approvalPathForStory,
  hashStory,
  parseStoryApproval,
  STATUS_LINE_RE,
  STORY_APPROVAL_SCHEMA_VERSION,
  type StoryApproval,
} from '../story-approval';

/**
 * Reading the spec a story was sharded from.
 *
 * The line is written by `/shard` into the story header and is load-bearing:
 * it is how the approval act finds the design gate this story inherits from.
 */
const SOURCE_SPEC_RE = /^\s*\*{0,2}Source spec\*{0,2}:?\*{0,2}:?\s*`?([^`\s]+\.md)`?\s*$/im;

/** Everything the approval act needs, already resolved. */
export interface ApproveStoryInput {
  /** Repo-relative path to the story being approved. */
  storyPath: string;
  /** Verdict of the derivation review. */
  reviewVerdict: ReviewVerdict;
  /** How many rounds the derivation review took. */
  reviewRounds: number;
  /** Git identity of the approving human. */
  approvedBy: string;
  /** Absolute path to the repository root. */
  repoRoot: string;
}

/**
 * Pull the source spec path out of a story's header.
 *
 * @param storyText - Full story contents.
 * @returns The repo-relative spec path, or null when the story cites none.
 */
export function sourceSpecOf(storyText: string): string | null {
  return storyText.match(SOURCE_SPEC_RE)?.[1] ?? null;
}

/**
 * Build the approval record for a story, enforcing every precondition.
 *
 * The source spec must already carry a clean approval — that is the design
 * gate this story inherits. It is checked here and never again: dispatch reads
 * the story alone, so a later amendment to the spec cannot invalidate stories
 * already approved against it.
 *
 * @param input - Resolved approval inputs.
 * @returns The record and the repo-relative path to write it to.
 * @throws If the story or spec is missing, the story cites no spec, the spec's
 *   approval is absent or unclean, the derivation verdict is not `ok`, or the
 *   story is already approved at its current hash.
 */
export function buildStoryApproval(input: ApproveStoryInput): {
  approval: StoryApproval;
  outPath: string;
} {
  const { storyPath, reviewVerdict, reviewRounds, approvedBy, repoRoot } = input;

  if (reviewVerdict !== 'ok') {
    throw new Error(
      `refusing to record an approval against a '${reviewVerdict}' derivation review — ` +
        'correct the story, re-run the review until it comes back clean, and approve that ' +
        'result. Design content the source spec does not carry belongs in the spec.',
    );
  }
  if (!Number.isInteger(reviewRounds) || reviewRounds < 1) {
    throw new Error(`REVIEW_ROUNDS must be an integer >= 1, got: ${reviewRounds}`);
  }

  const storyAbs = resolve(repoRoot, storyPath);
  if (!existsSync(storyAbs)) throw new Error(`story not found: ${storyPath}`);
  const storyText = readFileSync(storyAbs, 'utf8');

  const specPath = sourceSpecOf(storyText);
  if (specPath === null) {
    throw new Error(
      `${storyPath} has no \`Source spec:\` line. A story is approved as a derivation of an ` +
        'already-approved spec; without that line there is nothing to derive from.',
    );
  }

  const specAbs = resolve(repoRoot, specPath);
  if (!existsSync(specAbs)) throw new Error(`source spec not found: ${specPath}`);

  const specApprovalPath = approvalPathForSpec(specPath);
  const specApprovalAbs = resolve(repoRoot, specApprovalPath);
  if (!existsSync(specApprovalAbs)) {
    throw new Error(
      `no approval recorded for the source spec at ${specApprovalPath}. Approve the spec ` +
        'before approving stories derived from it.',
    );
  }
  const specApproval = parseSpecApproval(readFileSync(specApprovalAbs, 'utf8'));
  if (!specApproval.ok) {
    throw new Error(`the source spec's approval could not be read: ${specApproval.error}`);
  }
  if (specApproval.approval.review_verdict !== 'ok') {
    throw new Error(
      `the source spec was approved against a '${specApproval.approval.review_verdict}' ` +
        'review, which authorises nothing. Correct the spec and re-approve it first.',
    );
  }

  const storyHash = hashStory(storyText);
  const outPath = approvalPathForStory(storyPath);
  const outAbs = resolve(repoRoot, outPath);
  if (existsSync(outAbs)) {
    const existing = parseStoryApproval(readFileSync(outAbs, 'utf8'));
    if (!existing.ok) {
      throw new Error(
        `the story's approval could not be read: ${existing.error}. Delete or repair ${outPath} ` +
          'before approving.',
      );
    }
    if (existing.approval.story_sha256 === storyHash) {
      throw new Error(
        `${storyPath} is already approved at its current text (${outPath}). Edit the story ` +
          'or delete the stale record; re-approving unchanged text records nothing new.',
      );
    }
  }

  const approval: StoryApproval = {
    schema_version: STORY_APPROVAL_SCHEMA_VERSION,
    kind: 'story',
    story_path: storyPath,
    story_sha256: storyHash,
    source_spec_path: specPath,
    // Copied from the spec's own approval rather than recomputed. It is
    // defined as "the spec's hash at approval time", which is precisely what
    // that record already holds — and recomputing it would mean reading the
    // plan, which throws when a plan named at approval time has since moved.
    source_spec_sha256: specApproval.approval.spec_sha256,
    review_verdict: reviewVerdict,
    review_rounds: reviewRounds,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
  };
  return { approval, outPath };
}

/**
 * Rewrite a story's status header in place.
 *
 * Uses `STATUS_LINE_RE` imported from `../story-approval` rather than a
 * second regex of its own: that module already exports the single grammar
 * `hashStory` strips before digesting, and two regexes encoding the same
 * grammar can drift — if stamping ever wrote a line hashing no longer
 * recognised, every approval would break silently at the next status change.
 *
 * The regex has a single capture group for the prefix on either side of the
 * status word, so the replacement (`$1${status}`) deliberately drops any
 * trailing annotation the line carried (e.g. `**Status:** Review — code
 * merged`) along with the closing bold markers, if any. An annotation
 * describing the previous state is misleading once the state has moved on.
 * `hashStory` strips the whole line either way, so the annotation's loss
 * never touches the hash.
 *
 * @param storyText - Full story contents.
 * @param status - One of the lifecycle values the conformance check accepts.
 * @returns The story with its status header replaced.
 * @throws When the story carries no status header, rather than inventing one.
 */
export function stampStatus(storyText: string, status: string): string {
  if (!STATUS_LINE_RE.test(storyText)) {
    throw new Error(
      'the story has no **Status:** line to stamp. It is a template field; add it rather ' +
        'than letting this invent one.',
    );
  }
  return storyText.replace(STATUS_LINE_RE, `$1${status}`);
}

/**
 * Stamp the story and record its approval, in that order.
 *
 * `buildStoryApproval` throws before anything is written, so a refused
 * approval leaves both files untouched. Between the two writes that follow,
 * the story is stamped FIRST and the record written SECOND — not for style,
 * but because that is the direction that recovers if the second write throws
 * for any I/O reason. Stamp-then-record leaves, at worst, a stamped story
 * with no approval record: the dispatch gate refuses that (fails closed,
 * correctly), and a retry succeeds, because `hashStory` excludes the status
 * line, so the story's hash is unchanged and no record exists yet to trip the
 * "already approved at its current text" guard in `buildStoryApproval`.
 * Record-then-stamp is the direction that cannot be recovered: a failure
 * after the record lands but before the stamp produces a recorded-but-
 * unstamped story, and re-running is then refused by that same guard, with no
 * way to complete the operation short of hand-editing one of the two files.
 *
 * @param input - Resolved approval inputs.
 * @returns Where the record was written and which story was stamped.
 * @throws Whatever `buildStoryApproval` or `stampStatus` throws.
 */
export function writeApproval(input: ApproveStoryInput): {
  outPath: string;
  storyPath: string;
} {
  const { approval, outPath } = buildStoryApproval(input);
  const storyAbs = resolve(input.repoRoot, input.storyPath);
  const stamped = stampStatus(readFileSync(storyAbs, 'utf8'), 'Approved');

  writeFileSync(storyAbs, stamped, 'utf8');
  writeFileSync(resolve(input.repoRoot, outPath), `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  return { outPath, storyPath: input.storyPath };
}

/**
 * CLI entry point. Reads the same environment-variable shape as `approve-spec`
 * (`STORY_PATH`, `REVIEW_VERDICT`, `REVIEW_ROUNDS`, `APPROVED_BY`), builds and
 * writes the approval, and logs where it landed.
 *
 * `APPROVED_BY` records a human's identity — this entry point exists to be
 * run by a human approving their own review, never invoked on a user's
 * behalf.
 *
 * @throws If a required environment variable is missing, or whatever
 *   `writeApproval` throws when a precondition fails.
 */
function main(): void {
  const storyPath = process.env.STORY_PATH;
  if (!storyPath) throw new Error('STORY_PATH is required');
  const verdict = (process.env.REVIEW_VERDICT ?? '') as ReviewVerdict;
  const rounds = Number.parseInt(process.env.REVIEW_ROUNDS ?? '', 10);
  const approvedBy = process.env.APPROVED_BY ?? '';
  if (!approvedBy) throw new Error('APPROVED_BY is required');

  const { outPath } = writeApproval({
    storyPath,
    reviewVerdict: verdict,
    reviewRounds: rounds,
    approvedBy,
    repoRoot: process.cwd(),
  });
  console.log(`recorded ${outPath} and stamped ${storyPath} Approved`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `approve-story failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}
