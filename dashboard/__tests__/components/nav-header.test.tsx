import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NavLinks } from '@/components/nav-header';

vi.mock('next/navigation', () => ({
  usePathname: () => '/repos',
}));

describe('<NavLinks>', () => {
  it('renders 3 primary links: Home, Repos, Brainstorm', () => {
    render(<NavLinks />);
    expect(screen.getByRole('link', { name: /^Home$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Repos$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Brainstorm$/ })).toBeInTheDocument();
  });

  it('renders secondary links under WORK and INSIGHTS groups', () => {
    render(<NavLinks />);
    for (const label of ['Proposals', 'Pipeline', 'Activity', 'Cost']) {
      expect(screen.getByRole('link', { name: new RegExp(`^${label}$`) })).toBeInTheDocument();
    }
    expect(screen.getByText(/^WORK$/)).toBeInTheDocument();
    expect(screen.getByText(/^INSIGHTS$/)).toBeInTheDocument();
  });

  it('marks the active link based on pathname', () => {
    render(<NavLinks />);
    const reposLink = screen.getByRole('link', { name: /^Repos$/ });
    expect(reposLink).toHaveAttribute('aria-current', 'page');
  });
});
