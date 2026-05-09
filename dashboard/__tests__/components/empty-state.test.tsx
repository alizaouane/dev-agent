import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '@/components/empty-state';

describe('<EmptyState>', () => {
  it('renders title and body', () => {
    render(<EmptyState title="No items" body="Nothing here yet" />);
    expect(screen.getByText('No items')).toBeInTheDocument();
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });
  it('renders the optional CTA link', () => {
    render(<EmptyState title="No repos" body="Wire one up" cta={{ label: 'Wire up', href: '/repos' }} />);
    expect(screen.getByRole('link', { name: /wire up/i })).toHaveAttribute('href', '/repos');
  });
});
