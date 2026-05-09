import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeatureCard } from '@/components/feature-card';

describe('<FeatureCard>', () => {
  const base = {
    repo: 'a/b',
    issue_number: 42,
    title: 'add refund button',
    state: 'state:implementing' as const,
    age_seconds: 3600,
    outcomes: [],
  };

  it('renders the title and repo', () => {
    render(<FeatureCard item={base} />);
    expect(screen.getByText('add refund button')).toBeInTheDocument();
    expect(screen.getByText(/a\/b/)).toBeInTheDocument();
  });

  it('shows the state pill', () => {
    render(<FeatureCard item={base} />);
    expect(screen.getByText(/implementing/)).toBeInTheDocument();
  });

  it('shows verification badges when outcomes present', () => {
    render(
      <FeatureCard
        item={{
          ...base,
          outcomes: [
            {
              feature_id: 42,
              repo: 'a/b',
              pillar: 'gate_b',
              status: 'passed',
              summary: '3 reviewers',
              details_url: 'x',
              ran_at: '2026-05-09T10:00:00Z',
            },
          ],
        }}
      />,
    );
    expect(screen.getByText(/Gate B/)).toBeInTheDocument();
  });

  it('links the title to /features/[issue]', () => {
    render(<FeatureCard item={base} />);
    const link = screen.getByRole('link', { name: /add refund button/ });
    expect(link.getAttribute('href')).toContain('/features/42');
    expect(link.getAttribute('href')).toContain('repo=a%2Fb');
  });
});
