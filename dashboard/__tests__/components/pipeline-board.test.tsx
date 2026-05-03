import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PipelineBoard } from '@/components/pipeline-board';
import type { FeatureItem } from '@/lib/pipeline';

const item = (state: FeatureItem['state'], n: number): FeatureItem => ({
  repo: 'q/r',
  issue_number: n,
  title: `feat ${n}`,
  state,
  age_seconds: 0,
  last_telemetry: null,
  blockers: [],
  html_url: '',
});

describe('<PipelineBoard>', () => {
  it('groups items by state into columns', () => {
    render(
      <PipelineBoard
        items={[
          item('state:spec-ready', 1),
          item('state:implementing', 2),
          item('state:spec-ready', 3),
        ]}
      />,
    );
    const specReadyHeading = screen.getByRole('heading', { name: /spec-ready/i });
    expect(specReadyHeading).toBeInTheDocument();
    expect(screen.getByText('feat 1')).toBeInTheDocument();
    expect(screen.getByText('feat 2')).toBeInTheDocument();
    expect(screen.getByText('feat 3')).toBeInTheDocument();
  });

  it('shows an empty-state when no items', () => {
    render(<PipelineBoard items={[]} />);
    expect(screen.getByText(/no in-flight features/i)).toBeInTheDocument();
  });
});
