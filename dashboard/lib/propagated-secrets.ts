/**
 * Secrets the dashboard holds once and pushes into every wired repo.
 *
 * The alternative is what the operator was doing: opening four repos' settings
 * pages and pasting the same value into each, then discovering months later
 * that one of them was missed and the gate depending on it had been quietly
 * reporting instead of failing.
 *
 * The dashboard already did this for the Anthropic key. This generalizes it,
 * so a secret is configured in one place and lands everywhere — at wire-up for
 * new repos, and on demand for repos that were wired before the secret existed.
 *
 * **Validation is the point, not a nicety.** This codebase's recurring failure
 * is a gate that looks green while checking nothing, and a malformed value here
 * produces exactly that: `schema-drift` treats an unusable connection string as
 * "not configured" and passes. So each secret declares what a usable value
 * looks like, and a value that fails is refused loudly rather than pushed.
 *
 * **Not every secret can be shared.** One Anthropic key serves every repo; one
 * database connection string does not, because each repo has its own Supabase
 * project. A secret marked `perRepo` is read only from its repo-suffixed
 * variable, so there is no shared value that could reach the wrong database and
 * leave a repo's drift gate comparing its migrations against someone else's.
 */

/** One secret the dashboard propagates to consumer repos. */
export interface PropagatedSecret {
  /** Actions secret name, as workflows reference it. */
  name: string;
  /** Env var the dashboard reads it from. */
  envVar: string;
  /** What breaks when it is absent — shown in the UI. */
  purpose: string;
  /**
   * True when one value cannot be shared across repos.
   *
   * A shared value is only correct when every repo should genuinely get the
   * same one. A database connection string is the opposite: pushing one repo's
   * to another points that repo's drift gate at a database it has nothing to
   * do with, so the gate fails — or worse, passes — for a reason unrelated to
   * the repo it guards. For these, only the per-repo variable is read; there
   * is no shared fallback to get wrong.
   */
  perRepo?: boolean;
  /**
   * Reject a value that could not work.
   *
   * @param value - The value read from the dashboard's environment.
   * @returns Null when usable, or a sentence explaining what is wrong.
   */
  validate: (value: string) => string | null;
}

/**
 * Check that a value is a Postgres connection string with a host and a password.
 *
 * A URL missing either is the shape that silently disables `schema-drift`: the
 * workflow cannot connect, treats the secret as absent, and reports success.
 *
 * @param value - Candidate connection string.
 * @returns Null when usable, or the reason it is not.
 */
export function validatePostgresUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not a URL — expected a postgresql:// connection string';
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    return `scheme is ${url.protocol.replace(':', '')}, expected postgresql`;
  }
  if (!url.hostname) return 'no host in the connection string';
  if (!url.password) {
    return 'no password in the connection string — schema-drift would fail to connect and then report success, which is worse than not configuring it';
  }
  return null;
}

/** Every secret the dashboard knows how to propagate. */
export const PROPAGATED_SECRETS: readonly PropagatedSecret[] = [
  {
    name: 'ANTHROPIC_API_KEY',
    envVar: 'ANTHROPIC_API_KEY',
    purpose: 'Every phase workflow that calls a model. Without it, runs fail immediately.',
    // Format is Anthropic's to change; a non-empty value is all we can honestly
    // assert, and a wrong key fails loudly on first use rather than silently.
    validate: (v) => (v.trim() === '' ? 'empty' : null),
  },
  {
    name: 'SUPABASE_DB_URL',
    envVar: 'SUPABASE_DB_URL',
    purpose:
      'The schema-drift gate, which checks the deployed database still matches the migrations in the repo. Without it that gate reports and passes.',
    // Each repo has its own Supabase project. One shared value would point
    // every repo's drift gate at whichever database happened to be pasted in.
    perRepo: true,
    validate: validatePostgresUrl,
  },
];

/**
 * Turn a repo name into the suffix used for its per-repo env var.
 *
 * Env var names cannot contain a hyphen, so `caliente-booking-app` becomes
 * `CALIENTE_BOOKING_APP`, giving `SUPABASE_DB_URL__CALIENTE_BOOKING_APP`.
 *
 * @param repoName - The repository name, without the owner.
 * @returns The uppercase, underscore-separated suffix.
 */
export function envSuffixForRepo(repoName: string): string {
  return repoName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * The env var name a secret is read from for one repo.
 *
 * @param secret - The secret being resolved.
 * @param repoName - The repository name, without the owner.
 * @returns The per-repo variable name.
 */
export function envVarForRepo(secret: PropagatedSecret, repoName: string): string {
  return `${secret.envVar}__${envSuffixForRepo(repoName)}`;
}

/** A secret resolved against the dashboard's environment. */
export interface ResolvedSecret {
  name: string;
  purpose: string;
  /** Present and usable. */
  value?: string;
  /** Why it will not be pushed: absent, or the validation failure. */
  skipReason?: string;
}

/**
 * Resolve every propagated secret for one repo.
 *
 * A configured-but-invalid secret resolves to a skip WITH a reason, not to
 * silence — an operator who pasted a broken value needs to hear about it, and
 * the gate that depends on it will not tell them.
 *
 * @param env - The environment to read, normally `process.env`.
 * @param repoName - The repository name, without the owner.
 * @returns One entry per known secret, in declaration order.
 */
export function resolveSecrets(
  env: Record<string, string | undefined>,
  repoName: string,
): ResolvedSecret[] {
  return PROPAGATED_SECRETS.map((secret) => {
    const perRepoVar = envVarForRepo(secret, repoName);
    // A shared secret prefers the per-repo variable so one repo can be given a
    // different value without disturbing the rest. A per-repo secret has no
    // fallback, because the fallback is the mistake.
    const names = secret.perRepo ? [perRepoVar] : [perRepoVar, secret.envVar];
    const usedName = names.find((n) => (env[n] ?? '').trim() !== '');

    if (usedName === undefined) {
      return {
        name: secret.name,
        purpose: secret.purpose,
        skipReason: secret.perRepo
          ? `not set — this one is per-repo, so set ${perRepoVar} on the dashboard. A shared value would point this repo's gate at another repo's database.`
          : `not set on the dashboard (${secret.envVar})`,
      };
    }

    const raw = env[usedName] as string;
    const problem = secret.validate(raw);
    if (problem) {
      return {
        name: secret.name,
        purpose: secret.purpose,
        skipReason: `${usedName} is set but unusable: ${problem}`,
      };
    }
    return { name: secret.name, purpose: secret.purpose, value: raw };
  });
}

/**
 * Summarize a push attempt for the operator, without leaking any value.
 *
 * @param pushed - Secret names that landed.
 * @param skipped - Secrets that did not, each with its reason.
 * @returns One sentence per outcome, safe to render.
 */
export function summarizePush(
  pushed: string[],
  skipped: Array<{ name: string; skipReason: string }>,
): string {
  const parts: string[] = [];
  if (pushed.length > 0) parts.push(`Pushed ${pushed.join(', ')}.`);
  for (const s of skipped) parts.push(`${s.name} skipped: ${s.skipReason}.`);
  if (parts.length === 0) parts.push('No secrets are configured on the dashboard.');
  return parts.join(' ');
}
