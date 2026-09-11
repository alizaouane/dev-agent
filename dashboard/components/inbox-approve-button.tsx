'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { approveGate } from '@/lib/actions';

/**
 * The inbox's gate button, with somewhere to put a refusal.
 *
 * Approving now runs the spec-approval check and refuses while a run is in
 * flight, and both of those are things the operator can act on. As a bare
 * server-action form the refusal reached them as Next.js' generic error
 * boundary — a blank wall where the reason should be. Same shape as
 * `FeatureApproveButton`, which has reported its refusals inline all along.
 */
export function InboxApproveButton({
  repo,
  issue,
  promote,
  label,
}: {
  /** `owner/name`. */
  repo: string;
  /** Issue number. */
  issue: number;
  /** True for the `--promote` gate. */
  promote: boolean;
  /** Button text, which names the gate. */
  label: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          try {
            const result = await approveGate(formData);
            if (result && 'error' in result) setError(result.error);
          } catch (e) {
            // Next.js' redirect() throws NEXT_REDIRECT — let it through.
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes('NEXT_REDIRECT')) throw e;
            setError(msg);
          }
        });
      }}
      className="flex flex-col items-end gap-1"
    >
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="issue" value={String(issue)} />
      <input type="hidden" name="promote" value={promote ? '1' : '0'} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? 'Starting…' : label}
      </Button>
      {error ? <p className="max-w-xs text-right text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
