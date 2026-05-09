import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeatureDetail } from '@/components/feature-detail';
import type { VerificationOutcome } from '@/lib/verification/types';

describe('<FeatureDetail>', () => {
  it('renders title, body, and state', () => {
    render(
      <FeatureDetail
        repo="q/r"
        issue={{ number: 1, title: 'feat A', body: 'description', html_url: 'https://gh', state: 'state:spec-ready' }}
        telemetry={[]}
        prUrl={null}
      />,
    );
    expect(screen.getByText('feat A')).toBeInTheDocument();
    expect(screen.getByText(/description/)).toBeInTheDocument();
    expect(screen.getByText(/spec-ready/)).toBeInTheDocument();
  });

  it('renders the telemetry table when present', () => {
    render(
      <FeatureDetail
        repo="q/r"
        issue={{ number: 1, title: 't', body: '', html_url: '', state: 'state:done' }}
        telemetry={[
          {
            phase: 'implement',
            model: 'claude-sonnet-4-6',
            tokens_in: 1200,
            tokens_out: 800,
            cost_usd: 0.15,
            mode: 'live',
            status: 'success',
          },
        ]}
        prUrl="https://gh/pr/1"
      />,
    );
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeInTheDocument();
    expect(screen.getByText(/0\.15/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /pr/i })).toHaveAttribute('href', 'https://gh/pr/1');
  });
});

describe('<FeatureDetail> Verification card', () => {
  const baseProps = {
    repo: 'a/b',
    issue: { number: 42, title: 't', body: '', html_url: 'x', state: 'state:done' },
    telemetry: [],
    prUrl: null,
  };

  const outcome = (pillar: VerificationOutcome['pillar']): VerificationOutcome => ({
    feature_id: 42,
    repo: 'a/b',
    pillar,
    status: 'passed',
    summary: 'ok',
    details_url: 'https://example/x',
    ran_at: '2026-05-09T10:00:00Z',
  });

  it('does not render the Verification card when outcomes are empty', () => {
    render(<FeatureDetail {...baseProps} verification={{ outcomes: [], expandedPillar: null }} />);
    expect(screen.queryByText(/Verification/)).toBeNull();
  });

  it('renders one expandable card per outcome', () => {
    render(
      <FeatureDetail
        {...baseProps}
        verification={{ outcomes: [outcome('gate_b'), outcome('audit_p4')], expandedPillar: null }}
      />,
    );
    expect(screen.getByText(/Gate B/)).toBeInTheDocument();
    expect(screen.getByText(/Audit \(Pillar 4\)/)).toBeInTheDocument();
  });

  it('expands the requested pillar via expandedPillar prop', () => {
    render(
      <FeatureDetail
        {...baseProps}
        verification={{ outcomes: [outcome('smoke_p7')], expandedPillar: 'smoke_p7' }}
      />,
    );
    const details = screen.getByText(/Smoke \(Pillar 7\)/).closest('details');
    expect(details).toHaveAttribute('open');
  });
});
