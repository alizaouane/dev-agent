import 'server-only';

import type { Octokit } from '@octokit/rest';

import { readPmNotesFromRepo } from '../pm-prompt';
import type { Proposal } from './types';
import { SOURCE_TO_GROUP } from './types';

/**
 * Surface each competitor declared in `.dev-agent/pm.md`'s frontmatter
 * as a "go review what they're up to" proposal. Snooze-friendly: a
 * 7-day snooze hides each competitor for the week, so the user gets
 * a recurring nudge without page-load nagging.
 *
 * Why minimal-by-design (v1):
 * - No URL fetching here. Saves cost + latency on every /proposals load.
 * - No LLM analysis at scout time. The user can run `/develop` in Claude
 *   Code (or click "Brainstorm in Claude Code" on the proposal) to do
 *   context-aware analysis on demand; the scout's job is just to remind
 *   the user a competitor exists and is worth checking.
 * - User adds competitors by editing pm.md frontmatter — same shape
 *   as everything else PM-related, so it's discoverable.
 *
 * Future enhancement candidates (deferred until v1 friction shows up):
 *   - Fetch the competitor URL, hash it, only emit when the hash
 *     changes since last seen (would require persistent storage).
 *   - Per-load LLM analysis with aggressive cache to extract
 *     "they shipped X" signals.
 *   - Daily cron that pre-computes the analysis offline.
 */
export async function scoutCompetitorWatch(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<Proposal[]> {
  const notes = await readPmNotesFromRepo(octokit, owner, repo);
  const competitors = notes.frontmatter.competitors ?? [];
  if (competitors.length === 0) return [];

  return competitors.map((c) => ({
    id: `competitor_watch:${owner}/${repo}:${c.url}`,
    source: 'competitor_watch',
    group: SOURCE_TO_GROUP.competitor_watch,
    repo: `${owner}/${repo}`,
    title: `Review competitor: ${c.name}`,
    description:
      c.notes && c.notes.length > 0
        ? `${c.notes} — ${c.url}`
        : `Check what they shipped recently. Click "Brainstorm in Claude Code" to extract feature ideas relevant to your goals. (${c.url})`,
    url: c.url,
    meta: { competitor_name: c.name, competitor_url: c.url },
  }));
}
