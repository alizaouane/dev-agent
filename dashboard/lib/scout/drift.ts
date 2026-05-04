import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { Proposal } from './types';
import { SOURCE_TO_GROUP } from './types';

/**
 * Find specs in `docs/specs/` that have unresolved `TODO(<slug>)` or
 * `FIXME(<slug>)` markers in the codebase. These are commitments left
 * dangling — the spec said something would be done; the code marks
 * that it isn't yet.
 *
 * Discovery:
 *   1. List `docs/specs/*.md` to get the candidate slugs (filename
 *      minus extension).
 *   2. For each slug, query GitHub's code search API for occurrences
 *      of `TODO(<slug>)` or `FIXME(<slug>)` in the repo.
 *   3. Each unique match becomes a Proposal.
 *
 * Limits:
 *   - GitHub code search has rate limits (30 req/min for authenticated
 *     users). We parallelize across slugs but stop after the first
 *     5 matches per slug — the user only needs to see "this spec has
 *     drift", not every reference.
 *   - The search index can lag the default branch by minutes; we
 *     accept that staleness rather than synchronously waiting.
 *   - One API call per spec slug. Repos with many specs will hit rate
 *     limits faster — a future optimization can batch via the
 *     GraphQL API or a pre-built index.
 */
export async function scoutSpecDrift(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
): Promise<Proposal[]> {
  const SPECS_DIR = 'docs/specs';
  const MAX_MATCHES_PER_SLUG = 5;

  // Step 1: enumerate spec slugs.
  let slugs: string[];
  try {
    const resp = await octokit.repos.getContent({
      owner,
      repo,
      path: SPECS_DIR,
      ref: default_branch,
    });
    if (!Array.isArray(resp.data)) return [];
    slugs = resp.data
      .filter((e) => e.type === 'file' && e.path?.endsWith('.md'))
      .map((e) => (e.path as string).replace(/^.*\//, '').replace(/\.md$/, ''));
  } catch {
    return [];
  }

  if (slugs.length === 0) return [];

  // Step 2: per-slug code search. Parallel, but capped per slug at
  // MAX_MATCHES_PER_SLUG so a popular slug doesn't blow up the page.
  const perSlug = await Promise.all(
    slugs.map((slug) => searchSlugMatches(octokit, owner, repo, slug, MAX_MATCHES_PER_SLUG)),
  );

  return perSlug.flat();
}

type CodeSearchMatch = {
  path: string;
  url: string;
  /** First line number where the match was found (best-effort; null if missing). */
  line: number | null;
};

async function searchSlugMatches(
  octokit: Octokit,
  owner: string,
  repo: string,
  slug: string,
  limit: number,
): Promise<Proposal[]> {
  // Quote the phrase so GitHub treats it as exact-match. `(${slug})` would
  // otherwise be tokenized as `TODO` + `slug` separately.
  const todoQ = `"TODO(${slug})" repo:${owner}/${repo}`;
  const fixmeQ = `"FIXME(${slug})" repo:${owner}/${repo}`;

  const matches: CodeSearchMatch[] = [];
  try {
    const todoResp = await octokit.search.code({ q: todoQ, per_page: limit });
    matches.push(...flattenCodeSearch(todoResp.data.items ?? []));
  } catch {
    // Search rate-limited / 422 (query rejected) — skip the slug.
  }
  try {
    const fixmeResp = await octokit.search.code({ q: fixmeQ, per_page: limit });
    matches.push(...flattenCodeSearch(fixmeResp.data.items ?? []));
  } catch {
    // same as above
  }

  // Dedupe by path — `TODO(slug)` and `FIXME(slug)` in the same file
  // count as one drift signal for that file.
  const byPath = new Map<string, CodeSearchMatch>();
  for (const m of matches) {
    if (!byPath.has(m.path)) byPath.set(m.path, m);
  }
  const unique = Array.from(byPath.values()).slice(0, limit);
  if (unique.length === 0) return [];

  return unique.map((m) => ({
    id: `spec_drift:${owner}/${repo}:${slug}@${m.path}`,
    source: 'spec_drift',
    group: SOURCE_TO_GROUP.spec_drift,
    repo: `${owner}/${repo}`,
    title: `Spec drift: ${slug}`,
    description: `Unresolved \`TODO(${slug})\` or \`FIXME(${slug})\` in \`${m.path}\`. The spec promised something the code still flags as undone.`,
    url: m.url,
    meta: { spec_slug: slug, code_file: m.path },
  }));
}

type CodeSearchItem = {
  path: string;
  html_url: string;
  text_matches?: Array<{ matches?: Array<{ indices?: number[] }> }>;
};

function flattenCodeSearch(items: CodeSearchItem[]): CodeSearchMatch[] {
  return items.map((it) => ({
    path: it.path,
    url: it.html_url,
    // GitHub's code search API doesn't return a line number directly
    // unless you opt into text-match metadata via the Accept header.
    // Skipped here — the URL anchors to the file and the user can
    // grep within it. A future refinement could fetch the file content
    // and compute the line number.
    line: null,
  }));
}
