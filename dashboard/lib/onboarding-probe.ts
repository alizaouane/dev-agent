import 'server-only';

import type { Octokit } from '@octokit/rest';

import { envVarForRepo, PROPAGATED_SECRETS } from './propagated-secrets';
import type { RepoProbe } from './onboarding';

/**
 * Read the current configuration of one repo, for the readiness checklist.
 *
 * Every field is looked up rather than inferred. A checklist that ticked a box
 * because an earlier step ran would report what should be true instead of what
 * is, which is the failure the checklist exists to catch.
 *
 * Reads that the caller may lack permission for resolve to `null` with a
 * reason, never to an empty list. An empty list reads as "nothing configured"
 * and would report a working repo as broken; worse, the same conflation in the
 * other direction is how a missing secret gets reported as satisfied.
 */

/** Workflow files the readiness check looks for. */
const PR_REVIEW_PATH = '.github/workflows/dev-agent-pr-review.yml';
const PR_AUTOPILOT_PATH = '.github/workflows/dev-agent-pr-autopilot.yml';

/**
 * Whether a path exists on a ref.
 *
 * @returns True when present; false on 404 or any other read failure, since a
 *   file the dashboard cannot see is one the operator should be told about.
 */
async function exists(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<boolean> {
  try {
    await octokit.repos.getContent({ owner, repo, path, ref });
    return true;
  } catch {
    return false;
  }
}

/**
 * List the repo's Actions secret NAMES.
 *
 * Values are never returned by this API and are never wanted here — the
 * checklist only asks whether a secret exists.
 *
 * @returns The names, or null with a reason when the listing is not permitted.
 */
async function readSecretNames(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<{ names: string[] | null; error?: string }> {
  try {
    const { data } = await octokit.actions.listRepoSecrets({ owner, repo, per_page: 100 });
    return { names: data.secrets.map((s) => s.name) };
  } catch (err) {
    const status = (err as { status?: number }).status;
    return {
      names: null,
      error:
        status === 403 || status === 404
          ? 'listing repository secrets needs admin permission on the repo'
          : `could not list repository secrets (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Read the repo's label names.
 *
 * @returns The names, or null when they could not be read.
 */
async function readLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string[] | null> {
  try {
    const data = await octokit.paginate(octokit.issues.listLabelsForRepo, {
      owner,
      repo,
      per_page: 100,
    });
    return data.map((l) => l.name);
  } catch {
    return null;
  }
}

/**
 * Decide whether `.dev-agent/pm.md` has been filled in.
 *
 * Presence is not enough: wire-up ships a placeholder, so a repo that has
 * never been edited would otherwise tick this box while the PM agent still has
 * nothing to reason with.
 *
 * @returns True when the file exists and differs meaningfully from the stub.
 */
async function readPmConfigured(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: '.dev-agent/pm.md',
      ref,
    });
    if (Array.isArray(data) || !('content' in data)) return false;
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    // The shipped template is placeholder prose in angle brackets. Any repo
    // that has been edited will have replaced at least one of them.
    const placeholders = (text.match(/<[^>\n]{4,}>/g) ?? []).length;
    return text.trim().length > 200 && placeholders === 0;
  } catch {
    return false;
  }
}

/**
 * Gather everything the readiness assessment needs about one repo.
 *
 * @param octokit - Authenticated client.
 * @param owner - Repo owner.
 * @param repo - Repo name.
 * @param defaultBranch - Ref to read files from.
 * @param wired - Whether `.dev-agent.yml` is present, already known to callers.
 * @returns The probe result, ready for `assessRepo`.
 */
export async function probeRepoReadiness(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
  wired: boolean,
): Promise<RepoProbe> {
  const dbSecret = PROPAGATED_SECRETS.find((s) => s.name === 'SUPABASE_DB_URL');
  const dbSecretName = dbSecret
    ? envVarForRepo(dbSecret, `${owner}/${repo}`)
    : 'SUPABASE_DB_URL';

  // An unwired repo has none of the rest by definition, and probing it would
  // spend six API calls to learn what the first one already said.
  if (!wired) {
    return {
      wired: false,
      labels: null,
      secretNames: null,
      workflows: { prReview: false, prAutopilot: false },
      hasMigrations: false,
      dbSecretName,
      pmConfigured: false,
    };
  }

  const [secrets, labels, prReview, prAutopilot, hasMigrations, pmConfigured] = await Promise.all([
    readSecretNames(octokit, owner, repo),
    readLabels(octokit, owner, repo),
    exists(octokit, owner, repo, PR_REVIEW_PATH, defaultBranch),
    exists(octokit, owner, repo, PR_AUTOPILOT_PATH, defaultBranch),
    exists(octokit, owner, repo, 'supabase/migrations', defaultBranch),
    readPmConfigured(octokit, owner, repo, defaultBranch),
  ]);

  return {
    wired: true,
    labels,
    secretNames: secrets.names,
    secretsError: secrets.error,
    workflows: { prReview, prAutopilot },
    hasMigrations,
    dbSecretName,
    pmConfigured,
  };
}
