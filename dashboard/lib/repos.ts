import 'server-only';

import type { Octokit } from '@octokit/rest';

import { parseAllowlist } from './auth';

/**
 * Minimal description of a repository the dashboard is allowed to operate on.
 *
 * `default_branch` is the branch we read `.dev-agent.yml` from and the implicit
 * base for kickoff PRs unless a spec overrides it.
 */
export type RepoInfo = {
  owner: string;
  name: string;
  default_branch: string;
};

/**
 * Server-only: enumerate every repo across the orgs in `ALLOWED_GH_ORGS` that
 * has a `.dev-agent.yml` file at the root of its default branch.
 *
 * Discovery is two-phase:
 *  1. List all repos in each allowed org (`octokit.repos.listForOrg`, paginated).
 *  2. For each candidate, attempt `getContent('.dev-agent.yml')` against the
 *     default branch — a 404 means the repo is not opted in and is dropped.
 *
 * A failure listing one org (e.g. the user has no access, or the org is
 * temporarily unreachable) is logged and swallowed so other allowed orgs are
 * still surfaced — the dashboard should degrade gracefully rather than render
 * an empty page when one org misbehaves.
 *
 * Note: this issues one `getContent` request per candidate repo. For tenants
 * with many repos this is acceptable for v1 but should be revisited (e.g.
 * caching, GitHub Search API, or a manifest endpoint) if the count grows.
 */
export async function listAllowedRepos(octokit: Octokit): Promise<RepoInfo[]> {
  const orgs = parseAllowlist(process.env.ALLOWED_GH_ORGS);
  if (orgs.length === 0) return [];

  const candidates: RepoInfo[] = [];
  for (const org of orgs) {
    try {
      const repos = await octokit.paginate(octokit.repos.listForOrg, {
        org,
        per_page: 100,
        type: 'all',
      });
      for (const r of repos) {
        candidates.push({
          owner: org,
          name: r.name,
          default_branch: r.default_branch ?? 'main',
        });
      }
    } catch (err) {
      console.warn(`listAllowedRepos: failed to list repos for org "${org}":`, err);
    }
  }

  // Probe each candidate for `.dev-agent.yml` at the root of its default branch.
  // We do this in parallel — `Promise.all` is fine because per-repo failures
  // are caught locally and turned into `null`.
  const checks = await Promise.all(
    candidates.map(async (r): Promise<RepoInfo | null> => {
      try {
        await octokit.repos.getContent({
          owner: r.owner,
          repo: r.name,
          path: '.dev-agent.yml',
          ref: r.default_branch,
        });
        return r;
      } catch {
        return null;
      }
    }),
  );

  return checks.filter((r): r is RepoInfo => r !== null);
}
