'use client';

import { useMemo, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { dispatchFromSpec } from '@/lib/actions';
import type { SpecPair } from '@/lib/spec-pairs';

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
 */
export function StartFromSpecPanel({
  repo,
  pairs,
}: {
  repo: string;
  /** Every spec on the default branch, paired with its plan. */
  pairs: SpecPair[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const approved = useMemo(() => pairs.filter((p) => p.approved), [pairs]);
  // Separate from "not approved". These are specs whose approval could not be
  // read at all — a rate limit, an expired token. Folding them into the
  // unapproved count would report an outage as a decision nobody made.
  const unverified = useMemo(() => pairs.filter((p) => p.unverified).length, [pairs]);
  // Keyed on the spec path, not the slug: two specs can share a slug across
  // the legacy and superpowers trees, and a picker keyed on slug would render
  // them as one option and dispatch whichever it found first.
  const [key, setKey] = useState(approved[0]?.key ?? '');
  const selected = approved.find((p) => p.key === key) ?? approved[0];
  const [title, setTitle] = useState('');

  return (
    <div className="rounded-md border border-border bg-card p-5">
      <h3 className="mb-1 text-base font-semibold">Start work on an approved spec</h3>

      {approved.length === 0 ? (
        <p className="max-w-2xl text-sm text-muted-foreground">
          Nothing here yet. A spec becomes startable once it has been reviewed
          and you have approved it, which happens in your Claude Code session —
          pitch the work there, and the approval is recorded next to the spec.
          {pairs.length > 0 ? (
            <>
              {' '}
              This repo has {pairs.length} spec{pairs.length === 1 ? '' : 's'} on
              the default branch, none of them approved.
            </>
          ) : null}
          {unverified > 0 ? (
            <>
              {' '}
              <span className="text-destructive">
                {unverified} approval{unverified === 1 ? '' : 's'} could not be
                read just now, so this list may be short. Reload in a moment.
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
            {unverified > 0 ? (
              <>
                {' '}
                <span className="text-destructive">
                  {unverified} further approval{unverified === 1 ? '' : 's'} could
                  not be read just now and {unverified === 1 ? 'is' : 'are'} missing
                  from this list. Reload in a moment.
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
              The submitted title falls back to the spec's own name, so leaving
              the box untouched is a valid answer rather than a validation
              error. The visible input carries no `name` for that reason.
            */}
            <input type="hidden" name="title" value={title.trim() || selected?.title || ''} />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Issue title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={selected?.title ?? ''}
                aria-label="Issue title"
                className="rounded border border-border bg-background px-2 py-1"
              />
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
  );
}
