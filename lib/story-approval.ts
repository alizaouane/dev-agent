import { createHash } from 'node:crypto';
import type { ReviewVerdict } from './spec-approval';

/**
 * Approval of a sharded story, as stored on disk beside the story file.
 *
 * A story is the unit an implement agent actually reads, so the story text is
 * what the hash must protect. Its source spec is recorded as lineage: it must
 * carry a clean approval when the story is approved, and is not consulted
 * afterwards, so one late amendment to a program spec cannot invalidate every
 * story derived from it.
 *
 * The engine writes this file (see `lib/cli/approve-story.ts`); the dashboard
 * reads it (see `dashboard/lib/story-approval.ts`, a mirrored copy kept aligned
 * by the drift test in `tests/unit/story-approval.test.ts`).
 */

/** Domain tag mixed into the digest so a story cannot collide with a spec. */
const KIND = 'story';

/**
 * Separator between the domain tag and the document.
 *
 * Written as an escape sequence, never as a literal control character in
 * source. `lib/spec-approval.ts:103` carries the same value for the same
 * reason.
 */
const SEPARATOR = '\u0000';

/**
 * Matches the story's status header in the spellings the kit's conformance
 * check accepts (`check.sh`): bare, bold-label, and bold-with-colon forms,
 * optionally followed by a trailing annotation after whitespace.
 *
 * Exported because the module that stamps the status line must strip and write
 * the same grammar — if the two drift, stamping produces a line hashing no
 * longer removes, and every approval breaks silently at the next status change.
 *
 * The single capture group wraps the prefix on either side of the status word.
 * Later task stamps a new status by writing $1<status>, which deliberately DROPS
 * any trailing annotation — an annotation describing the previous state is
 * misleading once the state has moved on. Hashing strips the whole matched line
 * either way, so both uses stay consistent.
 */
export const STATUS_LINE_RE =
  /^([ \t>-]*\*{0,2}Status\*{0,2}:?\*{0,2}:?[ \t]*)(?:Draft|Approved|In ?Progress|Review|Done|Blocked)\*{0,2}(?:[ \t].*)?$/im;

/**
 * Strip the status header from a story before hashing it.
 *
 * dev-agent rewrites that line as the issue moves, so it is a projection of
 * the issue state rather than part of what was approved. Including it in the
 * digest would mean the first projection invalidated the approval it came
 * from, and `storyDispatchGateDecision` would then refuse every later read.
 *
 * Only the first matching line is removed; a second one is content.
 *
 * @param storyText - Full story file contents.
 * @returns The story with its status header removed.
 */
export function storyBodyForHashing(storyText: string): string {
  return storyText.replace(STATUS_LINE_RE, '').replace(/^\n/, '');
}

/**
 * Hash the approved content of a story.
 *
 * @param storyText - Full story file contents, status header included.
 * @returns Lowercase hex sha256 over the domain tag and the canonical body.
 */
export function hashStory(storyText: string): string {
  return createHash('sha256')
    .update(KIND, 'utf8')
    .update(SEPARATOR, 'utf8')
    .update(storyBodyForHashing(storyText), 'utf8')
    .digest('hex');
}

/** Schema version of the story approval artifact; bump on a breaking change. */
export const STORY_APPROVAL_SCHEMA_VERSION = 1;

/** A recorded human approval of a sharded story, as stored on disk. */
export interface StoryApproval {
  /** Schema version of this record. */
  schema_version: number;
  /** Discriminator. Always `story`; a spec record has no such field. */
  kind: 'story';
  /** Repo-relative path of the story that was approved. */
  story_path: string;
  /** sha256 over the story's canonical body at approval time. */
  story_sha256: string;
  /** Repo-relative path of the spec this story was derived from. */
  source_spec_path: string;
  /** That spec's hash at approval time. Evidence of lineage, not a constraint. */
  source_spec_sha256: string;
  /** The derivation review's verdict the approval was given against. */
  review_verdict: ReviewVerdict;
  /** How many review-and-correct rounds it took to reach that verdict. */
  review_rounds: number;
  /** Who approved, for the audit trail (git identity of the intake session). */
  approved_by: string;
  /** ISO-8601 timestamp of the approval. */
  approved_at: string;
}

/** Result of reading a story approval artifact. */
export type StoryParseResult =
  | { ok: true; approval: StoryApproval }
  | { ok: false; error: string };

const VERDICTS: readonly string[] = ['ok', 'concerns', 'blocker'];
const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Name the approval artifact that sits beside a story.
 *
 * @param storyPath - Repo-relative path to the story, ending in `.md`.
 * @returns The same path with `.md` replaced by `.approval.json`.
 * @throws If `storyPath` does not end in `.md`.
 */
export function approvalPathForStory(storyPath: string): string {
  if (!storyPath.endsWith('.md')) {
    throw new Error(`story path must end in .md, got: ${storyPath}`);
  }
  return `${storyPath.slice(0, -'.md'.length)}.approval.json`;
}

/**
 * Parse and validate a story approval artifact's JSON text.
 *
 * Fails closed on anything it cannot fully understand. A half-read approval is
 * not an approval, and the `kind` check is what stops a spec record being read
 * through this path.
 *
 * @param raw - Raw file contents.
 * @returns The parsed approval, or the reason it was rejected.
 */
export function parseStoryApproval(raw: string): StoryParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'expected a JSON object' };
  }
  const o = value as Record<string, unknown>;

  if (o.kind !== 'story') {
    return { ok: false, error: "kind must be 'story'" };
  }
  if (!Number.isInteger(o.schema_version) || (o.schema_version as number) < 1) {
    return { ok: false, error: 'schema_version must be a positive integer' };
  }
  for (const key of ['story_path', 'source_spec_path', 'approved_by', 'approved_at'] as const) {
    const v = o[key];
    if (typeof v !== 'string' || v.trim() === '') {
      return { ok: false, error: `${key} must be a non-empty string` };
    }
  }
  for (const key of ['story_sha256', 'source_spec_sha256'] as const) {
    if (typeof o[key] !== 'string' || !DIGEST_RE.test(o[key] as string)) {
      return { ok: false, error: `${key} must be a 64-character lowercase hex digest` };
    }
  }
  if (typeof o.review_verdict !== 'string' || !VERDICTS.includes(o.review_verdict)) {
    return { ok: false, error: `review_verdict must be one of ${VERDICTS.join(', ')}` };
  }
  if (!Number.isInteger(o.review_rounds) || (o.review_rounds as number) < 1) {
    return { ok: false, error: 'review_rounds must be an integer >= 1' };
  }
  return { ok: true, approval: o as unknown as StoryApproval };
}
