import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerificationBadges } from '@/components/verification-badges';
import type { VerificationOutcome } from '@/lib/verification/types';

const ok = (pillar: VerificationOutcome['pillar'], status: VerificationOutcome['status'], summary = 'ok'): VerificationOutcome => ({
  feature_id: 1,
  repo: 'a/b',
  pillar,
  status,
  summary,
  details_url: 'https://example/x',
  ran_at: '2026-05-09T10:00:00Z',
});

describe('<VerificationBadges>', () => {
  it('renders nothing when given an empty list', () => {
    const { container } = render(<VerificationBadges outcomes={[]} />);
    expect(container.querySelector('a, span')).toBeNull();
  });

  it('renders one chip per outcome with the pillar label', () => {
    render(
      <VerificationBadges outcomes={[ok('gate_b', 'passed', '3 reviewers'), ok('audit_p4', 'advisory', '2 issues')]} />,
    );
    expect(screen.getByText(/Gate B/)).toBeInTheDocument();
    expect(screen.getByText(/3 reviewers/)).toBeInTheDocument();
    expect(screen.getByText(/Audit \(Pillar 4\)/)).toBeInTheDocument();
    expect(screen.getByText(/2 issues/)).toBeInTheDocument();
  });

  it('chips link to the deep-link URL with the pillar param', () => {
    render(
      <VerificationBadges
        outcomes={[ok('smoke_p7', 'failed', 'Smoke failed')]}
        featureHref="/features/142?repo=a%2Fb"
      />,
    );
    const link = screen.getByRole('link', { name: /Smoke/ });
    expect(link.getAttribute('href')).toContain('tab=verification');
    expect(link.getAttribute('href')).toContain('pillar=smoke_p7');
  });
});
