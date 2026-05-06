'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cancelRun } from '@/lib/actions';

type Props = {
  repo: string;
  runId: number;
};

/**
 * Per-run cancel button on the active-runs panel. Confirms before
 * firing so a misclick on a running implement (which may be 5+
 * minutes into useful work) doesn't lose progress.
 */
export function CancelRunButton({ repo, runId }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  if (cancelled) {
    return (
      <span className="text-xs text-muted-foreground">cancel requested · refresh to update</span>
    );
  }

  const onClick = () => {
    if (!confirm(`Cancel run #${runId}? In-flight agent work will be lost.`)) return;
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.append('repo', repo);
      fd.append('run_id', String(runId));
      const result = await cancelRun(fd);
      if (result && 'error' in result) {
        setError(result.error);
      } else {
        setCancelled(true);
      }
    });
  };

  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        onClick={onClick}
        disabled={pending}
        className="h-6 px-2 text-xs"
      >
        {pending ? 'Cancelling…' : 'Cancel'}
      </Button>
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : null}
    </span>
  );
}
