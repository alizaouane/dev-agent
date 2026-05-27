import 'server-only';
import type { Octokit } from '@octokit/rest';

const SPEC_DIRS = ['docs/superpowers/specs', 'docs/specs'];
const PLAN_DIRS = ['docs/superpowers/plans', 'docs/plans'];

async function listFilesInDir(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string[]> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (!Array.isArray(data)) return [];
    return data
      .filter((d) => d.type === 'file' && d.name.endsWith('.md'))
      .map((d) => `${path}/${d.name}`);
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
 */
export async function listSpecAndPlanFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<{ specs: string[]; plans: string[] }> {
  const [specs, plans] = await Promise.all([
    Promise.all(SPEC_DIRS.map((d) => listFilesInDir(octokit, owner, repo, d, ref))).then(
      (r) => r.flat(),
    ),
    Promise.all(PLAN_DIRS.map((d) => listFilesInDir(octokit, owner, repo, d, ref))).then(
      (r) => r.flat(),
    ),
  ]);
  return { specs, plans };
}
