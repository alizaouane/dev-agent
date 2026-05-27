import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProposalBrainstormButton } from '@/components/proposal-brainstorm-button';

/**
 * The button hands off from the dashboard's `/proposals` queue to
 * Claude Code: clicking copies `/develop --from-issue <#> --repo X/Y`
 * to the clipboard so the user can paste it into a Claude Code
 * session. Replaces the old "Discuss with PM" in-browser chat flow.
 */
describe('<ProposalBrainstormButton>', () => {
  beforeEach(() => {
    // jsdom doesn't provide navigator.clipboard. Stub it per-test so
    // assertions on the writeText spy are isolated.
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('copies a repo-qualified /develop slash command to clipboard on click', () => {
    render(<ProposalBrainstormButton issueNumber={42} repo="qualiency/example" />);
    const btn = screen.getByRole('button', { name: /Brainstorm in Claude Code/i });
    fireEvent.click(btn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '/develop --from-issue 42 --repo qualiency/example',
    );
  });

  it('shows a confirmation after a successful copy', async () => {
    render(<ProposalBrainstormButton issueNumber={42} repo="q/r" />);
    const btn = screen.getByRole('button', { name: /Brainstorm in Claude Code/i });
    fireEvent.click(btn);
    expect(await screen.findByText(/Copied/i)).toBeInTheDocument();
  });

  it('falls back to a manual-copy display when clipboard.writeText rejects', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error('permission denied')),
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<ProposalBrainstormButton issueNumber={42} repo="q/r" />);
    const btn = screen.getByRole('button', { name: /Brainstorm in Claude Code/i });
    fireEvent.click(btn);
    // The fallback surfaces the full command inline so the user can
    // select-and-copy by hand. Without this, a permission-denied or
    // insecure-context failure would leave them with no feedback.
    expect(
      await screen.findByText(/Copy failed — select manually/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText('/develop --from-issue 42 --repo q/r'),
    ).toBeInTheDocument();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
