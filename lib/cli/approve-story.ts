#!/usr/bin/env tsx
/**
 * approve-story — record a human approval of a reviewed, sharded story.
 *
 * Run from the consumer repo at the end of the Claude Code intake session for
 * a single story, after the derivation review has come back clean and the
 * user has said yes in their own words. It writes the artifact the
 * dashboard's dispatch gate checks before it will start work on that story,
 * and stamps the story's `Status` header to `Approved` in the same
 * invocation — see `lib/story-approval.ts` for why the artifact is bound to a
 * hash rather than a label, and `writeApproval` above for why the story is
 * stamped before the record is written rather than after.
 *
 * This is deliberately not something a model decides to run on its own
 * behalf: the skill that calls it must have an explicit approval from the
 * user in the same turn, and `APPROVED_BY` records whose approval it was.
 *
 * Required env:
 *   STORY_PATH       Repo-relative path to the story being approved (.md).
 *   REVIEW_VERDICT   The verdict being approved. Only `ok` is accepted: an
 *                    approval exists to record that the review came back clean.
 *   REVIEW_ROUNDS    How many review-and-correct rounds it took (integer >= 1).
 *
 * Optional env:
 *   APPROVED_BY      Approver identity. Defaults to `git config user.email`.
 *   REPO_ROOT        Repo root the paths are relative to. Defaults to cwd.
 *
 * Output: a one-line success message to stdout naming where the approval
 * landed and which story was stamped.
 * Exit code: 0 on success, 2 on any input, precondition, or filesystem error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  approvalPathForSpec,
  dispatchGateDecision,
  hashSpecAndPlan,
  parseSpecApproval,
  type ReviewVerdict,
} from '../spec-approval';
import {
  approvalPathForStory,
  hashStory,
  parseStoryApproval,
  STATUS_LINE_RE,
  STORY_APPROVAL_SCHEMA_VERSION,
  STORY_STATUS_VALUES,
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
 * Canonicalise an incoming story path to a clean repo-relative POSIX path.
 *
 * `approvalPathForStory`, `approval.story_path`, and every read/write below
 * must agree on the exact string dispatch will later compare against — an
 * uncanonicalised `./docs/stories/x.md` reads the right file here but records
 * a path dispatch names differently (`docs/stories/x.md`), producing a
 * `path-mismatch` refusal that looks unrelated to its actual cause.
 *
 * @param rawPath - The `storyPath` as given to `buildStoryApproval`.
 * @returns The same path with a leading `./` stripped.
 * @throws If the path is absolute, or contains a `..` segment.
 */
function normalizeStoryPath(rawPath: string): string {
  if (isAbsolute(rawPath)) {
    throw new Error(`storyPath must be repo-relative, got an absolute path: ${rawPath}`);
  }
  let normalized = rawPath;
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (normalized.split('/').includes('..')) {
    throw new Error(`storyPath must not contain a '..' segment: ${rawPath}`);
  }
  return normalized;
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
  const storyPath = normalizeStoryPath(input.storyPath);
  const { reviewVerdict, reviewRounds, repoRoot } = input;

  const approvedBy = input.approvedBy.trim();
  if (approvedBy === '') {
    throw new Error(
      'approvedBy must not be blank. `writeApproval` stamps the story Approved before the ' +
        "record is written, so an unvalidated blank here would leave a story marked Approved " +
        'beside a record `parseStoryApproval` rejects — nothing could ever read it back.',
    );
  }

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
  const specApprovalRaw = readFileSync(specApprovalAbs, 'utf8');
  const specApprovalParsed = parseSpecApproval(specApprovalRaw);
  if (!specApprovalParsed.ok) {
    throw new Error(`the source spec's approval could not be read: ${specApprovalParsed.error}`);
  }
  const specApproval = specApprovalParsed.approval;

  // The plan named by the approval, not any plan floating around the repo:
  // the hash below must reproduce exactly what was approved. A plan named at
  // approval time that has since moved must refuse, not be silently treated
  // as "no plan".
  let planText: string | null = null;
  if (specApproval.plan_path !== null) {
    const planAbs = resolve(repoRoot, specApproval.plan_path);
    if (!existsSync(planAbs)) {
      throw new Error(
        `the source spec's approval names a plan at ${specApproval.plan_path} that no longer ` +
          'exists. Restore the plan or re-approve the spec against its current documents.',
      );
    }
    planText = readFileSync(planAbs, 'utf8');
  }

  // Reuse the real dispatch gate rather than reimplementing it: it is the
  // same check dispatch itself would apply to the spec, so a story cannot be
  // authorised by anything dispatch would refuse. This catches both a spec
  // edited after its own approval (hash mismatch) and an approval file
  // copied from a different spec (spec_path mismatch) — a verdict-only check
  // catches neither.
  const specText = readFileSync(specAbs, 'utf8');
  const decision = dispatchGateDecision({
    approvalRaw: specApprovalRaw,
    currentSpecHash: hashSpecAndPlan(specText, planText),
    specPath,
    planPath: specApproval.plan_path,
  });
  if (!decision.allow) {
    throw new Error(`the source spec's approval does not authorise it: ${decision.message}`);
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
    // that record already holds — and once `dispatchGateDecision` above has
    // allowed the story through, the two are equal by construction anyway.
    source_spec_sha256: specApproval.spec_sha256,
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
 * @param status - One of `STORY_STATUS_VALUES`.
 * @returns The story with its status header replaced.
 * @throws When the story carries no status header, rather than inventing one,
 *   or when `status` is not one of `STORY_STATUS_VALUES` — writing anything
 *   else would produce a line `STATUS_LINE_RE` cannot match back, so
 *   `storyBodyForHashing` would stop stripping it and it would silently enter
 *   the hash.
 */
export function stampStatus(storyText: string, status: string): string {
  if (!(STORY_STATUS_VALUES as readonly string[]).includes(status)) {
    throw new Error(
      `'${status}' is not a legal story status. Must be one of: ${STORY_STATUS_VALUES.join(', ')}.`,
    );
  }
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
  // `approval.story_path` is the normalised path `buildStoryApproval`
  // resolved from `input.storyPath` — reused here rather than
  // re-normalising, so the story write and the record write are guaranteed
  // to agree on the same file.
  const storyPath = approval.story_path;
  const storyAbs = resolve(input.repoRoot, storyPath);
  const stamped = stampStatus(readFileSync(storyAbs, 'utf8'), 'Approved');

  writeFileSync(storyAbs, stamped, 'utf8');
  writeFileSync(resolve(input.repoRoot, outPath), `${JSON.stringify(approval, null, 2)}\n`, 'utf8');
  return { outPath, storyPath };
}

/**
 * Resolve the approver's identity from the local git config.
 *
 * Mirrors `approve-spec.ts`'s helper of the same name exactly, so the two
 * CLIs fall back the same way when `APPROVED_BY` is not set.
 *
 * @param repoRoot - Repo to read the config from.
 * @returns The configured user email, or `unknown` when git has none.
 */
function gitIdentity(repoRoot: string): string {
  try {
    return execFileSync('git', ['config', 'user.email'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * CLI entry point. Reads the same environment-variable shape as `approve-spec`
 * (`STORY_PATH`, `REVIEW_VERDICT`, `REVIEW_ROUNDS`, `APPROVED_BY`,
 * `REPO_ROOT`), builds and writes the approval, and logs where it landed.
 *
 * `APPROVED_BY` records a human's identity — this entry point exists to be
 * run by a human approving their own review, never invoked on a user's
 * behalf.
 *
 * @throws If `STORY_PATH` is missing, `REVIEW_VERDICT` is not one of the
 *   three known verdicts, `REVIEW_ROUNDS` is not a bare positive integer, or
 *   whatever `writeApproval` throws when a precondition fails.
 */
function main(): void {
  const repoRoot = process.env.REPO_ROOT ?? process.cwd();

  const storyPath = process.env.STORY_PATH;
  if (!storyPath) throw new Error('STORY_PATH is required');

  const verdict = process.env.REVIEW_VERDICT;
  if (verdict !== 'ok' && verdict !== 'concerns' && verdict !== 'blocker') {
    throw new Error(`REVIEW_VERDICT must be ok | concerns | blocker, got: ${verdict ?? '<unset>'}`);
  }

  const roundsRaw = process.env.REVIEW_ROUNDS;
  if (!roundsRaw || !/^\d+$/.test(roundsRaw)) {
    throw new Error(`REVIEW_ROUNDS must be a positive integer, got: ${roundsRaw ?? '<unset>'}`);
  }

  const { outPath } = writeApproval({
    storyPath,
    reviewVerdict: verdict,
    reviewRounds: Number(roundsRaw),
    approvedBy: process.env.APPROVED_BY?.trim() || gitIdentity(repoRoot),
    repoRoot,
  });
  console.log(`recorded ${outPath} and stamped ${storyPath} Approved`);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `approve-story failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}
