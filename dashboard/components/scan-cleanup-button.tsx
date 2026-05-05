'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { triggerCleanupScan } from '@/lib/actions';

type Props = {
  repo: string;
  /**
   * Whether the cleanup-scout workflow file is present on the repo's
   * default branch. Older wire-ups (pre-cleanup-scout) won't have it
   * yet — show a degraded state pointing at re-wire-up rather than
   * letting the dispatch 404.
   */
  workflowPresent: boolean;
};

export function ScanCleanupButton({ repo, workflowPresent }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dispatchedAt, setDispatchedAt] = useState<number | null>(null);

  if (!workflowPresent) {
    return (
      <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
        <p className="font-medium">Cleanup scan isn&apos;t installed.</p>
        <p className="mt-1 text-muted-foreground">
          This repo was wired up before the cleanup scout existed. Copy the
          workflow file from the dev-agent repo&apos;s{' '}
          <code>examples/web-app-template/.github/workflows/dev-agent-cleanup-scout.yml</code>{' '}
          and commit it to <code>.github/workflows/</code> on your default branch.
        </p>
      </div>
    );
  }

  const onClick = () => {
    setError(null);
    setDispatchedAt(null);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append('repo', repo);
        await triggerCleanupScan(fd);
        setDispatchedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex max-w-xl flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Fires an LLM scan over this repo&apos;s code looking for things that
        can be deleted with no behavior change — dead exports, skipped tests
        with stale reasons, deprecated calls, unused module-level state, stale
        dated TODOs, abandoned files. Each click costs ~$0.10–0.30 in
        Anthropic tokens. Findings appear as <code>kind:cleanup</code> issues
        + on <code>/proposals</code> within a few minutes.
      </p>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={onClick} disabled={pending} size="sm">
          {pending ? 'Dispatching…' : 'Run cleanup scan'}
        </Button>
        {dispatchedAt ? (
          <span className="text-xs text-muted-foreground">
            Scan dispatched. Watch the Actions tab on GitHub for live progress;
            findings file as issues when it finishes (typically 2–5 min).
          </span>
        ) : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}
