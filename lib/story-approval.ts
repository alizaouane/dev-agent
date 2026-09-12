import { createHash } from 'node:crypto';

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
