/**
 * Repo readiness — what a newly added project still needs before dev-agent can
 * actually run it end to end.
 *
 * The existing setup checklist tracks milestones: first proposal, first feature
 * shipped. Those are outcomes. What stalls a new repo is configuration, and
 * every item below is something that has genuinely gone wrong: a repo wired but
 * missing the labels the intake skill files issues with; a fixer workflow that
 * was never installed, so mentioning the agent on a pull request did nothing at
 * all; a drift gate with no database URL, which does not fail but reports and
 * passes.
 *
 * Two rules shape this module.
 *
 * **A requirement is probed, never assumed.** A checklist that ticks a box
 * because a previous step ran is the same category of thing as a gate that
 * passes without checking — it tells you what should be true rather than what
 * is.
 *
 * **Unknown is not satisfied.** Listing repository secrets needs admin, and a
 * user with write access gets a 403. That reports as `unknown` with the reason,
 * never as present or missing, because guessing either way is worse than saying
 * so.
 */

/** Whether one requirement is met on a repo. */
export type CheckState = 'met' | 'missing' | 'unknown' | 'not-applicable';

/**
 * What a probe found for something that either exists or does not.
 *
 * `unknown` is a first-class outcome, not an error to swallow. A read the
 * dashboard was not permitted to make, or one that hit a rate limit, is not
 * evidence of absence — and reporting it as absence sends the operator to
 * install a workflow that is already installed, or marks a repo ready because
 * a check could not run.
 */
export type Presence = 'present' | 'absent' | 'unknown';

/**
 * Map a probe's presence to a requirement's state.
 *
 * @param p - What the probe found.
 * @returns The corresponding check state.
 */
function fromPresence(p: Presence): CheckState {
  return p === 'present' ? 'met' : p === 'absent' ? 'missing' : 'unknown';
}

/** One thing a repo needs before dev-agent works on it. */
export interface Requirement {
  id: string;
  /** Short label for the checklist row. */
  label: string;
  /** What stops working while this is missing. The reason to care. */
  consequence: string;
  /** What the operator should do about it. */
  remedy: string;
  /**
   * True when the repo cannot usefully run without it. A repo missing only
   * optional items is ready; one missing a required item is not.
   */
  required: boolean;
}

/** A requirement paired with what the probe found. */
export interface RequirementStatus extends Requirement {
  state: CheckState;
  /** Why the state is `unknown`, or extra context for `missing`. */
  detail?: string;
}

/** What the probes found on one repo. */
export interface RepoProbe {
  wired: boolean;
  /** Canonical labels present on the repo, or null when they could not be read. */
  labels: string[] | null;
  /** Actions secret NAMES (never values), or null when they could not be read. */
  secretNames: string[] | null;
  /** Why secrets could not be read, when `secretNames` is null. */
  secretsError?: string;
  /** Workflow files under `.github/workflows/`. */
  workflows: { prReview: Presence; prAutopilot: Presence };
  /** Whether the repo has `supabase/migrations`, so the drift gate applies. */
  hasMigrations: Presence;
  /** The per-repo env var this repo's database URL is read from. */
  dbSecretName: string;
  /** Whether `.dev-agent/pm.md` has been edited past the shipped template. */
  pmConfigured: Presence;
  /** Why a file read came back `unknown`, when one did. */
  readError?: string;
}

/**
 * The exact labels the dashboard and the intake skill create issues with.
 *
 * Checked by name rather than by prefix. A repo carrying only `state:done` and
 * `kind:bug` satisfies a prefix test while `dispatchFromSpec` still fails on
 * the labels it actually uses — a check that passes without checking the
 * thing that breaks.
 */
export const REQUIRED_LABELS: readonly string[] = [
  'state:spec-ready',
  'state:implementing',
  'state:pr-review',
  'kind:feature',
];

/**
 * Build the readiness list for one repo.
 *
 * Ordered the way it should be worked: nothing else matters until the repo is
 * wired, and the items that silently degrade a gate come before the ones that
 * merely fail loudly — a loud failure tells you about itself.
 *
 * @param probe - What was found on the repo.
 * @returns One status per requirement, in the order to address them.
 */
export function assessRepo(probe: RepoProbe): RequirementStatus[] {
  const hasSecret = (name: string): CheckState =>
    probe.secretNames === null ? 'unknown' : probe.secretNames.includes(name) ? 'met' : 'missing';

  // The gate accepts either pairing, so readiness has to as well. Checking
  // only the connection string meant an operator who followed the remedy's
  // own second suggestion was still told the repo was not ready — a check
  // that cannot be cleared by doing what it asks.
  const driftCredentialState: CheckState = (() => {
    if (probe.secretNames === null) return 'unknown';
    if (probe.secretNames.includes('SUPABASE_DB_URL')) return 'met';
    const hasTokenPair =
      probe.secretNames.includes('SUPABASE_ACCESS_TOKEN') &&
      probe.secretNames.includes('SUPABASE_PROJECT_REF');
    return hasTokenPair ? 'met' : 'missing';
  })();

  const missingLabels =
    probe.labels === null ? null : REQUIRED_LABELS.filter((l) => !probe.labels!.includes(l));
  const labelState: CheckState =
    missingLabels === null ? 'unknown' : missingLabels.length === 0 ? 'met' : 'missing';

  const rows: RequirementStatus[] = [
    {
      id: 'wired',
      label: 'Repo wired up',
      consequence: 'Nothing else runs. The workflows and config live in the repo itself.',
      remedy: 'Use "Wire up" on the repos page. It commits the config and workflows and pushes the secrets.',
      required: true,
      state: probe.wired ? 'met' : 'missing',
    },
    {
      id: 'anthropic_key',
      label: 'Anthropic API key',
      consequence: 'Every phase that calls a model fails on its first run.',
      remedy: 'Press "Push dashboard secrets" on this page.',
      required: true,
      state: hasSecret('ANTHROPIC_API_KEY'),
      detail: probe.secretsError,
    },
    {
      id: 'labels',
      label: 'Issue labels',
      consequence:
        'Filing a feature fails partway through: the intake session creates the issue with state and kind labels that do not exist yet.',
      remedy: 'Run /dev-agent-init in the repo, or create the state:* and kind:* labels by hand.',
      required: true,
      state: labelState,
      detail:
        missingLabels && missingLabels.length > 0
          ? `Missing: ${missingLabels.join(', ')}.`
          : undefined,
    },
    {
      id: 'pr_review',
      label: 'PR fixer workflow',
      consequence:
        'Mentioning the agent on a pull request does nothing. Review findings and red CI wait for you to fix them.',
      remedy: 'Install "PR fixer" from the workflows section below.',
      required: true,
      state: fromPresence(probe.workflows.prReview),
      detail: probe.workflows.prReview === 'unknown' ? probe.readError : undefined,
    },
    {
      id: 'pr_autopilot',
      label: 'PR autopilot',
      consequence:
        'Nothing notices a failing check or an unread review. You find out by looking.',
      remedy: 'Install "PR autopilot" from the workflows section below.',
      required: false,
      state: fromPresence(probe.workflows.prAutopilot),
      detail: probe.workflows.prAutopilot === 'unknown' ? probe.readError : undefined,
    },
    {
      id: 'db_url',
      label: 'Database connection string',
      // This one is first among equals: without it the drift gate does not
      // fail, it reports and passes. A missing gate that looks green is worse
      // than an absent one, because it is counted as coverage.
      // Precise about the mechanism, because the earlier wording said the
      // gate "cannot connect" and it does not get that far: with neither
      // credential pairing present it skips, prints a notice, and the run goes
      // green. Verified against a live run in whatsapp-console.
      consequence:
        'The schema-drift gate skips and the run still goes green, so the repo looks covered while the database is never compared against its migrations.',
      remedy:
        `Set ${probe.dbSecretName} on the dashboard, then press "Push dashboard secrets". ` +
        'Or, if you would rather not handle a database password, set the repo secrets ' +
        'SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF instead — the gate accepts either ' +
        'pairing, but that token reaches every project on the account, so it is the fallback.',
      required: true,
      // An unreadable migrations directory is not proof the repo has none.
      // Calling it not-applicable there would report a repo ready at exactly
      // the moment the check could not run.
      state:
        probe.hasMigrations === 'present'
          ? driftCredentialState
          : probe.hasMigrations === 'absent'
            ? 'not-applicable'
            : 'unknown',
      detail:
        probe.hasMigrations === 'present'
          ? probe.secretsError
          : probe.hasMigrations === 'absent'
            ? 'No supabase/migrations in this repo.'
            : probe.readError,
    },
    {
      id: 'pm_md',
      label: 'PM context written',
      consequence:
        'The PM agent has no goals or avoid-list to judge a pitch against, so its scoping is generic.',
      remedy: 'Edit .dev-agent/pm.md in the repo — goals, what to avoid, recent decisions.',
      required: false,
      state: fromPresence(probe.pmConfigured),
      detail: probe.pmConfigured === 'unknown' ? probe.readError : undefined,
    },
  ];

  return rows;
}

/** The one-line verdict for a repo. */
export interface ReadinessVerdict {
  ready: boolean;
  /** Required items not yet met. */
  blocking: RequirementStatus[];
  /** Items that could not be determined. */
  unknown: RequirementStatus[];
  /** Optional items not yet met. */
  optional: RequirementStatus[];
  message: string;
}

/**
 * Reduce a readiness list to a verdict.
 *
 * An `unknown` required item blocks. The dashboard cannot see whether the
 * secret is there, and reporting the repo ready on that basis would be a
 * guess presented as a fact.
 *
 * @param rows - Output of `assessRepo`.
 * @returns Whether the repo is ready, and what is outstanding.
 */
export function summarizeReadiness(rows: RequirementStatus[]): ReadinessVerdict {
  const blocking = rows.filter((r) => r.required && r.state === 'missing');
  const unknown = rows.filter((r) => r.required && r.state === 'unknown');
  const optional = rows.filter((r) => !r.required && r.state === 'missing');
  const ready = blocking.length === 0 && unknown.length === 0;

  let message: string;
  if (ready && optional.length === 0) {
    message = 'Ready. Every check passed.';
  } else if (ready) {
    message = `Ready to run. ${optional.length} optional item(s) would make it work better.`;
  } else if (blocking.length > 0) {
    message = `Not ready: ${blocking.map((r) => r.label).join(', ')}.`;
  } else {
    message = `Cannot confirm: ${unknown.map((r) => r.label).join(', ')} could not be checked.`;
  }

  return { ready, blocking, unknown, optional, message };
}
