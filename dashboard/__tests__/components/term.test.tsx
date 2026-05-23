import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Term } from '@/components/ui/term';

describe('<Term>', () => {
  it('renders the glossary label when no label prop is given', () => {
    render(<Term k="gate-b" />);
    expect(screen.getByText('Gate B')).toBeInTheDocument();
  });

  it('renders the override label when provided', () => {
    render(<Term k="gate-b" label="Gate B review" />);
    expect(screen.getByText('Gate B review')).toBeInTheDocument();
  });

  it('applies dotted-underline styling for variant="inline" (default)', () => {
    render(<Term k="gate-b" />);
    const el = screen.getByText('Gate B');
    expect(el.className).toContain('border-dotted');
    expect(el.className).toContain('cursor-help');
  });

  it('renders a (?) bubble for variant="icon"', () => {
    render(<Term k="needs-you-now" variant="icon" />);
    // The (?) bubble is a button so it can be a popover trigger
    const trigger = screen.getByRole('button', { name: /what is needs you now/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('?');
  });

  it('renders plain text and warns in dev when the key is unknown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error — intentionally unknown key for the test
    render(<Term k="not-a-real-key" label="fallback" />);
    expect(screen.getByText('fallback')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not-a-real-key'));
    warn.mockRestore();
  });

  it('opens a popover with the long body when clicked (variant=inline)', () => {
    render(<Term k="gate-b" />);
    fireEvent.click(screen.getByText('Gate B'));
    // Popover content is portaled but is in the same document under jsdom.
    expect(
      screen.getByText(/human review checkpoint/i),
    ).toBeInTheDocument();
  });
});
