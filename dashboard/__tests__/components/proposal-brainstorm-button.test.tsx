import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProposalBrainstormButton } from '@/components/proposal-brainstorm-button';

/**
 * The button hands off from the dashboard's `/proposals` queue to
 * Claude Code: clicking copies `/develop --from-issue <#>` to the
 * clipboard so the user can paste it into a Claude Code session.
 * Replaces the old "Discuss with PM" in-browser chat flow.
 */
describe('<ProposalBrainstormButton>', () => {
  beforeEach(() => {
    // jsdom doesn't provide navigator.clipboard. Stub it per-test so
    // assertions on the writeText spy are isolated.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('copies the /develop slash command to clipboard on click', () => {
    render(<ProposalBrainstormButton issueNumber={42} />);
    const btn = screen.getByRole('button', { name: /Brainstorm in Claude Code/i });
    fireEvent.click(btn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '/develop --from-issue 42',
    );
  });

  it('shows a confirmation after copy', async () => {
    render(<ProposalBrainstormButton issueNumber={42} />);
    const btn = screen.getByRole('button', { name: /Brainstorm in Claude Code/i });
    fireEvent.click(btn);
    expect(await screen.findByText(/Copied/i)).toBeInTheDocument();
  });
});
