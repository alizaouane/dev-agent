import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { renderStateBadgeContent } from '@/lib/state-label';

describe('renderStateBadgeContent', () => {
  it('strips the `state:` prefix on plain labels', () => {
    const { container } = render(<>{renderStateBadgeContent('state:scope-approval')}</>);
    expect(container.textContent).toBe('scope-approval');
  });

  it('returns plain text (no Term wrapping) for non-glossary states', () => {
    const { container } = render(<>{renderStateBadgeContent('state:implementing')}</>);
    expect(container.querySelector('button')).toBeNull();
  });

  it('wraps tier2-smoke in a Term button', () => {
    const { container } = render(<>{renderStateBadgeContent('state:tier2-smoke')}</>);
    expect(container.querySelector('button')).not.toBeNull();
    expect(container.textContent).toBe('tier2-smoke');
  });

  it('wraps gate-b in a Term button (hyphen form)', () => {
    const { container } = render(<>{renderStateBadgeContent('state:gate-b')}</>);
    expect(container.querySelector('button')).not.toBeNull();
    expect(container.textContent).toBe('gate-b');
  });

  it('wraps "Gate B" in a Term button (space + caps form)', () => {
    const { container } = render(<>{renderStateBadgeContent('Gate B')}</>);
    expect(container.querySelector('button')).not.toBeNull();
    expect(container.textContent).toBe('Gate B');
  });

  it('does not false-match gate-c, gate-a, or gatebfoo', () => {
    for (const s of ['state:gate-c', 'state:gate-a', 'state:gatebfoo']) {
      const { container } = render(<>{renderStateBadgeContent(s)}</>);
      expect(container.querySelector('button'), s).toBeNull();
    }
  });
});
