import { existsSync, readFileSync } from 'node:fs';
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
    if (existing.ok && existing.approval.story_sha256 === storyHash) {
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
