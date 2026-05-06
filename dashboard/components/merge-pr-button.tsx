'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { mergeFeaturePR } from '@/lib/actions';

type Props = {
  repo: string;
  pr: number;
  mergeable: boolean | null;
  checksState: 'success' | 'failure' | 'pending' | 'neutral' | null;
};

/**
 * Merge button on the feature PR panel. Squash by default — matches
 * the engine's PR convention (clean main, summary commit per
 * feature). Disables when checks are failing or pending; the override
 * link sends the operator to GitHub for the manual decision.
 */
export function MergePRButton({ repo, pr, mergeable, checksState }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [merged, setMerged] = useState(false);

  const blockReason = mergeable === false
    ? 'PR is not mergeable (conflicts or branch behind base).'
    : checksState === 'failure'
      ? 'Checks are failing — fix or bypass on GitHub.'
      : checksState === 'pending'
        ? 'Checks still running — wait for them to settle.'
        : null;

  const onClick = () => {
    if (!confirm(`Squash-merge PR #${pr}?`)) return;
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.append('repo', repo);
      fd.append('pr_number', String(pr));
      fd.append('merge_method', 'squash');
      const result = await mergeFeaturePR(fd);
      if (result && 'error' in result) {
        setError(result.error);
      } else {
        setMerged(true);
      }
    });
  };

  if (merged) {
    return (
      <p className="text-sm text-emerald-600 dark:text-emerald-400">
        Merged. Refresh the page for the updated state.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={onClick}
          disabled={pending || blockReason !== null}
          title={blockReason ?? 'Squash + merge'}
        >
          {pending ? 'Merging…' : 'Squash & merge'}
        </Button>
        {blockReason ? (
          <span className="text-xs text-muted-foreground">{blockReason}</span>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-destructive break-words">{error}</p>
      ) : null}
    </div>
  );
}
