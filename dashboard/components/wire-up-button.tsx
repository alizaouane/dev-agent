'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { wireUpRepo } from '@/lib/actions';

/**
 * Inline button shown next to each unwired repo on /repos. On click, calls
 * the `wireUpRepo` server action which:
 *   1. opens a PR adding the dev-agent template files, and
 *   2. redirects the browser to the new PR's GitHub URL.
 *
 * The button shows a "Wiring up..." pending state via React's useTransition
 * so the user gets immediate feedback (the server action's network call +
 * redirect can take a few seconds).
 *
 * Errors surface as a small inline error message rather than throwing into
 * Next.js' error boundary — most failures are recoverable (e.g., user lacks
 * write perms on this specific repo) and we don't want to navigate away
 * from the rest of the repo list.
 */
export function WireUpButton({
  owner,
  repo,
  default_branch,
}: {
  owner: string;
  repo: string;
  default_branch: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          try {
            const result = await wireUpRepo(formData);
            // Production-mask-resistant error contract: wireUpRepo
            // returns { error } instead of throwing so the real message
            // survives the Server Components mask. Success paths fall
            // through to the redirect (which throws NEXT_REDIRECT).
            if (result && 'error' in result) {
              setError(result.error);
            }
          } catch (e) {
            // Next.js' redirect() throws NEXT_REDIRECT — let it through.
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes('NEXT_REDIRECT')) throw e;
            setError(msg);
          }
        });
      }}
      className="flex shrink-0 flex-col items-end gap-1"
    >
      <input type="hidden" name="owner" value={owner} />
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="default_branch" value={default_branch} />
      <Button type="submit" disabled={pending} variant="default">
        {pending ? 'Wiring up…' : 'Wire up dev-agent'}
      </Button>
      {error ? (
        <span className="max-w-xs text-right text-xs text-destructive">{error}</span>
      ) : null}
    </form>
  );
}
