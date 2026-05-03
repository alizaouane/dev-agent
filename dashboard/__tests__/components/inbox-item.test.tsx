import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InboxItem } from '@/components/inbox-item';
import type { FeatureItem } from '@/lib/pipeline';

const base: FeatureItem = {
  repo: 'qualiency/caliente',
  issue_number: 142,
  title: 'add refund button',
  state: 'state:spec-ready',
  age_seconds: 3600,
  last_telemetry: null,
  blockers: [],
  html_url: 'https://github.com/qualiency/caliente/issues/142',
};

describe('<InboxItem>', () => {
  it('renders the title and state', () => {
    render(<InboxItem item={base} />);
    expect(screen.getByText('add refund button')).toBeInTheDocument();
    expect(screen.getByText(/spec-ready/)).toBeInTheDocument();
  });
  it('shows the repo name', () => {
    render(<InboxItem item={base} />);
    expect(screen.getByText(/qualiency\/caliente/)).toBeInTheDocument();
  });
  it('has an Approve button on spec-ready', () => {
    render(<InboxItem item={base} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });
  it('has a Promote button on ready-to-promote', () => {
    render(<InboxItem item={{ ...base, state: 'state:ready-to-promote' }} />);
    expect(screen.getByRole('button', { name: /promote/i })).toBeInTheDocument();
  });
  it('shows a blocker chip on state:blocked', () => {
    render(<InboxItem item={{ ...base, state: 'state:blocked', blockers: ['drift detected'] }} />);
    expect(screen.getByText(/drift detected/)).toBeInTheDocument();
  });
});
