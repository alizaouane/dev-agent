import { describe, it, expect } from 'vitest';
import { assessRepo, summarizeReadiness, type RepoProbe } from '@/lib/onboarding';

/** A fully configured repo, overridable field by field. */
function probe(over: Partial<RepoProbe> = {}): RepoProbe {
  return {
    wired: true,
    labels: ['state:spec-ready', 'kind:feature', 'priority:p1'],
    secretNames: ['ANTHROPIC_API_KEY', 'SUPABASE_DB_URL'],
    workflows: { prReview: true, prAutopilot: true },
    hasMigrations: true,
    dbSecretName: 'SUPABASE_DB_URL__ALIZAOUANE__CALIENTE_BOOKING_APP',
    pmConfigured: true,
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

  it('flags labels when a whole prefix is absent', () => {
    // The intake session files an issue with a state and a kind label. One
    // missing prefix fails `gh issue create` partway through the flow.
    expect(stateOf(probe({ labels: ['state:spec-ready'] }), 'labels')).toBe('missing');
    expect(stateOf(probe({ labels: ['kind:feature'] }), 'labels')).toBe('missing');
    expect(stateOf(probe({ labels: [] }), 'labels')).toBe('missing');
  });

  it('skips the database check on a repo with no migrations', () => {
    const p = probe({ hasMigrations: false, secretNames: ['ANTHROPIC_API_KEY'] });
    expect(stateOf(p, 'db_url')).toBe('not-applicable');
  });

  it('flags a missing database URL on a repo that has migrations', () => {
    const p = probe({ secretNames: ['ANTHROPIC_API_KEY'] });
    expect(stateOf(p, 'db_url')).toBe('missing');
  });

  it("names the repo's own variable in the database remedy", () => {
    // The suffix rule is what stalls this step; the row has to spell it out.
    const row = assessRepo(probe({ secretNames: [] })).find((r) => r.id === 'db_url')!;
    expect(row.remedy).toContain('SUPABASE_DB_URL__ALIZAOUANE__CALIENTE_BOOKING_APP');
  });

  it('says the drift gate passes rather than fails without a URL', () => {
    // The distinction that matters: an absent gate is visible, a gate that
    // reports and passes is counted as coverage.
    const row = assessRepo(probe()).find((r) => r.id === 'db_url')!;
    expect(row.consequence).toContain('reports and passes');
  });

  it('flags a missing fixer workflow, which makes mentioning the agent silent', () => {
    const p = probe({ workflows: { prReview: false, prAutopilot: true } });
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
      assessRepo(probe({ pmConfigured: false, workflows: { prReview: true, prAutopilot: false } })),
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
      assessRepo(probe({ hasMigrations: false, secretNames: ['ANTHROPIC_API_KEY'] })),
    );
    expect(v.ready).toBe(true);
  });
});
