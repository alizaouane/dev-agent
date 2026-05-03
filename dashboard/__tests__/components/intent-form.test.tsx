import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntentForm } from '@/components/intent-form';

describe('<IntentForm>', () => {
  it('renders repo + intent fields and a submit button', () => {
    render(<IntentForm repos={[{ owner: 'q', name: 'r1', default_branch: 'main' }]} />);
    expect(screen.getByLabelText(/repo/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/intent/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /drop/i })).toBeInTheDocument();
  });
  it('disables submit when intent is empty', async () => {
    const user = userEvent.setup();
    render(<IntentForm repos={[{ owner: 'q', name: 'r1', default_branch: 'main' }]} />);
    const btn = screen.getByRole('button', { name: /drop/i });
    expect(btn).toBeDisabled();
    await user.type(screen.getByLabelText(/intent/i), 'add a refund button');
    expect(btn).not.toBeDisabled();
  });
});
