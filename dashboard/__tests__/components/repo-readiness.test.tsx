import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepoReadiness } from '@/components/repo-readiness';
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
    labels: [...REQUIRED_LABELS],
    secretNames: ['ANTHROPIC_API_KEY', 'SUPABASE_DB_URL'],
    workflows: { prReview: 'present', prAutopilot: 'present' },
    hasMigrations: 'present',
    dbSecretName: 'SUPABASE_DB_URL__ALIZAOUANE__CALIENTE_BOOKING_APP',
    pmConfigured: 'present',
    ...over,
  };
}

/** Render the checklist for a probe. */
function renderFor(over: Partial<RepoProbe> = {}) {
  const rows = assessRepo(probe(over));
  return render(
    <RepoReadiness repoName="alizaouane/x" rows={rows} verdict={summarizeReadiness(rows)} />,
  );
}

describe('<RepoReadiness>', () => {
  it('leads with the verdict, so the state is legible without reading rows', () => {
    renderFor({ secretNames: [] });
    expect(screen.getByText(/Not ready/)).toBeInTheDocument();
  });

  it('says why a gap matters, not just that it exists', () => {
    // A row reading "Database connection string ☐" gets skipped. One saying
    // the gate skips while the run goes green gets acted on.
    renderFor({ secretNames: ['ANTHROPIC_API_KEY'] });
    expect(screen.getByText(/skips and the run still goes green/)).toBeInTheDocument();
  });

  it('names the exact variable to set for this repo', () => {
    renderFor({ secretNames: ['ANTHROPIC_API_KEY'] });
    expect(
      screen.getByText(/SUPABASE_DB_URL__ALIZAOUANE__CALIENTE_BOOKING_APP/),
    ).toBeInTheDocument();
  });

  it('shows why a check could not run, rather than silently omitting it', () => {
    renderFor({ secretNames: null, secretsError: 'needs admin permission on the repo' });
    // One failed listing leaves both secret-backed rows unknown, and each says
    // so: a row that just vanished would read as one fewer thing to do.
    expect(screen.getAllByText(/Could not check: needs admin permission/)).toHaveLength(2);
  });

  it('marks optional items so they do not read as blockers', () => {
    renderFor({ pmConfigured: 'absent' });
    expect(screen.getByText('optional')).toBeInTheDocument();
  });

  it('collapses settled rows instead of showing a wall of ticks', () => {
    renderFor({ pmConfigured: 'absent' });
    // The met rows appear once, in the compact summary line, not as sections
    // with their own consequence and remedy text.
    expect(screen.queryByText(/Every phase that calls a model fails/)).not.toBeInTheDocument();
    expect(screen.getByText(/Anthropic API key/)).toBeInTheDocument();
  });

  it('reports a fully configured repo as ready', () => {
    renderFor();
    expect(screen.getByText(/Every check passed/)).toBeInTheDocument();
  });
});
