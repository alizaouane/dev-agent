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
});
