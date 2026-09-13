/**
 * The picker's story type, and the ordering a work queue wants.
 *
 * `SpecPair` is spec-and-plan shaped throughout — a plan path, a dated
 * `YYYY-MM-DD-<topic>` slug, a title derived from that slug. A story has none
 * of it: no plan, an epic, an identifier like `8.1`, and a name that lives in
 * the filename after that identifier. Forcing both into one neutral type was
 * considered and rejected; a parallel type is the smaller change and keeps the
 * spec path untouched.
 */

/** One story the picker can offer, and whether work can start on it. */
export interface StoryItem {
  /** Repo-relative path to the story. */
  storyPath: string;
  /** Stable identity for the picker. The story path, which is unique. */
  key: string;
  /** Epic number from the containing directory, or null when there isn't one. */
  epic: number | null;
  /** Identifier from the filename, like `8.1`, or null when absent. */
  storyNumber: string | null;
  /** Human title for the issue and the dropdown. */
  title: string;
  /** True when the dispatch gate would let work start. */
  approved: boolean;
  /**
   * True when verification could not be completed — a read that failed for a
   * reason other than the file being absent. Not approved, but not known to be
   * unapproved either, and saying so beats rendering an outage as a decision.
   */
  unverified?: boolean;
}

/** Filename identifier prefix, like `8.1` or `8.1.2`, at the start of a basename. */
const NUMBER_PREFIX = /^(\d+(?:\.\d+)*)-/;

/** Epic directory, like `epic-8-agent-reliability`. */
const EPIC_DIR = /^epic-(\d+)(?:-|$)/;

/**
 * Read the epic number out of a story's containing directory.
 *
 * @param path - Repo-relative story path.
 * @returns The epic number, or null when the story is not in an epic directory.
 */
export function epicOf(path: string): number | null {
  const segments = path.split('/');
  const dir = segments[segments.length - 2] ?? '';
  const match = EPIC_DIR.exec(dir);
  return match ? Number(match[1]) : null;
}

/**
 * Read the story identifier off a story's filename.
 *
 * @param path - Repo-relative story path.
 * @returns The identifier, like `8.1`, or null when the filename has none.
 */
export function storyNumberOf(path: string): string | null {
  const base = (path.split('/').pop() ?? path).replace(/\.md$/, '');
  return NUMBER_PREFIX.exec(base)?.[1] ?? null;
}

/**
 * Turn a story path into something readable in a dropdown.
 *
 * The identifier is kept and set off from the name, because two stories in one
 * epic often differ only by it. `titleFromSlug` cannot be reused: it strips a
 * `YYYY-MM-DD-` prefix a story does not have and leaves the identifier glued
 * to the first word.
 *
 * @param path - Repo-relative story path.
 * @returns `8.1 — Commitment gate hardening`, or just the name when there is
 *   no identifier.
 */
export function storyTitleOf(path: string): string {
  const base = (path.split('/').pop() ?? path).replace(/\.md$/, '');
  const number = storyNumberOf(path);
  const rest = (number === null ? base : base.slice(number.length + 1)).replace(/-/g, ' ').trim();
  const name = rest === '' ? base : rest.charAt(0).toUpperCase() + rest.slice(1);
  return number === null ? name : `${number} — ${name}`;
}

/**
 * Compare two story identifiers segment by segment, numerically.
 *
 * String comparison puts `8.10` before `8.9`, which would offer the wrong
 * story as the next one to pick up.
 *
 * @param a - Identifier, or null.
 * @param b - Identifier, or null.
 * @returns Negative, zero or positive, with null sorting last.
 */
function compareStoryNumbers(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Build the picker's story list, in the order a work queue wants.
 *
 * Ascending: 8.1 before 8.2, epic 8 before epic 9. Specs sort newest-first
 * because an old spec is history; the oldest unstarted story is the next piece
 * of work, so stories sort the other way.
 *
 * `approved` here means only that an artifact sits beside the story. The gate
 * decides for real, and `verifyStoryItems` re-derives this field by running it.
 *
 * @param stories - Repo-relative story paths. Filtered to `.md` before
 *   mapping: a caller passing the raw tree (stories and approvals mixed
 *   together, as `list-story-files.ts` returns them before the split, or as a
 *   defensive re-check afterward) must not get a startable item for an
 *   approval artifact.
 * @param approvalPaths - Repo-relative `.approval.json` paths found beside them.
 * @returns One item per story, epic and story number ascending.
 */
export function toStoryItems(stories: string[], approvalPaths: string[] = []): StoryItem[] {
  const approved = new Set(approvalPaths);
  return stories
    .filter((p) => p.endsWith('.md'))
    .map((storyPath) => ({
      storyPath,
      key: storyPath,
      epic: epicOf(storyPath),
      storyNumber: storyNumberOf(storyPath),
      title: storyTitleOf(storyPath),
      // Derived, not matched loosely, so this stays in step with the gate,
      // which reads exactly this file.
      approved: approved.has(`${storyPath.replace(/\.md$/, '')}.approval.json`),
    }))
    .sort((a, b) => {
      if (a.epic !== b.epic) {
        if (a.epic === null) return 1;
        if (b.epic === null) return -1;
        return a.epic - b.epic;
      }
      const byNumber = compareStoryNumbers(a.storyNumber, b.storyNumber);
      return byNumber !== 0 ? byNumber : a.storyPath.localeCompare(b.storyPath);
    });
}
