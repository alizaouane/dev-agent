import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverrideEventsPanel } from '@/components/override-events-panel';

const sample = (n = 1) =>
  Array.from({ length: n }, (_, i) => ({
    ts: `2026-05-${20 + i}T10:00:00Z`,
    pr_number: 100 + i,
    actor: `user${i}`,
    reason: i === 0 ? 'short reason' : 'x'.repeat(120),
    source_comment_url: `https://github.com/o/r/pull/${100 + i}#issuecomment-${i}`,
  }));

describe('<OverrideEventsPanel>', () => {
  it('renders the empty state when no events exist', () => {
    render(<OverrideEventsPanel events={[]} repo="owner/name" />);
    expect(screen.getByText(/no .* override activity/i)).toBeInTheDocument();
  });

  it('renders one row per event with actor, PR, and source link', () => {
    render(<OverrideEventsPanel events={sample(2)} repo="owner/name" />);
    expect(screen.getByText('@user0')).toBeInTheDocument();
    expect(screen.getByText('@user1')).toBeInTheDocument();
    expect(screen.getByText('#100')).toBeInTheDocument();
    expect(screen.getByText('#101')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /view audit comment/i });
    expect(links.length).toBe(2);
  });

  it('truncates reasons over 80 chars with an ellipsis', () => {
    render(<OverrideEventsPanel events={sample(2)} repo="owner/name" />);
    // The long reason (index 1) is `'x'.repeat(120)`. The truncate helper
    // slices to (TRUNCATE - 1) = 79 chars and appends `…`, keeping total
    // visible length at TRUNCATE = 80. Match the exact 79-x prefix.
    expect(screen.getByText(/^x{79}…$/)).toBeInTheDocument();
  });
});
