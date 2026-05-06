'use client';

import { useState } from 'react';
import { RunProgress } from '@/components/run-progress';

type Props = {
  runId: number;
  repo: string;
};

/**
 * Disclosure wrapper for RunProgress so polling is gated on the user
 * actually expanding the drawer. Without this, every active run
 * row mounts a polling loop on page load — two GitHub API calls
 * every 8s per run — burning rate-limit budget for the common case
 * where the operator just glanced at the page without drilling in.
 *
 * The native `<details>` element renders its children to the DOM
 * even when collapsed (so children mount + run effects); we react
 * to the `toggle` event and only render <RunProgress> while open,
 * which causes it to mount on expand and unmount on collapse —
 * effectively starting and stopping the poll loop on user intent.
 */
export function RunProgressDrawer({ runId, repo }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded border border-blue-500/30 bg-background/40 px-2 py-1"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Live progress
      </summary>
      <div className="mt-2">
        {open ? (
          <RunProgress runId={runId} repo={repo} />
        ) : null}
      </div>
    </details>
  );
}
