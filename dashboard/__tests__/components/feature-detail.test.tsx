import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeatureDetail } from '@/components/feature-detail';

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
