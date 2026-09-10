import 'server-only';
import type { Octokit } from '@octokit/rest';

const SPEC_DIRS = ['docs/superpowers/specs', 'docs/specs'];
const PLAN_DIRS = ['docs/superpowers/plans', 'docs/plans'];

/** One listed file: where it is, and the blob it currently points at. */
interface ListedFile {
  /** Repo-relative path. */
  path: string;
  /** Git blob SHA, which changes whenever the content does. */
  sha: string;
}

async function listFilesInDir(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<ListedFile[]> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (!Array.isArray(data)) return [];
    return data
      .filter((d) => d.type === 'file' && (d.name.endsWith('.md') || d.name.endsWith('.approval.json')))
      .map((d) => ({ path: `${path}/${d.name}`, sha: d.sha }));
  } catch {
    return [];
  }
}

/**
 * List markdown files under the conventional spec and plan directories
 * on `ref`. Used by the per-repo "Start implementation from existing
 * spec" panel to populate its dropdowns. Probes both the new
 * `docs/superpowers/{specs,plans}` and legacy `docs/{specs,plans}`
 * locations — any failure on one dir is treated as "empty" so the
 * other dir's results still surface.
 *
 * Blob SHAs come back in the same listing at no extra cost, and let the
 * approval verifier skip re-reading files whose content has not changed.
 */
export async function listSpecAndPlanFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<{
  specs: string[];
  plans: string[];
  approvals: string[];
  blobShas: Record<string, string>;
}> {
  const [specs, plans] = await Promise.all([
    Promise.all(SPEC_DIRS.map((d) => listFilesInDir(octokit, owner, repo, d, ref))).then(
      (r) => r.flat(),
    ),
    Promise.all(PLAN_DIRS.map((d) => listFilesInDir(octokit, owner, repo, d, ref))).then(
      (r) => r.flat(),
    ),
  ]);
  // Approval artifacts live beside the specs they cover, so they come back in
  // the same listing. Split them out rather than fetching the directory twice:
  // the picker needs to know which specs can actually start, and the gate
  // reads exactly these files.
  // Only real SHAs go in. A missing one means the verifier reads the file
  // rather than keying a cache entry on a value that does not describe it.
  const blobShas: Record<string, string> = {};
  for (const f of [...specs, ...plans]) {
    if (typeof f.sha === 'string' && f.sha !== '') blobShas[f.path] = f.sha;
  }

  const specPaths = specs.map((f) => f.path);
  return {
    specs: specPaths.filter((p) => p.endsWith('.md')),
    plans: plans.map((f) => f.path).filter((p) => p.endsWith('.md')),
    approvals: specPaths.filter((p) => p.endsWith('.approval.json')),
    blobShas,
  };
}
