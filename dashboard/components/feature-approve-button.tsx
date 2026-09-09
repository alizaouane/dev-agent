'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { dispatchExistingIssue } from '@/lib/actions';
import type { DispatchGateDecision } from '@/lib/spec-approval';

/**
 * The "Start work" control on the feature page, shown for issues at
 * `state:spec-ready`.
 *
 * This button does not approve anything. Approval happens in the Claude Code
 * intake session, after an independent review has run and the spec has been
 * corrected until that review comes back clean — the user approves the
 * reviewed result there, and the session records it as an artifact bound to a
 * hash of the spec and plan. All this button does is start approved work.
 *
 * The `gate` prop is the server's decision about whether that approval exists
 * and still matches the current text. It drives presentation only: the button
 * is disabled and the reason shown when the gate refuses, but
 * `dispatchExistingIssue` re-runs the same check server-side, so a stale page
 * or a hand-crafted POST is refused there too.
 *
 * On success the action redirects (NEXT_REDIRECT), so we let that throw
 * through. On failure it returns `{ error, issue_url? }` rather than throwing,
 * because Next.js replaces server-action errors with a generic string in
 * production and would otherwise strand the user with nothing actionable.
 */
export function FeatureApproveButton({
  repo,
  issue,
  gate,
}: {
  repo: string;
  issue: number;
  gate: DispatchGateDecision;
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
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="issue" value={String(issue)} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !gate.allow}>
          {pending ? 'Starting…' : 'Start work'}
        </Button>
        <span
          className={
            gate.allow
              ? 'text-xs text-muted-foreground'
              : 'text-xs font-medium text-destructive'
          }
        >
          {gate.allow ? 'Spec approved' : 'Not approved for implementation'}
        </span>
      </div>
      <p className="max-w-2xl text-xs text-muted-foreground">{gate.message}</p>
      {error ? (
        <span className="max-w-2xl text-xs text-destructive">{error}</span>
      ) : null}
    </form>
  );
}
