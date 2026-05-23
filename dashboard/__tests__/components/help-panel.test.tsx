import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HelpPanel } from '@/components/help-panel';

describe('<HelpPanel>', () => {
  it('opens when the trigger is clicked and shows the pitch', () => {
    render(<HelpPanel />);
    fireEvent.click(screen.getByRole('button', { name: /help/i }));
    expect(screen.getAllByText(/dev-agent/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/30 second/i)).toBeInTheDocument();
  });

  it('renders the Glossary section listing every term', () => {
    render(<HelpPanel />);
    fireEvent.click(screen.getByRole('button', { name: /help/i }));
    expect(screen.getByRole('heading', { name: /glossary/i })).toBeInTheDocument();
    // Spot-check a few known labels are present in the drawer
    expect(screen.getByText('Gate B')).toBeInTheDocument();
    expect(screen.getByText('EvidenceBundle')).toBeInTheDocument();
    expect(screen.getByText('Tier-2 smoke')).toBeInTheDocument();
  });
});
