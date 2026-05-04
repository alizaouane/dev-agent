import { z } from 'zod';

/**
 * Schema for the YAML frontmatter of `.dev-agent/pm.md` — the PM agent's
 * persistent memory of what the user cares about.
 *
 * Design priorities:
 *  - **Permissive.** Every field is optional. A user with a 3-line pm.md
 *    should be valid. We don't want the schema to be the reason a fresh
 *    consumer can't get started.
 *  - **Stable.** Field names should be stable enough that user-edited
 *    pm.md files don't break when the engine version bumps. Add fields,
 *    don't rename.
 *  - **Self-explanatory.** A user reading the raw file should understand
 *    each field without consulting docs.
 */

/**
 * A single past decision the PM has recorded — accepted, rejected, or
 * deferred. Used by the PM agent to avoid re-proposing things the user
 * just said no to, and to surface "we said we'd revisit this in Q4" when
 * the time comes.
 */
export const pmDecisionSchema = z.object({
  /** ISO-8601 date string (`YYYY-MM-DD`). Stored as string to keep YAML diffs human-readable. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  /** What was decided, in one line. */
  decision: z.string().min(1),
  /** Why — short reason. Optional but encouraged. */
  reason: z.string().optional(),
  /** If the decision was a "defer until X" rather than accept/reject, when to revisit. */
  revisit_after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
    .optional(),
});

export type PmDecision = z.infer<typeof pmDecisionSchema>;

/**
 * One competitor the PM should keep an eye on. The competitive scout
 * emits a "go review them" proposal per entry; the user clicks
 * "Discuss with PM" to dig in. Snooze handles re-surfacing noise.
 *
 * We store URL + name only at v1. Per-competitor `last_reviewed`
 * date or hash-of-content checks are reasonable future enhancements
 * if surfacing-every-load becomes annoying despite snoozing.
 */
export const pmCompetitorSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  notes: z.string().optional(),
});

export type PmCompetitor = z.infer<typeof pmCompetitorSchema>;

/**
 * One snoozed proposal — the user has decided "not now" and doesn't
 * want to see it on `/proposals` until `expires` passes.
 *
 * Persisting in `pm.md` frontmatter rather than a separate store means
 * the snooze survives Vercel cold starts (the in-memory Map that was
 * here pre-2026-05-05 evaporated on every cold start, so triage
 * compounded zero). It's also legible — the user can hand-edit pm.md
 * to bulk-unsnooze.
 *
 * `id` is the full proposal id (`<source>:<owner>/<repo>:<key>`) — the
 * server action parses owner/repo from the id to route the write to
 * the correct repo's pm.md.
 */
export const snoozedProposalSchema = z.object({
  id: z.string().min(1),
  /** ISO-8601 date (`YYYY-MM-DD`) when the snooze expires. */
  expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
});

export type SnoozedProposal = z.infer<typeof snoozedProposalSchema>;

/**
 * Frontmatter fields the PM agent reads to make ranking decisions.
 *
 * `goals` is keyed by an arbitrary slug (the user picks — "q2_2026",
 * "instructor_onboarding", "north_star", anything). Values are one-line
 * descriptions. The free-form keys are intentional: every team has a
 * different cadence, and forcing a fixed shape (e.g., "current_quarter"
 * only) loses signal.
 */
export const pmFrontmatterSchema = z.object({
  goals: z.record(z.string(), z.string()).optional(),
  avoid: z.array(z.string()).optional(),
  recent_decisions: z.array(pmDecisionSchema).optional(),
  /** Competitors the user wants the PM to watch. */
  competitors: z.array(pmCompetitorSchema).optional(),
  /** Active snoozes — proposals the user said "not now" to. Self-pruning: writers drop expired entries on every snooze/unsnooze. */
  snoozed_proposals: z.array(snoozedProposalSchema).optional(),
  /** ISO-8601 date — when the user (or PM) last touched the file. */
  last_updated: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
    .optional(),
});

export type PmFrontmatter = z.infer<typeof pmFrontmatterSchema>;

/**
 * Parsed `.dev-agent/pm.md`: structured frontmatter + free-form markdown body.
 * The body is opaque to the engine — the PM agent reads it as raw context
 * when reasoning, but the engine doesn't try to extract structure from it.
 */
export type PmNotes = {
  frontmatter: PmFrontmatter;
  body: string;
};

/** Empty defaults used when a repo doesn't have a `.dev-agent/pm.md` yet. */
export const EMPTY_PM_NOTES: PmNotes = {
  frontmatter: {},
  body: '',
};
