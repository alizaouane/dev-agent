'use client';

import { useEffect, useState } from 'react';
import { getLatestScanRun } from '@/lib/actions';
import { interpretScanRun, type ScanPhase } from '@/lib/scan-run';

type Props = {
  /** `owner/name`. */
  repo: string;
  /** Workflow file name, e.g. `dev-agent-bug-scout.yml`. */
  workflow: string;
  /** ms timestamp when the scan was dispatched in this session. */
  since: number;
  /** Repo-scoped proposals URL where findings will appear. */
  proposalsHref: string;
};

const POLL_MS = 10_000;

/**
 * Polls `getLatestScanRun` after a scan is dispatched and shows status
 * inline — Queued → Running → Completed/Failed — so the user never has
 * to leave the dashboard for GitHub's Actions tab. Polling stops once
 * the run reaches a terminal state or the lookup errors.
 */
export function ScanRunStatus({ repo, workflow, since, proposalsHref }: Props) {
  const [phase, setPhase] = useState<ScanPhase>({ kind: 'queued' });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      const fd = new FormData();
      fd.append('repo', repo);
      fd.append('workflow', workflow);
      const result = await getLatestScanRun(fd);
      if (cancelled) return;
      const next = interpretScanRun(result, since);
      setPhase(next);
      // Keep polling only while the run is not yet terminal and the
      // lookup is healthy.
      if (next.kind === 'queued' || next.kind === 'running') {
        timer = setTimeout(poll, POLL_MS);
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repo, workflow, since]);

  if (phase.kind === 'error') {
    return (
      <span className="text-xs text-destructive">
        Couldn&apos;t read scan status: {phase.message}
      </span>
    );
  }
  if (phase.kind === 'queued') {
    return <span className="text-xs text-muted-foreground">Scan queued…</span>;
  }
  if (phase.kind === 'running') {
    return <span className="text-xs text-muted-foreground">Scan running…</span>;
  }
  // done
  if (phase.ok) {
    return (
      <span className="text-xs text-muted-foreground">
        Scan complete.{' '}
        <a href={proposalsHref} className="underline">
          View findings
        </a>
      </span>
    );
  }
  return (
    <span className="text-xs text-destructive">
      Scan run failed.{' '}
      {phase.runUrl ? (
        <a
          href={phase.runUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="underline"
        >
          View run log
        </a>
      ) : null}
    </span>
  );
}
