'use client';

import { useMemo, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { dispatchFromSpec, dispatchFromStory } from '@/lib/actions';
import type { SpecPair } from '@/lib/spec-pairs';
import type { StoryItem } from '@/lib/story-items';

/**
 * Per-repo panel for starting work on a spec that is already approved.
 *
 * It used to offer two independent dropdowns, one of specs and one of plans,
 * each defaulting to the first file in its own list. On a real repo that meant
 * a September spec sitting beside a March plan, with nothing to stop you
 * dispatching that pair. Specs and plans are written together and named
 * together, so they are now offered together, matched on the shared topic.
 *
 * It also used to offer every spec in the repo. Since work can only start on a
 * spec carrying a recorded approval, offering the other 250 was offering
 * choices that could only fail — the server action refuses them, but only
 * after a round trip and an error message. Only approved pairs are listed, and
 * when there are none the panel says where approval happens instead of
 * presenting an empty control.
 *
 * A second, independent section offers the same treatment for stories: its
 * own selection state, its own title override, its own submit action and its
 * own error state, so acting in one section can never disturb the other. It
 * renders only when the repo actually has a story tree — `stories` defaults
 * to empty and every existing caller that only knows about specs keeps
 * compiling and keeps rendering exactly what it rendered before.
 */
export function StartFromSpecPanel({
  repo,
  pairs,
  listingIncomplete = false,
  stories = [],
  storyListingIncomplete = false,
}: {
  repo: string;
  /** Every spec on the default branch, paired with its plan. */
  pairs: SpecPair[];
  /**
   * True when a spec or plan directory could not be read. Specs missing for
   * that reason never reach the verifier, so nothing else here would know
   * the list is short.
   */
  listingIncomplete?: boolean;
  /**
   * Every story under the repo's configured story directory, gate-verified.
   * Defaults to empty so a caller that has not been updated to pass stories
   * renders only the spec section, unchanged.
   */
  stories?: StoryItem[];
  /**
   * True when the artifacts config or the story tree itself could not be
   * read. A story missing for that reason never reaches the verifier, so
   * nothing else here would know the list is short.
   */
  storyListingIncomplete?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const approved = useMemo(() => pairs.filter((p) => p.approved), [pairs]);
  // Separate from "not approved". These are specs whose approval could not be
  // read at all — a rate limit, an expired token. Folding them into the
  // unapproved count would report an outage as a decision nobody made.
  const unverified = useMemo(() => pairs.filter((p) => p.unverified).length, [pairs]);
  // Counted apart from the unapproved ones. A spec whose approval could not be
  // read is not a spec nobody approved, and saying "none of them approved"
  // over a rate limit is the outage-as-decision claim this panel keeps having
  // to avoid making.
  const unapproved = pairs.length - approved.length - unverified;
  const incomplete = unverified > 0 || listingIncomplete;
  // Keyed on the spec path, not the slug: two specs can share a slug across
  // the legacy and superpowers trees, and a picker keyed on slug would render
  // them as one option and dispatch whichever it found first.
  const [key, setKey] = useState(approved[0]?.key ?? '');
  const selected = approved.find((p) => p.key === key) ?? approved[0];
  const [title, setTitle] = useState('');

  // Story section state, kept entirely separate from the spec section's above
  // so submitting one form, or an error on one, never touches the other.
  const [storyPending, startStoryTransition] = useTransition();
  const [storyError, setStoryError] = useState<string | null>(null);

  const approvedStories = useMemo(() => stories.filter((s) => s.approved), [stories]);
  // Separate from "not approved", for the same reason the spec section keeps
  // its own count separate: a story whose approval could not be read is not a
  // story nobody approved.
  const unverifiedStories = useMemo(
    () => stories.filter((s) => s.unverified).length,
    [stories],
  );
  const unapprovedStories = stories.length - approvedStories.length - unverifiedStories;
  const storyIncomplete = unverifiedStories > 0 || storyListingIncomplete;
  // Keyed on the story path, which `toStoryItems` already guarantees is unique.
  const [storyKey, setStoryKey] = useState(approvedStories[0]?.key ?? '');
  const selectedStory = approvedStories.find((s) => s.key === storyKey) ?? approvedStories[0];
  const [storyTitle, setStoryTitle] = useState('');

  return (
    <>
    <div className="rounded-md border border-border bg-card p-5">
      <h3 className="mb-1 text-base font-semibold">Start work on an approved spec</h3>

      {approved.length === 0 ? (
        <p className="max-w-2xl text-sm text-muted-foreground">
          Nothing here yet. A spec becomes startable once it has been reviewed
          and you have approved it, which happens in your Claude Code session —
          pitch the work there, and the approval is recorded next to the spec.
          {unapproved > 0 ? (
            <>
              {' '}
              This repo has {unapproved} spec{unapproved === 1 ? '' : 's'} on the
              default branch without an approval.
            </>
          ) : null}
          {unverified > 0 ? (
            <>
              {' '}
              Another {unverified} carr{unverified === 1 ? 'ies' : 'y'} an
              approval that could not be read just now.
            </>
          ) : null}
          {incomplete ? (
            <>
              {' '}
              <span className="text-destructive">
                Some of this repo could not be read just now, so what is listed
                here may be short. Reload in a moment.
              </span>
            </>
          ) : null}
        </p>
      ) : (
        <>
          <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
            Starts the implement workflow on the issue your Claude Code session
            filed for this spec, or files one if there isn&apos;t one yet. The
            spec and its plan are paired for you.
            {incomplete ? (
              <>
                {' '}
                <span className="text-destructive">
                  Some of this repo could not be read just now, so approved specs
                  may be missing from this list. Reload in a moment.
                </span>
              </>
            ) : null}
          </p>
          <form
            action={(formData) => {
              setError(null);
              startTransition(async () => {
                try {
                  const result = await dispatchFromSpec(formData);
                  if (result && 'error' in result) setError(result.error);
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  if (msg.includes('NEXT_REDIRECT')) throw e;
                  setError(msg);
                }
              });
            }}
            className="flex flex-col gap-3"
          >
            <input type="hidden" name="repo" value={repo} />
            <input type="hidden" name="spec_path" value={selected?.specPath ?? ''} />
            <input type="hidden" name="plan_path" value={selected?.planPath ?? ''} />

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Approved spec</span>
              <select
                value={selected?.key ?? ''}
                onChange={(e) => setKey(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1"
              >
                {approved.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.title}
                    {p.planPath ? '' : ' (no plan)'}
                  </option>
                ))}
              </select>
            </label>

            {selected ? (
              <p className="text-xs text-muted-foreground">
                <code>{selected.specPath}</code>
                {selected.planPath ? (
                  <>
                    {' · '}
                    <code>{selected.planPath}</code>
                  </>
                ) : (
                  ' · no matching plan; the agent derives its own task list'
                )}
              </p>
            ) : null}

            {/*
              Two fields, because the two paths want different things. `title`
              names a new issue and falls back to the spec's own name, so
              leaving the box untouched is a valid answer rather than a
              validation error. `custom_title` carries only what was actually
              typed, so reusing an issue renames it when the user asked for a
              different title and leaves it alone when they did not.
            */}
            <input type="hidden" name="title" value={title.trim() || selected?.title || ''} />
            <input type="hidden" name="custom_title" value={title.trim()} />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Issue title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={selected?.title ?? ''}
                aria-label="Issue title"
                className="rounded border border-border bg-background px-2 py-1"
              />
              <span className="text-xs text-muted-foreground">
                Leave blank to keep the spec&apos;s own name, or the title of the
                issue your session already filed.
              </span>
            </label>

            <div>
              <Button type="submit" disabled={pending || !selected}>
                {pending ? 'Starting…' : 'Start work'}
              </Button>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </form>
        </>
      )}
    </div>

    {/*
      Rendered when there is anything to say: either a story exists, or a
      failed read means one might. The second half of that condition is what
      keeps a rate-limited verification from reading as "no stories" — a
      listing that is merely absent (a 404, no story tree at all) reports
      `unreadable: false` and renders nothing here, same as before.
    */}
    {stories.length > 0 || storyListingIncomplete ? (
      <div className="mt-6 rounded-md border border-border bg-card p-5">
        <h3 className="mb-1 text-base font-semibold">Start work on an approved story</h3>

        {approvedStories.length === 0 ? (
          <p className="max-w-2xl text-sm text-muted-foreground">
            Nothing here yet. A story becomes startable once it has been
            reviewed and you have approved it, which happens in your Claude
            Code session — pitch the work there, and the approval is recorded
            next to the story.
            {unapprovedStories > 0 ? (
              <>
                {' '}
                This repo has {unapprovedStories} stor
                {unapprovedStories === 1 ? 'y' : 'ies'} on the default branch
                without an approval.
              </>
            ) : null}
            {unverifiedStories > 0 ? (
              <>
                {' '}
                Another {unverifiedStories} carr
                {unverifiedStories === 1 ? 'ies' : 'y'} an approval that could
                not be read just now.
              </>
            ) : null}
            {storyIncomplete ? (
              <>
                {' '}
                <span className="text-destructive">
                  Some of this repo could not be read just now, so what is
                  listed here may be short. Reload in a moment.
                </span>
              </>
            ) : null}
          </p>
        ) : (
          <>
            <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
              Starts the implement workflow on the issue your Claude Code
              session filed for this story, or files one if there isn&apos;t
              one yet.
              {storyIncomplete ? (
                <>
                  {' '}
                  <span className="text-destructive">
                    Some of this repo could not be read just now, so approved
                    stories may be missing from this list. Reload in a moment.
                  </span>
                </>
              ) : null}
            </p>
            <form
              action={(formData) => {
                setStoryError(null);
                startStoryTransition(async () => {
                  try {
                    const result = await dispatchFromStory(formData);
                    if (result && 'error' in result) setStoryError(result.error);
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (msg.includes('NEXT_REDIRECT')) throw e;
                    setStoryError(msg);
                  }
                });
              }}
              className="flex flex-col gap-3"
            >
              <input type="hidden" name="repo" value={repo} />
              <input type="hidden" name="story_path" value={selectedStory?.storyPath ?? ''} />

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Approved story</span>
                <select
                  value={selectedStory?.key ?? ''}
                  onChange={(e) => setStoryKey(e.target.value)}
                  className="rounded border border-border bg-background px-2 py-1"
                >
                  {approvedStories.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>

              {selectedStory ? (
                <p className="text-xs text-muted-foreground">
                  <code>{selectedStory.storyPath}</code>
                </p>
              ) : null}

              {/*
                Same two-field split as the spec form, verbatim: `title` names
                a new issue and falls back to the story's own name, so leaving
                the box untouched is a valid answer rather than a validation
                error. `custom_title` carries only what was actually typed, so
                reusing an issue renames it when the user asked for a
                different title and leaves it alone when they did not.
              */}
              <input
                type="hidden"
                name="title"
                value={storyTitle.trim() || selectedStory?.title || ''}
              />
              <input type="hidden" name="custom_title" value={storyTitle.trim()} />
              <label className="flex flex-col gap-1 text-sm">
                {/*
                  "Story issue title", not "Issue title": with both sections
                  on the page, two inputs sharing one accessible name leave a
                  screen-reader user unable to tell which is which. The spec
                  section's own label and `aria-label` are untouched.
                */}
                <span className="font-medium">Story issue title</span>
                <input
                  value={storyTitle}
                  onChange={(e) => setStoryTitle(e.target.value)}
                  placeholder={selectedStory?.title ?? ''}
                  aria-label="Story issue title"
                  className="rounded border border-border bg-background px-2 py-1"
                />
                <span className="text-xs text-muted-foreground">
                  Leave blank to keep the story&apos;s own name, or the title
                  of the issue your session already filed.
                </span>
              </label>

              <div>
                {/*
                  "Start work on this story", not the spec section's plain
                  "Start work" — the same reasoning as the title field above:
                  two same-named buttons on one page are indistinguishable by
                  accessible name alone.
                */}
                <Button type="submit" disabled={storyPending || !selectedStory}>
                  {storyPending ? 'Starting…' : 'Start work on this story'}
                </Button>
              </div>
              {storyError ? (
                <p role="alert" className="text-xs text-destructive">
                  {storyError}
                </p>
              ) : null}
            </form>
          </>
        )}
      </div>
    ) : null}
    </>
  );
}
