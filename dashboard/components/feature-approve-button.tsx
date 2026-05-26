'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { dispatchExistingIssue } from '@/lib/actions';

/**
 * Inline "Approve and start implementation" button on the feature page
 * for issues already at `state:spec-ready` (the path used when the
 * issue was filed via `/develop` in the consumer repo's Claude Code
 * session — spec + plan + issue land server-side, and the user lands
 * here to approve dispatch).
 *
 * Wraps `dispatchExistingIssue`, which validates the state label,
 * fires `phase=implement` on the consumer's default branch, and flips
 * `state:spec-ready` → `state:implementing`. On success the action
 * redirects (NEXT_REDIRECT), so we let that throw through. On failure
 * the action returns `{ error, issue_url? }` (production-mask-resistant
 * contract — Next.js otherwise replaces server-action errors with a
 * generic string).
 */
export function FeatureApproveButton({
  repo,
  issue,
}: {
  repo: string;
  issue: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          try {
            const result = await dispatchExistingIssue(formData);
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
      className="flex flex-col gap-1"
    >
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="issue" value={String(issue)} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Starting…' : 'Approve and start implementation'}
      </Button>
      {error ? (
        <span className="max-w-md text-xs text-destructive">{error}</span>
      ) : null}
    </form>
  );
}
