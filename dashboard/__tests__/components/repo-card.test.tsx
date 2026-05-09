import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepoCard } from '@/components/repo-card';

describe('<RepoCard>', () => {
  const base = {
    repo: 'qualiency/caliente',
    in_flight_count: 2,
    proposals_count: 5,
    last_shipped_age_seconds: 7200,
    cost_7d_usd: 1.42,
  };

  it('renders the repo name as a link to /repos/[name]', () => {
    render(<RepoCard {...base} />);
    const link = screen.getByRole('link', { name: /qualiency\/caliente/ });
    expect(link.getAttribute('href')).toBe('/repos/qualiency%2Fcaliente');
  });

  it('shows in-flight, proposals, last-shipped, cost', () => {
    render(<RepoCard {...base} />);
    expect(screen.getByText(/2 in flight/i)).toBeInTheDocument();
    expect(screen.getByText(/5 proposal/i)).toBeInTheDocument();
    expect(screen.getByText(/2h ago/)).toBeInTheDocument();
    expect(screen.getByText(/\$1\.42/)).toBeInTheDocument();
  });
});
