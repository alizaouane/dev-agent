import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NavLinks } from '@/components/nav-header';

describe('<NavLinks>', () => {
  it('renders 3 primary links: Home, Repos, Brainstorm', () => {
    render(<NavLinks />);
    expect(screen.getByRole('link', { name: /^Home$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Repos$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Brainstorm$/ })).toBeInTheDocument();
  });
  it('renders secondary links (Proposals, Pipeline, Activity, Cost)', () => {
    render(<NavLinks />);
    for (const label of ['Proposals', 'Pipeline', 'Activity', 'Cost']) {
      expect(screen.getByRole('link', { name: new RegExp(`^${label}$`) })).toBeInTheDocument();
    }
  });
});
