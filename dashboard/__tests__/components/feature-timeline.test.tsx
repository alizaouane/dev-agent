import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeatureTimeline } from '@/components/feature-timeline';
import type { TimelineEvent } from '@/lib/feature-timeline';

describe('<FeatureTimeline>', () => {
  it('renders an empty state when there are no events', () => {
    render(<FeatureTimeline events={[]} />);
    expect(screen.getByText(/No timeline events yet/)).toBeInTheDocument();
  });

  it('renders intent + phase + session_log + comment events with their titles', () => {
    const events: TimelineEvent[] = [
      {
        kind: 'session_log',
        timestamp: '2026-05-04T13:00:00Z',
        title: '2026-05-04 13:00 UTC — staging-deploy — issue #42',
        description: 'Trigger: PR merged.',
        meta: { outcome: 'success' },
      },
      {
        kind: 'comment',
        timestamp: '2026-05-04T12:00:00Z',
        title: '@alizaouane commented',
        description: 'LGTM.',
        url: 'https://github.com/q/r/issues/42#c1',
      },
      {
        kind: 'phase',
        timestamp: '2026-05-04T11:00:00Z',
        title: 'Implement phase ran',
        description: 'claude-sonnet-4-6 · 18452 in / 4203 out · $0.4200 · live',
        url: 'https://github.com/q/r/issues/42#c2',
        meta: { phase: 'implement', status: 'success' },
      },
      {
        kind: 'intent',
        timestamp: '2026-05-04T10:00:00Z',
        title: 'Intent captured',
        description: 'Add a refund button.',
        url: 'https://github.com/q/r/issues/42',
      },
    ];
    render(<FeatureTimeline events={events} />);

    expect(screen.getByText('Intent captured')).toBeInTheDocument();
    expect(screen.getByText('Implement phase ran')).toBeInTheDocument();
    expect(screen.getByText(/staging-deploy — issue #42/)).toBeInTheDocument();
    expect(screen.getByText('@alizaouane commented')).toBeInTheDocument();

    // Phase event also renders the `phase` meta as a Badge.
    expect(screen.getByText('implement')).toBeInTheDocument();

    // GitHub link present for events with a url.
    const links = screen.getAllByText(/View on GitHub/);
    // intent + comment + phase have urls; session_log doesn't in this fixture
    expect(links.length).toBeGreaterThanOrEqual(3);
  });
});
