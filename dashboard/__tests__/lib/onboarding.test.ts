import { describe, it, expect } from 'vitest';
import {
  REQUIRED_LABELS,
  assessRepo,
  summarizeReadiness,
  type RepoProbe,
} from '@/lib/onboarding';

/** A fully configured repo, overridable field by field. */
function probe(over: Partial<RepoProbe> = {}): RepoProbe {
  return {
    wired: true,
    labels: [...REQUIRED_LABELS, 'priority:p1'],
    secretNames: ['ANTHROPIC_API_KEY', 'SUPABASE_DB_URL'],
    workflows: { prReview: 'present', prAutopilot: 'present' },
    hasMigrations: 'present',
    dbSecretName: 'SUPABASE_DB_URL__ALIZAOUANE__CALIENTE_BOOKING_APP',
    pmConfigured: 'present',
    ...over,
  };
}

/** Look up one requirement's state. */
const stateOf = (p: RepoProbe, id: string) => assessRepo(p).find((r) => r.id === id)!.state;

describe('assessRepo', () => {
  it('reports a fully configured repo as met throughout', () => {
    expect(assessRepo(probe()).every((r) => r.state === 'met')).toBe(true);
  });

  it('flags a missing Anthropic key', () => {
    expect(stateOf(probe({ secretNames: ['SUPABASE_DB_URL'] }), 'anthropic_key')).toBe('missing');
  });

  it('reports unknown, not met, when secrets cannot be listed', () => {
    // Listing secrets needs admin. A write-access user gets a 403, and calling
    // that "present" would report a repo ready on a guess.
    const p = probe({ secretNames: null, secretsError: 'needs admin permission' });
    expect(stateOf(p, 'anthropic_key')).toBe('unknown');
    expect(assessRepo(p).find((r) => r.id === 'anthropic_key')!.detail).toContain('admin');
  });

  it('reports unknown, not met, when labels cannot be listed', () => {
    expect(stateOf(probe({ labels: null }), 'labels')).toBe('unknown');
  });

  it('flags labels by exact name, not by prefix', () => {
    // A repo carrying only `state:done` and `kind:bug` satisfies a prefix test
    // while `dispatchFromSpec` still fails on the labels it actually uses —
    // a check that passes without checking the thing that breaks.
    expect(stateOf(probe({ labels: ['state:done', 'kind:bug'] }), 'labels')).toBe('missing');
    expect(stateOf(probe({ labels: [] }), 'labels')).toBe('missing');
  });

  it('names exactly which labels are absent', () => {
    const row = assessRepo(probe({ labels: ['state:spec-ready'] })).find((r) => r.id === 'labels')!;
    expect(row.detail).toContain('kind:feature');
    expect(row.detail).not.toContain('state:spec-ready');
  });

  it.each(['pr_review', 'pr_autopilot', 'pm_md'])(
    'reports %s as unknown, not missing, when the file could not be read',
    (id) => {
      // Reporting a read failure as absence tells the operator to install a
      // workflow that is already there.
      const p = probe({
        workflows: { prReview: 'unknown', prAutopilot: 'unknown' },
        pmConfigured: 'unknown',
        readError: 'rate limited',
      });
      expect(stateOf(p, id)).toBe('unknown');
      expect(assessRepo(p).find((r) => r.id === id)!.detail).toBe('rate limited');
    },
  );

  it('does not call the database check not-applicable when migrations are unreadable', () => {
    // Absence of evidence is the trap: a repo WITH migrations and no URL would
    // be reported ready at exactly the moment the check could not run.
    const p = probe({ hasMigrations: 'unknown', readError: 'rate limited' });
    expect(stateOf(p, 'db_url')).toBe('unknown');
    expect(summarizeReadiness(assessRepo(p)).ready).toBe(false);
  });

  it('skips the database check on a repo with no migrations', () => {
    const p = probe({ hasMigrations: 'absent', secretNames: ['ANTHROPIC_API_KEY'] });
    expect(stateOf(p, 'db_url')).toBe('not-applicable');
  });

  it('flags a missing database URL on a repo that has migrations', () => {
    const p = probe({ secretNames: ['ANTHROPIC_API_KEY'] });
    expect(stateOf(p, 'db_url')).toBe('missing');
  });

  it('accepts the account-token route the remedy itself suggests', () => {
    // The gate runs on either pairing. Accepting only the connection string
    // meant an operator who followed the remedy's second suggestion was still
    // told the repo was not ready — a check that cannot be cleared by doing
    // what it asks.
    const p = probe({
      secretNames: ['ANTHROPIC_API_KEY', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF'],
    });
    expect(stateOf(p, 'db_url')).toBe('met');
    expect(summarizeReadiness(assessRepo(p)).ready).toBe(true);
  });

  it('rejects half of the token route, which is what whatsapp-console has', () => {
    // The token without the project ref satisfies neither pairing, so the gate
    // skips and its run still goes green. That is the live state that exposed
    // this row in the first place.
    const p = probe({ secretNames: ['ANTHROPIC_API_KEY', 'SUPABASE_ACCESS_TOKEN'] });
    expect(stateOf(p, 'db_url')).toBe('missing');
  });

  it("names the repo's own variable in the database remedy", () => {
    // The suffix rule is what stalls this step; the row has to spell it out.
    const row = assessRepo(probe({ secretNames: [] })).find((r) => r.id === 'db_url')!;
    expect(row.remedy).toContain('SUPABASE_DB_URL__ALIZAOUANE__CALIENTE_BOOKING_APP');
  });

  it('says the drift gate goes green rather than fails without a URL', () => {
    // The distinction that matters: an absent gate is visible, a gate whose
    // run goes green is counted as coverage. Verified against a live run —
    // with neither credential pairing it skips before attempting to connect.
    const row = assessRepo(probe()).find((r) => r.id === 'db_url')!;
    expect(row.consequence).toContain('skips');
    expect(row.consequence).toContain('green');
  });

  it('offers the account-token route as well as the connection string', () => {
    // The gate accepts either pairing. Naming only one sends an operator who
    // does not want to handle a database password to a dead end.
    const row = assessRepo(probe({ secretNames: [] })).find((r) => r.id === 'db_url')!;
    expect(row.remedy).toContain('SUPABASE_ACCESS_TOKEN');
    expect(row.remedy).toContain('SUPABASE_PROJECT_REF');
    expect(row.remedy).toContain('fallback');
  });

  it('flags a missing fixer workflow, which makes mentioning the agent silent', () => {
    const p = probe({ workflows: { prReview: 'absent', prAutopilot: 'present' } });
    expect(stateOf(p, 'pr_review')).toBe('missing');
  });

  it('treats the autopilot and pm context as optional', () => {
    const rows = assessRepo(probe());
    expect(rows.find((r) => r.id === 'pr_autopilot')!.required).toBe(false);
    expect(rows.find((r) => r.id === 'pm_md')!.required).toBe(false);
  });

  it('puts wiring first, since nothing else can be true without it', () => {
    expect(assessRepo(probe({ wired: false }))[0].id).toBe('wired');
  });

  it('gives every row a consequence and a remedy', () => {
    // A checklist item with no stated consequence gets ignored, and one with
    // no remedy leaves the operator to guess.
    for (const row of assessRepo(probe())) {
      expect(row.consequence.length).toBeGreaterThan(20);
      expect(row.remedy.length).toBeGreaterThan(20);
    }
  });
});

describe('summarizeReadiness', () => {
  it('calls a fully configured repo ready', () => {
    const v = summarizeReadiness(assessRepo(probe()));
    expect(v.ready).toBe(true);
    expect(v.message).toContain('Every check passed');
  });

  it('stays ready when only optional items are outstanding', () => {
    const v = summarizeReadiness(
      assessRepo(probe({ pmConfigured: 'absent', workflows: { prReview: 'present', prAutopilot: 'absent' } })),
    );
    expect(v.ready).toBe(true);
    expect(v.optional.map((r) => r.id).sort()).toEqual(['pm_md', 'pr_autopilot']);
  });

  it('blocks on a missing required item and names it', () => {
    const v = summarizeReadiness(assessRepo(probe({ secretNames: [] })));
    expect(v.ready).toBe(false);
    expect(v.message).toContain('Anthropic API key');
  });

  it('blocks on an unknown required item rather than assuming it is fine', () => {
    // Reporting ready because a check could not run is a guess presented as
    // a fact — the same shape as a gate that passes without checking.
    const v = summarizeReadiness(assessRepo(probe({ secretNames: null })));
    expect(v.ready).toBe(false);
    expect(v.message).toContain('Cannot confirm');
    expect(v.blocking).toEqual([]);
    expect(v.unknown.map((r) => r.id)).toContain('anthropic_key');
  });

  it('does not count a not-applicable item against the repo', () => {
    const v = summarizeReadiness(
      assessRepo(probe({ hasMigrations: 'absent', secretNames: ['ANTHROPIC_API_KEY'] })),
    );
    expect(v.ready).toBe(true);
  });
});
