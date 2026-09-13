import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const dispatchFromSpec = vi.fn();
const dispatchFromStory = vi.fn();
vi.mock('@/lib/actions', () => ({
  dispatchFromSpec: (fd: FormData) => dispatchFromSpec(fd),
  dispatchFromStory: (fd: FormData) => dispatchFromStory(fd),
}));

import { StartFromSpecPanel } from '@/components/start-from-spec-panel';
import type { SpecPair } from '@/lib/spec-pairs';
import type { StoryItem } from '@/lib/story-items';

const approvedSpec: SpecPair = {
  specPath: 'docs/specs/2026-09-01-refund-design.md',
  planPath: 'docs/plans/2026-09-01-refund.md',
  slug: '2026-09-01-refund',
  key: 'docs/specs/2026-09-01-refund-design.md',
  title: 'Refund',
  approved: true,
};

const approvedStory: StoryItem = {
  storyPath: 'docs/stories/epic-8-agent-reliability/8.1-commitment-gate.md',
  key: 'docs/stories/epic-8-agent-reliability/8.1-commitment-gate.md',
  epic: 8,
  storyNumber: '8.1',
  title: '8.1 — Commitment gate',
  approved: true,
};

beforeEach(() => {
  dispatchFromSpec.mockReset();
  dispatchFromStory.mockReset();
  dispatchFromSpec.mockResolvedValue(undefined);
  dispatchFromStory.mockResolvedValue(undefined);
});

describe('<StartFromSpecPanel> — story section', () => {
  it('renders the story section when an approved story is passed', () => {
    render(<StartFromSpecPanel repo="q/r" pairs={[]} stories={[approvedStory]} />);
    expect(
      screen.getByText('Start work on an approved story'),
    ).toBeInTheDocument();
    expect(screen.getByText('8.1 — Commitment gate')).toBeInTheDocument();
  });

  it('does not render the story section at all when no story is approved and none exists', () => {
    render(<StartFromSpecPanel repo="q/r" pairs={[]} stories={[]} />);
    expect(
      screen.queryByText('Start work on an approved story'),
    ).not.toBeInTheDocument();
  });

  it('says the story list may be short when storyListingIncomplete is true', () => {
    const unapproved: StoryItem = { ...approvedStory, approved: false };
    render(
      <StartFromSpecPanel
        repo="q/r"
        pairs={[]}
        stories={[unapproved]}
        storyListingIncomplete
      />,
    );
    expect(screen.getByText(/may be short/)).toBeInTheDocument();
  });

  it('counts unverified stories apart from unapproved stories, in the story section copy', () => {
    const unapproved: StoryItem = {
      ...approvedStory,
      key: 'a',
      storyPath: 'docs/stories/epic-8-agent-reliability/8.2-a.md',
      approved: false,
      unverified: false,
    };
    const unverified: StoryItem = {
      ...approvedStory,
      key: 'b',
      storyPath: 'docs/stories/epic-8-agent-reliability/8.3-b.md',
      approved: false,
      unverified: true,
    };
    render(
      <StartFromSpecPanel repo="q/r" pairs={[]} stories={[unapproved, unverified]} />,
    );
    expect(screen.getByText(/1 story on the default branch without an approval/)).toBeInTheDocument();
    expect(
      screen.getByText(/Another 1 carries an approval that could not be read just now/),
    ).toBeInTheDocument();
  });

  it('submits story_path for the selected story', async () => {
    render(<StartFromSpecPanel repo="q/r" pairs={[]} stories={[approvedStory]} />);
    await userEvent.click(screen.getByRole('button', { name: /start work/i }));
    expect(dispatchFromStory).toHaveBeenCalledTimes(1);
    const formData = dispatchFromStory.mock.calls[0][0] as FormData;
    expect(formData.get('story_path')).toBe(approvedStory.storyPath);
    expect(formData.get('repo')).toBe('q/r');
  });

  it('keeps the spec section behaviour unchanged when only specs are passed', async () => {
    render(<StartFromSpecPanel repo="q/r" pairs={[approvedSpec]} />);
    expect(screen.getByText('Start work on an approved spec')).toBeInTheDocument();
    expect(
      screen.queryByText('Start work on an approved story'),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /start work/i }));
    expect(dispatchFromSpec).toHaveBeenCalledTimes(1);
    const formData = dispatchFromSpec.mock.calls[0][0] as FormData;
    expect(formData.get('spec_path')).toBe(approvedSpec.specPath);
    expect(dispatchFromStory).not.toHaveBeenCalled();
  });
});
