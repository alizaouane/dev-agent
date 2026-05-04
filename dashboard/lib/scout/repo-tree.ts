import 'server-only';

import type { Octokit } from '@octokit/rest';

/**
 * One repo-tree walk shared across spec + plan scouts. We pull the tree
 * recursively in a single call and let downstream scouts apply their
 * own heuristic filters — much cheaper than each scout doing its own
 * directory listing, and uniform across repos that don't follow the
 * dev-agent convention.
 *
 * **Why this exists.** The original scouts hardcoded `docs/specs/` and
 * `docs/plans/`. That worked for repos wired up via the dev-agent
 * template, but for any third-party repo whose markdown lives somewhere
 * else (root-level `PLAN.md`, `notes/roadmap.md`, `documents/specs/`,
 * etc.), nothing surfaced. Switching to a tree walk + heuristic filter
 * gives "find unfinished work in any connected repo" without asking
 * the user to declare paths.
 */

export type MarkdownFile = {
  /** Repo-relative path, e.g. `docs/specs/foo.md`. */
  path: string;
  /** Filename only, e.g. `foo.md`. */
  filename: string;
  /** Filename without `.md` suffix, e.g. `foo`. */
  slug: string;
};

/**
 * Path prefixes we never recurse into. Conventional throw-away or
 * vendored content the user almost certainly doesn't track manual work
 * in. Keep this list short — false negatives (skipping a real plan)
 * are worse than the noise of an extra match.
 */
const EXCLUDED_PREFIXES = [
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  'coverage/',
  'vendor/',
  '.git/',
  '.cache/',
  'out/',
];

function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some(
    (pre) => path.startsWith(pre) || path.includes(`/${pre}`),
  );
}

/**
 * Hard cap on the number of markdown files we scan per repo per pass.
 * A docs-heavy repo (think a large open-source project) can have
 * hundreds of `.md` files, and each scout makes one extra getContent
 * call per file. 200 covers any realistic project while keeping the
 * worst-case scout cost bounded at ~200 API calls per repo.
 */
const MAX_MD_FILES = 200;

/**
 * List every `.md` file in the repo's default branch, capped at
 * `MAX_MD_FILES`. Returns `[]` on any failure — the dashboard runs
 * scouts as best-effort.
 *
 * Uses the recursive tree API (one call) rather than per-directory
 * listings. The tree API truncates at 100k entries / 7MB; that's
 * far above any realistic repo's file count.
 */
export async function listMarkdownFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
): Promise<MarkdownFile[]> {
  // Resolve the branch HEAD's tree SHA. `repos.getBranch` is one round-trip
  // and gives us the commit SHA we need for the tree call.
  let treeSha: string;
  try {
    const branchResp = await octokit.repos.getBranch({ owner, repo, branch: default_branch });
    treeSha = branchResp.data.commit.commit.tree.sha;
  } catch {
    return [];
  }

  let entries: Array<{ path?: string; type?: string }>;
  try {
    const treeResp = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: treeSha,
      recursive: 'true',
    });
    entries = treeResp.data.tree;
  } catch {
    return [];
  }

  const mdFiles: MarkdownFile[] = [];
  for (const e of entries) {
    if (e.type !== 'blob' || !e.path?.endsWith('.md')) continue;
    if (isExcluded(e.path)) continue;
    const filename = e.path.replace(/^.*\//, '');
    const slug = filename.replace(/\.md$/, '');
    mdFiles.push({ path: e.path, filename, slug });
    if (mdFiles.length >= MAX_MD_FILES) break;
  }
  return mdFiles;
}
