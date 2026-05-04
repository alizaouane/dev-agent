/**
 * Shared types for scout adapters. Each adapter produces zero or more
 * `Proposal`s; the dashboard renders them grouped by `source` so the user
 * can see at a glance whether they're behind on existing work
 * (carry-over) or choosing among new pitches.
 *
 * NOT a database — proposals are computed on demand from each repo's
 * current state. There's no persistent store; if you want to "snooze" a
 * proposal, you record that decision in `.dev-agent/pm.md` and the PM
 * agent reads it next time around.
 */

export type ProposalSource =
  /** Unchecked `- [ ]` boxes in `docs/plans/*.md`. Highest priority. */
  | 'unfinished_plan'
  /** Issue stuck in `state:blocked` for >7 days. */
  | 'stale_blocked_issue'
  /** Spec in `docs/specs/` referenced by an unresolved `TODO(<slug>)` / `FIXME(<slug>)`. */
  | 'spec_drift'
  /** Spec in `docs/specs/` with no in-flight or done issue tracking it. */
  | 'pending_spec'
  /** Issue filed by the bug-scout agent — security/logic/code-smell finding. */
  | 'bug_scout_finding'
  /** Issue without any `state:*` label — never entered the pipeline. */
  | 'untriaged_issue';

/**
 * Visual grouping for the `/proposals` page. Carry-over (commitments
 * already made) ranks above new ideas by default — a user reading the
 * list at a glance can see whether they have homework before evaluating
 * fresh pitches.
 */
export type ProposalGroup = 'carry_over' | 'new_idea';

export const SOURCE_TO_GROUP: Record<ProposalSource, ProposalGroup> = {
  unfinished_plan: 'carry_over',
  stale_blocked_issue: 'carry_over',
  spec_drift: 'carry_over',
  pending_spec: 'carry_over',
  // Bug findings ARE existing problems — carry-over by nature.
  bug_scout_finding: 'carry_over',
  untriaged_issue: 'new_idea',
};

export type Proposal = {
  /**
   * Stable identifier of the proposal (so server actions can refer back
   * to it). Format: `<source>:<owner>/<repo>:<key>` where `key` varies
   * by source — e.g. plan filename + line number, or issue number.
   */
  id: string;
  source: ProposalSource;
  group: ProposalGroup;
  /** The repo the proposal belongs to (`owner/name`). */
  repo: string;
  /** One-line title the user reads first. */
  title: string;
  /** A few-sentence description with concrete next-step context. */
  description: string;
  /** Direct GitHub URL to the underlying artifact (issue / plan file / commit). */
  url: string;
  /** Optional, free-form metadata for renderers (e.g. days_old, line_count). */
  meta?: Record<string, string | number>;
};
