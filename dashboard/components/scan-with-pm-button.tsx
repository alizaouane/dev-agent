'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { triggerUnfinishedWorkScan } from '@/lib/actions';
import { InstallWorkflowPanel } from '@/components/install-workflow-panel';
import { ScanRunStatus } from '@/components/scan-run-status';

type Props = {
  repo: string;
  /**
   * Whether the unfinished-work-scout workflow file is present on the
   * repo's default branch. Older wire-ups (pre-Phase-2) won't have it
   * yet — show an inline "Install" panel that backfills the missing
   * workflow file with a single click.
   */
  workflowPresent: boolean;
};

export function ScanWithPmButton({ repo, workflowPresent }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dispatchedAt, setDispatchedAt] = useState<number | null>(null);

  if (!workflowPresent) {
    return (
      <InstallWorkflowPanel
        repo={repo}
        workflow="unfinished-work"
        title="PM scan"
        description="This repo was wired up before the unfinished-work scout existed. Install it to enable deeper LLM scans for stubs, half-shipped features, and skipped tests."
      />
    );
  }

  const onClick = () => {
    setError(null);
    setDispatchedAt(null);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append('repo', repo);
        await triggerUnfinishedWorkScan(fd);
        setDispatchedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex max-w-xl flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Fires an LLM scan over this repo&apos;s code looking for stubs,
        half-shipped features, abandoned migrations, untracked specs, and
        skipped tests — the things the heuristic scout on{' '}
        <code>/proposals</code> can&apos;t see. Each click costs ~$0.10–0.30
        in Anthropic tokens. Findings appear as <code>kind:unfinished-work</code>{' '}
        issues + on <code>/proposals</code> within a few minutes.
      </p>
      <div className="flex items-center gap-3">
        <Button type="button" onClick={onClick} disabled={pending} size="sm">
          {pending ? 'Dispatching…' : 'Scan with PM'}
        </Button>
        {dispatchedAt ? (
          <ScanRunStatus
            repo={repo}
            workflow="dev-agent-unfinished-work-scout.yml"
            since={dispatchedAt}
            proposalsHref={`/proposals?repo=${encodeURIComponent(repo)}`}
          />
        ) : null}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}
