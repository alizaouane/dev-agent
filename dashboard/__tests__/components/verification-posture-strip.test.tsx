import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerificationPostureStrip } from '@/components/verification-posture-strip';

describe('<VerificationPostureStrip>', () => {
  it('renders all five metrics for a populated rollup', () => {
    render(
      <VerificationPostureStrip
        rollup={{
          window_days: 7,
          generated_at: '2026-05-09T10:00:00Z',
          shipped_count: 12,
          audit_caught_count: 3,
          risk_flagged_count: 2,
          smoke_failed_count: 1,
          total_cost_usd: 4.2,
        }}
      />,
    );
    expect(screen.getByText(/12 features shipped/)).toBeInTheDocument();
    expect(screen.getByText(/3 audits caught/)).toBeInTheDocument();
    expect(screen.getByText(/2 risk-flagged/)).toBeInTheDocument();
    expect(screen.getByText(/1 smoke check failed/)).toBeInTheDocument();
    expect(screen.getByText(/\$4\.20 spent/)).toBeInTheDocument();
  });

  it('shows the empty-state copy when nothing has been verified yet', () => {
    render(
      <VerificationPostureStrip
        rollup={{
          window_days: 7,
          generated_at: '2026-05-09T10:00:00Z',
          shipped_count: 0,
          audit_caught_count: 0,
          risk_flagged_count: 0,
          smoke_failed_count: 0,
          total_cost_usd: 0,
        }}
      />,
    );
    expect(screen.getByText(/No verification activity yet/i)).toBeInTheDocument();
  });
});
