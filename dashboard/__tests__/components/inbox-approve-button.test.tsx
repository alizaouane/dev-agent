import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const approveGate = vi.fn();
vi.mock('@/lib/actions', () => ({ approveGate: (fd: FormData) => approveGate(fd) }));

import { InboxApproveButton } from '@/components/inbox-approve-button';

describe('InboxApproveButton', () => {
  it('announces a refusal to assistive technology', async () => {
    // The message appears after an async action, so without live-region
    // semantics a screen-reader user is told nothing and the button simply
    // appears not to have worked.
    approveGate.mockResolvedValueOnce({ error: 'work cannot start — spec changed' });
    render(<InboxApproveButton repo="q/r" issue={7} promote={false} label="Approve" />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('work cannot start');
    });
  });
});
