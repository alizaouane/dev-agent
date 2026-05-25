import { describe, it, expect, beforeEach, vi, afterEach, type MockInstance } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// Replace Radix Select (which doesn't render its portal reliably in jsdom)
// with a native <select>. Behavior under test is the React state plumbing,
// not Radix's listbox UI — and the production component still uses Radix.
vi.mock('@/components/ui/select', () => {
  type SelectProps = {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  };
  return {
    Select: ({ value, onValueChange, children }: SelectProps) => (
      <select
        data-testid="repo-select-mock"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
      >
        {children}
      </select>
    ),
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
  };
});
import { PmChat } from '@/components/pm-chat';
import { DRAFT_STORAGE_KEY } from '@/lib/pm-chat-draft';
import type { RepoInfo } from '@/lib/repos';

/**
 * Regression test for the misrouted-PR bug: a stale localStorage draft from
 * a previous brainstorm session was being silently restored into form state
 * on a bare `/intent` visit, including its `repo` field. Users would type a
 * new feature intending repo A, but the dropdown had silently switched to
 * repo B and the resulting issue + workflow + PR landed on the wrong repo.
 *
 * The fix turns the draft restore into an explicit Resume/Discard banner so
 * the previous-session repo can never be inherited without the user
 * clicking through.
 */

const repos: RepoInfo[] = [
  {
    owner: 'q',
    name: 'social-media',
    default_branch: 'main',
    wired_up: true,
    html_url: 'https://github.com/q/social-media',
    description: null,
  },
  {
    owner: 'q',
    name: 'whatsapp-console',
    default_branch: 'main',
    wired_up: true,
    html_url: 'https://github.com/q/whatsapp-console',
    description: null,
  },
];

function plantStaleDraft({
  repo = 'q/whatsapp-console',
  title = 'Stale feature title',
  input = 'partial old input',
  messages = [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'old user pitch' }] },
    {
      id: 'm2',
      role: 'assistant',
      parts: [{ type: 'text', text: 'old PM reply about whatsapp' }],
    },
  ],
} = {}) {
  window.localStorage.setItem(
    DRAFT_STORAGE_KEY,
    JSON.stringify({ repo, title, input, messages }),
  );
}

describe('<PmChat> — stale-draft handling', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('does NOT silently render stale draft messages into the chat on mount', async () => {
    plantStaleDraft();

    render(<PmChat repos={repos} />);

    // Empty-state placeholder copy should still be visible — the chat panel
    // must NOT have been pre-populated with messages from a previous
    // session.
    expect(
      await screen.findByText(/Pitch an idea below/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/old PM reply about whatsapp/)).not.toBeInTheDocument();
    expect(screen.queryByText(/old user pitch/)).not.toBeInTheDocument();
  });

  it('shows a "Previous draft found" banner naming the stale repo + offering Resume / Discard', async () => {
    plantStaleDraft();

    render(<PmChat repos={repos} />);

    const banner = await screen.findByRole('region', { name: /previous draft/i });
    expect(banner).toHaveTextContent(/previous draft found/i);
    expect(banner).toHaveTextContent('q/whatsapp-console');
    expect(banner).toHaveTextContent(/stale feature title/i);
    expect(banner).toHaveTextContent(/2 messages/i);

    expect(screen.getByRole('button', { name: /^resume$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^discard$/i })).toBeInTheDocument();
  });

  it('does NOT show a banner when the stored draft is empty', async () => {
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ repo: '', title: '', input: '', messages: [] }),
    );

    render(<PmChat repos={repos} />);

    // Wait one microtask for the post-mount effect to run, then assert
    // no banner appeared.
    await waitFor(() => {
      expect(screen.getByText(/Pitch an idea below/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('region', { name: /previous draft/i })).not.toBeInTheDocument();
  });

  it('Discard clears localStorage and dismisses the banner', async () => {
    plantStaleDraft();
    const user = userEvent.setup();

    render(<PmChat repos={repos} />);

    await user.click(await screen.findByRole('button', { name: /^discard$/i }));

    expect(
      screen.queryByRole('region', { name: /previous draft/i }),
    ).not.toBeInTheDocument();
    // Discard wipes the persisted entry — the next /intent visit starts fresh.
    expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('Resume applies the draft (messages, title) and dismisses the banner', async () => {
    plantStaleDraft();
    const user = userEvent.setup();

    render(<PmChat repos={repos} />);

    await user.click(await screen.findByRole('button', { name: /^resume$/i }));

    // resumePendingDraft awaits safeValidateUIMessages, so wait for the
    // post-validation state updates to settle before asserting.
    await waitFor(() => {
      expect(screen.getByText(/old PM reply about whatsapp/)).toBeInTheDocument();
    });
    // Banner gone.
    expect(
      screen.queryByRole('region', { name: /previous draft/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/old user pitch/)).toBeInTheDocument();
    // Title input populated.
    expect(screen.getByLabelText(/feature title/i)).toHaveValue('Stale feature title');
  });

  it('Resume on a draft with corrupt messages clears the draft and dismisses the banner without crashing', async () => {
    // Persisted UIMessages can outlive an `ai` SDK upgrade — a part shape
    // that was valid at write-time may fail validation at read-time.
    // safeValidateUIMessages catches this; the component should drop the
    // bad entry rather than push invalid state into useChat.
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        repo: 'q/whatsapp-console',
        title: 'Stale feature title',
        input: '',
        // Missing required fields → safeValidateUIMessages returns
        // { success: false }.
        messages: [{ id: 'm1', role: 'user' /* no parts */ }],
      }),
    );
    const user = userEvent.setup();

    render(<PmChat repos={repos} />);

    await user.click(await screen.findByRole('button', { name: /^resume$/i }));

    await waitFor(() => {
      expect(
        screen.queryByRole('region', { name: /previous draft/i }),
      ).not.toBeInTheDocument();
    });
    // Corrupt entry was wiped — won't keep popping the banner.
    expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    // No messages were pushed into the chat.
    expect(screen.getByText(/Pitch an idea below/i)).toBeInTheDocument();
  });

  it('skips draft detection when initialInput or initialRepo is provided (proposals prefill flow)', async () => {
    plantStaleDraft();

    render(<PmChat repos={repos} initialInput="seeded from a proposal" />);

    // Wait for the mount effect to run (sets hydratedFromDraft) before
    // asserting the banner's absence — otherwise the assertion could
    // pass for the wrong reason (effect hadn't fired yet).
    await screen.findByText(/Pitch an idea below/i);
    expect(
      screen.queryByRole('region', { name: /previous draft/i }),
    ).not.toBeInTheDocument();
  });

  it('typing in the input while the banner is up implicitly discards it AND persists the new work', async () => {
    // Regression for PR #83 review: freezing saveDraft while the banner
    // was visible meant a user who started a fresh conversation (typed
    // a feature description, then refreshed) would lose what they
    // wrote. The implicit-discard effect resolves this by dismissing
    // the banner the moment the user actually engages with the form,
    // so saveDraft can take over and persist the new state.
    plantStaleDraft();
    const user = userEvent.setup();
    render(<PmChat repos={repos} />);

    // Banner visible at first.
    expect(
      await screen.findByRole('region', { name: /previous draft/i }),
    ).toBeInTheDocument();

    // User starts typing a fresh description without clicking either
    // banner button.
    const textarea = screen.getByPlaceholderText(/Describe the feature/i);
    await user.type(textarea, 'fresh idea pitch');

    // Banner dismissed — implicit discard.
    await waitFor(() => {
      expect(
        screen.queryByRole('region', { name: /previous draft/i }),
      ).not.toBeInTheDocument();
    });

    // New work is persisted to localStorage.
    await waitFor(() => {
      const stored = window.localStorage.getItem(DRAFT_STORAGE_KEY);
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored as string) as {
        repo: string;
        title: string;
        input: string;
      };
      expect(parsed.input).toBe('fresh idea pitch');
      // The stale repo is gone — saveDraft now reflects the live form
      // state, which still points at the dropdown's defaultRepo.
      expect(parsed.repo).toBe('q/social-media');
      expect(parsed.title).toBe('');
    });
  });

});

describe('<PmChat> — Approve card surfaces the target repo', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("includes the selected owner/repo in the approve card's header", () => {
    render(<PmChat repos={repos} />);
    // Approve card heading and disabled approve button BOTH name the repo
    // (defense in depth so the irreversible click can't happen with the
    // target invisible).
    const heading = screen.getByRole('heading', {
      name: /Approve and start implementation on q\/social-media/i,
    });
    expect(heading).toBeInTheDocument();

    const startButton = screen.getByRole('button', { name: /Start on q\/social-media/i });
    expect(startButton).toBeInTheDocument();
    // Still gated on agreed scope.
    expect(startButton).toBeDisabled();
  });

  it("uses the URL-provided initialRepo when valid", () => {
    render(<PmChat repos={repos} initialRepo="q/whatsapp-console" />);
    expect(
      screen.getByRole('heading', {
        name: /Approve and start implementation on q\/whatsapp-console/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Start on q\/whatsapp-console/i }),
    ).toBeInTheDocument();
  });
});

/**
 * Regression test for the misrouted-PM bug: the transport's body() closure
 * captured the FIRST-render `repo` value. Switching the dropdown updated
 * the displayed value (Approve card heading, etc.) but the streaming chat
 * request still POSTed the original repo, so the PM agent loaded pm.md
 * from the wrong repository and the user saw a response grounded in the
 * wrong product domain.
 *
 * The fix routes the transport's body() through a ref that's kept in sync
 * with the current `repo` state, so every request reads the latest value.
 */
describe('<PmChat> — transport carries the current repo selection', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    window.localStorage.clear();
    // Stub the streaming endpoint with a minimal empty stream so the
    // transport's fetch call resolves without hanging the test.
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('POSTs the dropdown-selected repo, not the initial one', async () => {
    const user = userEvent.setup();
    // Start pinned to q/social-media via initialRepo so the post-switch
    // assertion is unambiguous (any successful switch to whatsapp-console
    // means the dropdown change really propagated through React state).
    render(<PmChat repos={repos} initialRepo="q/social-media" />);

    // Switch the dropdown to q/whatsapp-console via the mocked native select.
    const select = screen.getByTestId('repo-select-mock') as HTMLSelectElement;
    await user.selectOptions(select, 'q/whatsapp-console');

    // Sanity-check the visible state actually flipped — the Approve card
    // heading mirrors the selected repo, so use it as the post-switch
    // signal before exercising the chat.
    await waitFor(() =>
      expect(
        screen.getByRole('heading', {
          name: /Approve and start implementation on q\/whatsapp-console/i,
        }),
      ).toBeInTheDocument(),
    );

    // Type a pitch and send it.
    const input = screen.getByPlaceholderText(/describe the feature/i);
    await user.type(input, 'help me start a feature');
    const sendButton = screen.getByRole('button', { name: /^Send$/i });
    await user.click(sendButton);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });

    const call = fetchSpy.mock.calls.find(([url]) =>
      typeof url === 'string' && url.endsWith('/api/pm-chat'),
    );
    expect(call, 'expected a POST to /api/pm-chat').toBeDefined();

    const init = call![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.repo).toBe('q/whatsapp-console');
  });
});
