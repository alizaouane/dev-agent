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

/** What one directory listing produced, and whether it could be read at all. */
interface DirListing {
  /** Files found. Empty when the directory is absent or unreadable. */
  files: ListedFile[];
  /** True when the read failed for a reason other than the directory's absence. */
  unreadable: boolean;
}

async function listFilesInDir(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<DirListing> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (!Array.isArray(data)) return { files: [], unreadable: false };
    return {
      files: data
        .filter(
          (d) => d.type === 'file' && (d.name.endsWith('.md') || d.name.endsWith('.approval.json')),
        )
        .map((d) => ({ path: `${path}/${d.name}`, sha: d.sha })),
      unreadable: false,
    };
  } catch (err) {
    // A directory that is not there and a directory that could not be read
    // are different facts. Approval artifacts come back through this listing,
    // so folding the second into the first makes a rate limit look like a
    // repo with nothing approved — the outage-as-decision shape the verifier
    // exists to prevent, reintroduced one layer down.
    if ((err as { status?: number }).status === 404) return { files: [], unreadable: false };
    return { files: [], unreadable: true };
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
 *
 * `unreadable` is set when a directory failed to read for any reason other
 * than not existing, so the panel can say the list may be short instead of
 * reporting an outage as a repo with nothing approved.
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
  unreadable: boolean;
}> {
  const listings = await Promise.all(
    [...SPEC_DIRS, ...PLAN_DIRS].map((d) => listFilesInDir(octokit, owner, repo, d, ref)),
  );
  const specListings = listings.slice(0, SPEC_DIRS.length);
  const planListings = listings.slice(SPEC_DIRS.length);
  const specs = specListings.flatMap((l) => l.files);
  const plans = planListings.flatMap((l) => l.files);
  const unreadable = listings.some((l) => l.unreadable);
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
    unreadable,
  };
}
