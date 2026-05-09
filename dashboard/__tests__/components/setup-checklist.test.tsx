import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SetupChecklist } from '@/components/setup-checklist';

describe('<SetupChecklist>', () => {
  it('renders 5 steps with checked / unchecked state', () => {
    render(
      <SetupChecklist
        repoName="a/b"
        steps={{
          wired: true,
          pm_md_present: true,
          scout_configured: false,
          first_proposal: false,
          first_feature_shipped: false,
        }}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText(/wired/i).closest('li')).toHaveTextContent('✓');
    expect(screen.getByText(/scout/i).closest('li')).toHaveTextContent('☐');
  });

  it('does not render once all steps are done', () => {
    const { container } = render(
      <SetupChecklist
        repoName="a/b"
        steps={{
          wired: true,
          pm_md_present: true,
          scout_configured: true,
          first_proposal: true,
          first_feature_shipped: true,
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
