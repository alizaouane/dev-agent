import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { Proposal } from './types';
import { SOURCE_TO_GROUP } from './types';

/**
 * Enumerate `docs/specs/*.md` and surface each spec as a Proposal —
 * an approved commitment that hasn't been turned into shipped code
 * yet. Specs are upstream of plans and code; once approved they're
 * arguably the highest-signal "what to build next" data the engine
 * has, and they were silently invisible to /proposals before.
 *
 * **Filtering: emit a spec only if no issue currently references it.**
 * The matching heuristic is intentionally simple — search open and
 * closed issues for the spec slug in title or body. If anything
 * matches, we assume the spec is in flight (or was shipped) and
 * drop it. Otherwise it's "pending."
 *
 * False negatives (spec in flight that we *do* surface) become
 * snooze-worthy noise — recoverable. False positives (spec shipped
 * but we don't realize it) hide a commitment forever — worse. The
 * conservative choice is to err toward surfacing.
 */
export async function scoutPendingSpecs(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
  specs_dir: string,
): Promise<Proposal[]> {
  // Step 1: list spec files.
  type SpecFile = { slug: string; path: string };
  let specs: SpecFile[];
  try {
    const resp = await octokit.repos.getContent({
      owner,
      repo,
      path: specs_dir,
      ref: default_branch,
    });
    if (!Array.isArray(resp.data)) return [];
    specs = resp.data
      .filter((e) => e.type === 'file' && e.path?.endsWith('.md'))
      .map((e) => {
        const path = e.path as string;
        return { path, slug: path.replace(/^.*\//, '').replace(/\.md$/, '') };
      });
  } catch {
    return [];
  }
  if (specs.length === 0) return [];

  // Step 2: per-spec, check whether any issue references the slug. We
  // do this in parallel; per-call failures (rate limits, search index
  // lag) drop the spec to "no match found" so we err toward surfacing.
  const out = await Promise.all(
    specs.map(async (s) => {
      const referenced = await isSpecReferencedByIssue(octokit, owner, repo, s.slug);
      if (referenced) return null;

      const title = await readSpecTitle(octokit, owner, repo, default_branch, s.path).catch(() => null);

      const proposal: Proposal = {
        id: `pending_spec:${owner}/${repo}:${s.slug}`,
        source: 'pending_spec',
        group: SOURCE_TO_GROUP.pending_spec,
        repo: `${owner}/${repo}`,
        title: title ?? s.slug,
        description: `Spec at \`${s.path}\` has no tracking issue. Approved but unimplemented.`,
        url: `https://github.com/${owner}/${repo}/blob/${default_branch}/${s.path}`,
        meta: { spec_slug: s.slug, spec_path: s.path },
      };
      return proposal;
    }),
  );

  return out.filter((p): p is Proposal => p !== null);
}

/**
 * True if any issue (open or closed) in the repo mentions the spec
 * slug in its title or body. Uses GitHub's issues search via Octokit.
 *
 * Quoted phrase + repo qualifier so we don't tokenize (the slug often
 * contains hyphens which would otherwise split into separate tokens).
 */
async function isSpecReferencedByIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  slug: string,
): Promise<boolean> {
  const q = `"${slug}" repo:${owner}/${repo} type:issue`;
  try {
    const resp = await octokit.search.issuesAndPullRequests({ q, per_page: 1 });
    return (resp.data.total_count ?? 0) > 0;
  } catch {
    // Search rate-limited / 422 — assume not referenced; the user can
    // snooze if it surfaces something already in flight.
    return false;
  }
}

/** Read the first H1 from the spec file as the proposal title. */
async function readSpecTitle(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
  path: string,
): Promise<string | null> {
  const resp = await octokit.repos.getContent({ owner, repo, path, ref: default_branch });
  const data = resp.data as { content?: string; encoding?: string };
  if (!data.content || data.encoding !== 'base64') return null;
  const raw = Buffer.from(data.content, 'base64').toString('utf8');
  const m = raw.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}
