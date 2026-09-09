import 'server-only';

import type { Octokit } from '@octokit/rest';

import { envVarForRepo, PROPAGATED_SECRETS } from './propagated-secrets';
import { TEMPLATE_PM_MD } from './wire-up-template';
import type { Presence, RepoProbe } from './onboarding';

/**
 * Read the current configuration of one repo, for the readiness checklist.
 *
 * Every field is looked up rather than inferred. A checklist that ticked a box
 * because an earlier step ran would report what should be true instead of what
 * is, which is the failure the checklist exists to catch.
 *
 * Only a 404 counts as absence. Every other read failure — a permission
 * response, a 5xx, a secondary rate limit — resolves to `unknown` with its
 * reason, never to absence. This page issues several reads at once, so rate
 * limiting is realistic rather than theoretical, and treating one as absence
 * tells the operator to install a workflow that is already installed, or marks
 * a repo ready because the check could not run.
 */

/** Workflow files the readiness check looks for. */
const PR_REVIEW_PATH = '.github/workflows/dev-agent-pr-review.yml';
const PR_AUTOPILOT_PATH = '.github/workflows/dev-agent-pr-autopilot.yml';

/** A file read that distinguishes absence from inability to look. */
interface Read {
  presence: Presence;
  error?: string;
}

/**
 * Whether a path exists on a ref.
 *
 * Only a 404 counts as absence. A 403, a 5xx, or a secondary rate limit means
 * the dashboard could not look — and reporting that as absence tells the
 * operator to install a workflow that is already installed, or marks a repo
 * ready because the check could not run. This page issues several content
 * reads at once, so rate limiting is a realistic trigger rather than a
 * theoretical one.
 *
 * @returns Present, absent, or unknown with the reason.
 */
async function readPath(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<Read> {
  try {
    await octokit.repos.getContent({ owner, repo, path, ref });
    return { presence: 'present' };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return { presence: 'absent' };
    return {
      presence: 'unknown',
      error: `could not read ${path} (${err instanceof Error ? err.message : String(err)})`,
    };
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
    // Paginated: a repo with more than 100 secrets would otherwise report the
    // ones on later pages as missing.
    const secrets = await octokit.paginate(octokit.actions.listRepoSecrets, {
      owner,
      repo,
      per_page: 100,
    });
    return { names: secrets.map((s) => s.name) };
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
 * A sentence that appears only in the shipped, unedited template.
 *
 * Compared against the real template rather than guessed at. An earlier
 * version looked for angle-bracketed prose, which the template does not use —
 * so every freshly wired repo passed, reproducing the false positive this
 * check was written to remove, while a genuinely edited file containing an
 * HTML tag or a bare URL failed.
 */
const PM_TEMPLATE_SENTINEL = "Replace this with one sentence about what you're focused on this quarter.";

/**
 * Decide whether `.dev-agent/pm.md` has been filled in.
 *
 * Presence is not enough: wire-up ships a placeholder, so a repo that has never
 * been edited would tick this box while the PM agent still has nothing to
 * reason with.
 *
 * @returns Present when edited, absent when missing or still the template,
 *   unknown when the file could not be read.
 */
async function readPmConfigured(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<Read> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: '.dev-agent/pm.md',
      ref,
    });
    if (Array.isArray(data) || !('content' in data)) {
      return { presence: 'absent' };
    }
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    const untouched = text.trim() === TEMPLATE_PM_MD.trim() || text.includes(PM_TEMPLATE_SENTINEL);
    return { presence: untouched ? 'absent' : 'present' };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return { presence: 'absent' };
    return {
      presence: 'unknown',
      error: `could not read .dev-agent/pm.md (${err instanceof Error ? err.message : String(err)})`,
    };
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
      workflows: { prReview: 'absent', prAutopilot: 'absent' },
      hasMigrations: 'absent',
      dbSecretName,
      pmConfigured: 'absent',
    };
  }

  const [secrets, labels, prReview, prAutopilot, migrations, pm] = await Promise.all([
    readSecretNames(octokit, owner, repo),
    readLabels(octokit, owner, repo),
    readPath(octokit, owner, repo, PR_REVIEW_PATH, defaultBranch),
    readPath(octokit, owner, repo, PR_AUTOPILOT_PATH, defaultBranch),
    readPath(octokit, owner, repo, 'supabase/migrations', defaultBranch),
    readPmConfigured(octokit, owner, repo, defaultBranch),
  ]);

  return {
    wired: true,
    labels,
    secretNames: secrets.names,
    secretsError: secrets.error,
    workflows: { prReview: prReview.presence, prAutopilot: prAutopilot.presence },
    hasMigrations: migrations.presence,
    dbSecretName,
    pmConfigured: pm.presence,
    // One reason covers every unknown file read: they share a cause (a
    // permission or rate-limit response), and the row that shows it only needs
    // to tell the operator why the answer is missing.
    readError: [prReview, prAutopilot, migrations, pm].find((r) => r.error)?.error,
  };
}
