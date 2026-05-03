import 'server-only';

import type { Octokit } from '@octokit/rest';

import { parseAllowlist } from './auth';

/**
 * Description of a repository the dashboard surfaces. `wired_up` is the user-
 * facing distinction between repos already running the dev-agent pipeline
 * (have `.dev-agent.yml` at the default branch) and repos the user could
 * onboard with one click.
 */
export type RepoInfo = {
  owner: string;
  name: string;
  default_branch: string;
  wired_up: boolean;
  html_url: string;
  description: string | null;
};

/**
 * Server-only: enumerate every repository the authenticated user can see that
 * passes the allowlist policy, then probe each one for `.dev-agent.yml` to
 * mark it `wired_up`.
 *
 * Discovery sources:
 *  1. `octokit.repos.listForAuthenticatedUser` — the user's own repos plus
 *     any repos shared with them via collaboration. Used so personal repos
 *     under the logged-in user (e.g. `alizaouane/...`) aren't invisible.
 *  2. `octokit.repos.listForOrg` for each org in `ALLOWED_GH_ORGS` — the
 *     user must already be a member (auth is gated upstream) and have at
 *     least read access to the repo.
 *
 * Allowlist policy (least-surprising):
 *  - If `ALLOWED_GH_USERNAMES` is set, only repos whose owner is in that
 *    list survive the personal-repo path.
 *  - If `ALLOWED_GH_ORGS` is set, only those orgs are crawled.
 *  - If both are unset, all accessible repos are returned (helpful for
 *    self-hosted/single-user deployments where the auth callback has
 *    already gated access).
 *
 * `wired_up` is `true` iff `.dev-agent.yml` exists at the root of the
 * default branch. We do NOT drop unwired repos — they show up in the
 * dashboard as "Available to wire up" so the user has a one-click path
 * to onboard them. (The previous behavior silently dropped them and is
 * what made the post-login dashboard look empty for users who hadn't
 * already wired up dev-agent in any repo.)
 *
 * Per-source failures (org access denied, network blip) are logged and
 * swallowed so one bad source doesn't blank out the rest.
 */
export async function listAllowedRepos(octokit: Octokit): Promise<RepoInfo[]> {
  const allowedUsernames = parseAllowlist(process.env.ALLOWED_GH_USERNAMES);
  const allowedOrgs = parseAllowlist(process.env.ALLOWED_GH_ORGS);

  const candidates: Map<string, Omit<RepoInfo, 'wired_up'>> = new Map();
  const key = (owner: string, name: string) => `${owner.toLowerCase()}/${name.toLowerCase()}`;

  // Source 1: every repo the authenticated user can list (their own + collaborator).
  try {
    type ListedRepo = {
      name: string;
      owner: { login: string; type?: string };
      default_branch?: string;
      html_url: string;
      description: string | null;
    };
    const personal: ListedRepo[] = await octokit.paginate(
      octokit.repos.listForAuthenticatedUser,
      { per_page: 100, affiliation: 'owner,collaborator,organization_member' },
    );
    for (const r of personal) {
      const isOrgRepo = (r.owner.type ?? '').toLowerCase() === 'organization';
      if (isOrgRepo) {
        // Org-typed repo policy:
        //   - If ALLOWED_GH_ORGS is set, only include if the owner is in it
        //     (the org-pass loop below would have crawled it anyway, so the
        //     candidates Map dedupes — but pre-filtering avoids surfacing
        //     org repos the user is a member of but isn't allowlisted on).
        //   - If ALLOWED_GH_ORGS is unset, INCLUDE the repo. Otherwise users
        //     who work primarily in org repos and are admitted via
        //     ALLOWED_GH_USERNAMES would see an empty dashboard.
        if (
          allowedOrgs.length > 0 &&
          !allowedOrgs.some((o) => o.toLowerCase() === r.owner.login.toLowerCase())
        ) {
          continue;
        }
      } else {
        // User-typed (personal) repo: filter by ALLOWED_GH_USERNAMES if set.
        if (
          allowedUsernames.length > 0 &&
          !allowedUsernames.some((u) => u.toLowerCase() === r.owner.login.toLowerCase())
        ) {
          continue;
        }
      }
      candidates.set(key(r.owner.login, r.name), {
        owner: r.owner.login,
        name: r.name,
        default_branch: r.default_branch ?? 'main',
        html_url: r.html_url,
        description: r.description,
      });
    }
  } catch (err) {
    console.warn('listAllowedRepos: failed to list authenticated-user repos:', err);
  }

  // Source 2: each allowed org.
  for (const org of allowedOrgs) {
    try {
      type OrgRepo = {
        name: string;
        default_branch?: string;
        html_url: string;
        description: string | null;
      };
      const repos: OrgRepo[] = await octokit.paginate(octokit.repos.listForOrg, {
        org,
        per_page: 100,
        type: 'all',
      });
      for (const r of repos) {
        candidates.set(key(org, r.name), {
          owner: org,
          name: r.name,
          default_branch: r.default_branch ?? 'main',
          html_url: r.html_url,
          description: r.description,
        });
      }
    } catch (err) {
      console.warn(`listAllowedRepos: failed to list repos for org "${org}":`, err);
    }
  }

  // Probe each candidate for `.dev-agent.yml`. Per-repo failures map to
  // wired_up: false (which is the right answer for both "no file" and
  // "transient API error" — the dashboard will simply show a wire-up button).
  const candidateList = Array.from(candidates.values());
  const probed = await Promise.all(
    candidateList.map(async (r): Promise<RepoInfo> => {
      try {
        await octokit.repos.getContent({
          owner: r.owner,
          repo: r.name,
          path: '.dev-agent.yml',
          ref: r.default_branch,
        });
        return { ...r, wired_up: true };
      } catch {
        return { ...r, wired_up: false };
      }
    }),
  );

  // Stable sort: wired-up first (most relevant for pipeline views), then
  // alphabetical within each group.
  return probed.sort((a, b) => {
    if (a.wired_up !== b.wired_up) return a.wired_up ? -1 : 1;
    const ownerCmp = a.owner.localeCompare(b.owner);
    if (ownerCmp !== 0) return ownerCmp;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Convenience: filter to repos already running dev-agent. Pipeline / cost /
 * activity views should use this — they only have meaningful data for
 * wired-up repos.
 */
export function wiredRepos(repos: RepoInfo[]): RepoInfo[] {
  return repos.filter((r) => r.wired_up);
}
