import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { Proposal } from './types';
import { parsePmMd, serializePmMd, type PmNotes } from '../pm-md';
import type { SnoozedProposal } from '../pm-md-schema';

/**
 * Persistent snooze backend for `/proposals`.
 *
 * **Storage:** the wired-up consumer's `.dev-agent/pm.md` frontmatter,
 * field `snoozed_proposals: [{ id, expires }]`. Persisting in the
 * consumer repo (instead of an in-memory Map, which the previous
 * implementation used) means snoozes survive Vercel cold starts. Triage
 * compounds — the user actually gets a tighter list every visit.
 *
 * **Routing:** every proposal id has the shape
 * `<source>:<owner>/<repo>:<key>`. The owner/repo segment determines
 * which consumer repo's pm.md the snooze entry lands in.
 *
 * **Self-pruning:** every write drops expired entries before adding the
 * new one. pm.md never accumulates a graveyard of past snoozes.
 *
 * **Default TTL:** 7 days, configurable per-call.
 */

const DEFAULT_SNOOZE_DAYS = 7;

/**
 * Parse `<source>:<owner>/<repo>:<key>` → `{ owner, repo }`.
 * Returns `null` if the id doesn't match the expected shape.
 */
export function parseRepoFromProposalId(
  proposalId: string,
): { owner: string; repo: string } | null {
  // Source is alphanumeric/underscore; owner+repo are GH-shaped (alphanumeric, hyphens, underscores, dots).
  // The trailing key can contain `:` (e.g. issue numbers, line refs), so we only consume up to the SECOND colon.
  const m = proposalId.match(/^([a-z_]+):([^/:]+)\/([^/:]+):/);
  if (!m) return null;
  return { owner: m[2], repo: m[3] };
}

/** ISO date string `YYYY-MM-DD` for `now + days`. */
export function expiryDate(now: Date, days: number = DEFAULT_SNOOZE_DAYS): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Drop entries whose expiry has passed (inclusive: today still counts as active). */
export function pruneExpired(
  entries: SnoozedProposal[],
  now: Date = new Date(),
): SnoozedProposal[] {
  const today = now.toISOString().slice(0, 10);
  return entries.filter((e) => e.expires >= today);
}

/**
 * Read pm.md from the consumer repo, return the snoozed-proposals list
 * (with expired entries already pruned). Returns `[]` if the repo has
 * no pm.md or the field is empty.
 */
export async function loadSnoozesForRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
  now: Date = new Date(),
): Promise<SnoozedProposal[]> {
  let raw: string;
  try {
    const resp = await octokit.repos.getContent({
      owner,
      repo,
      path: '.dev-agent/pm.md',
      ref: default_branch,
    });
    const data = resp.data as { type?: string; content?: string; encoding?: string };
    if (data.type !== 'file' || !data.content || data.encoding !== 'base64') return [];
    raw = Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    if ((err as { status?: number }).status === 404) return [];
    throw err;
  }
  let notes: PmNotes;
  try {
    notes = parsePmMd(raw);
  } catch {
    // Malformed frontmatter — treat as no snoozes rather than break /proposals.
    return [];
  }
  return pruneExpired(notes.frontmatter.snoozed_proposals ?? [], now);
}

/**
 * Build a `Map<proposalId, expires>` from a list of repos. Used by
 * `/proposals` to filter the active queue without paying N repo-lookups
 * per render. Failures per-repo degrade silently — same stance as
 * `runAllScouts`.
 */
export async function loadSnoozeMap(
  octokit: Octokit,
  repos: Array<{ owner: string; name: string; default_branch: string }>,
  now: Date = new Date(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    repos.map(async (r) => {
      try {
        const entries = await loadSnoozesForRepo(octokit, r.owner, r.name, r.default_branch, now);
        for (const e of entries) out.set(e.id, e.expires);
      } catch (err) {
        console.warn(`loadSnoozeMap: failed for ${r.owner}/${r.name}:`, err);
      }
    }),
  );
  return out;
}

/**
 * Partition proposals into active vs. snoozed using the snooze map.
 * Pure function — caller is responsible for loading the map.
 */
export function partitionBySnooze(
  proposals: Proposal[],
  snoozeMap: Map<string, string>,
): { active: Proposal[]; snoozed: Proposal[] } {
  const active: Proposal[] = [];
  const snoozed: Proposal[] = [];
  for (const p of proposals) {
    if (snoozeMap.has(p.id)) snoozed.push(p);
    else active.push(p);
  }
  return { active, snoozed };
}

/**
 * Add a snooze entry for `proposalId` to the consumer repo's pm.md.
 * Idempotent: re-snoozing the same id resets the expiry; pre-existing
 * expired entries get pruned in the same write.
 */
export async function snoozeProposalPersistent(
  octokit: Octokit,
  proposalId: string,
  days: number = DEFAULT_SNOOZE_DAYS,
  now: Date = new Date(),
): Promise<void> {
  const route = parseRepoFromProposalId(proposalId);
  if (!route) {
    throw new Error(
      `cannot route snooze: proposal id "${proposalId}" doesn't match <source>:<owner>/<repo>:<key>`,
    );
  }
  const { owner, repo } = route;

  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  const expires = expiryDate(now, days);

  await mutatePmMdSnoozes(octokit, owner, repo, default_branch, (existing) => {
    const pruned = pruneExpired(existing, now).filter((e) => e.id !== proposalId);
    pruned.push({ id: proposalId, expires });
    return pruned;
  });
}

/**
 * Remove a snooze entry (the user clicked "Un-snooze" on a snoozed
 * proposal). Also prunes other expired entries opportunistically.
 * No-op if the entry doesn't exist.
 */
export async function unsnoozeProposalPersistent(
  octokit: Octokit,
  proposalId: string,
  now: Date = new Date(),
): Promise<void> {
  const route = parseRepoFromProposalId(proposalId);
  if (!route) {
    throw new Error(
      `cannot route unsnooze: proposal id "${proposalId}" doesn't match <source>:<owner>/<repo>:<key>`,
    );
  }
  const { owner, repo } = route;

  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  await mutatePmMdSnoozes(octokit, owner, repo, default_branch, (existing) =>
    pruneExpired(existing, now).filter((e) => e.id !== proposalId),
  );
}

/**
 * Read-modify-write of the pm.md `snoozed_proposals` list. Centralized
 * so snooze + unsnooze share the optimistic-concurrency dance with the
 * file's blob SHA.
 *
 * Skips the write entirely when the list is unchanged (idempotent
 * snooze of an already-active entry, or unsnooze of a missing entry).
 */
async function mutatePmMdSnoozes(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
  transform: (existing: SnoozedProposal[]) => SnoozedProposal[],
): Promise<void> {
  // Step 1: fetch current pm.md (or initialize defaults if absent).
  let currentRaw = '';
  let currentSha: string | undefined;
  try {
    const resp = await octokit.repos.getContent({
      owner,
      repo,
      path: '.dev-agent/pm.md',
      ref: default_branch,
    });
    const data = resp.data as { type?: string; content?: string; encoding?: string; sha?: string };
    if (data.type === 'file' && data.content && data.encoding === 'base64') {
      currentRaw = Buffer.from(data.content, 'base64').toString('utf8');
      currentSha = data.sha;
    }
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
    // 404 — pm.md doesn't exist; we'll create it with just the snooze field.
  }

  let notes: PmNotes;
  if (currentRaw.trim().length > 0) {
    try {
      notes = parsePmMd(currentRaw);
    } catch {
      // Malformed frontmatter — refuse rather than overwrite user data.
      throw new Error(
        `Cannot mutate ${owner}/${repo}/.dev-agent/pm.md: frontmatter is malformed. Fix it manually first.`,
      );
    }
  } else {
    notes = { frontmatter: {}, body: '' };
  }

  const existingSnoozes = notes.frontmatter.snoozed_proposals ?? [];
  const newSnoozes = transform(existingSnoozes);

  // Skip write if unchanged (idempotent).
  if (snoozeArraysEqual(existingSnoozes, newSnoozes)) return;

  notes.frontmatter.snoozed_proposals = newSnoozes;
  // `last_updated` matters for the user reading pm.md and for the PM agent — bump it.
  notes.frontmatter.last_updated = new Date().toISOString().slice(0, 10);

  const newRaw = serializePmMd(notes);

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: '.dev-agent/pm.md',
    message: 'chore(dev-agent): update pm.md snoozed_proposals',
    content: Buffer.from(newRaw, 'utf8').toString('base64'),
    sha: currentSha,
  });
}

function snoozeArraysEqual(a: SnoozedProposal[], b: SnoozedProposal[]): boolean {
  if (a.length !== b.length) return false;
  // Compare by id+expires; order may differ — sort canonically before compare.
  const sortFn = (x: SnoozedProposal, y: SnoozedProposal): number =>
    x.id.localeCompare(y.id) || x.expires.localeCompare(y.expires);
  const sa = [...a].sort(sortFn);
  const sb = [...b].sort(sortFn);
  return sa.every((entry, i) => entry.id === sb[i].id && entry.expires === sb[i].expires);
}
