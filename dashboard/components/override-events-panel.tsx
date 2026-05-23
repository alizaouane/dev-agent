// dashboard/components/override-events-panel.tsx
import type { OverrideEvent } from '@/lib/dashboard/override-events';
import { Term } from '@/components/ui/term';

const TRUNCATE = 80;

function truncate(s: string, n = TRUNCATE): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function relativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function OverrideEventsPanel({
  events,
  repo,
}: {
  events: OverrideEvent[];
  repo: string; // "owner/name", used in PR link construction
}) {
  if (events.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
        No <Term k="swarm-override" label="swarm-review override" /> activity on this repo in the last 90 days.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-card p-4 text-sm">
      <p className="text-xs text-muted-foreground">
        Reconstructed from audit anchors on PR comments. Last 10 in the past 90 days.
      </p>
      <ul className="mt-3 divide-y divide-border">
        {events.map((e, i) => (
          // Composite key — a single comment can carry multiple anchors
          // (e.g., edited to add a follow-up); `source_comment_url` alone
          // would collide and React would drop or duplicate rows.
          <li key={`${e.source_comment_url}#${e.ts}#${i}`} className="grid grid-cols-12 gap-2 py-2 text-xs">
            <time
              className="col-span-2 text-muted-foreground"
              dateTime={e.ts}
              title={e.ts}
            >
              {relativeTime(e.ts)}
            </time>
            <a
              className="col-span-1 font-mono underline"
              href={`https://github.com/${repo}/pull/${e.pr_number}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              #{e.pr_number}
            </a>
            <a
              className="col-span-2 underline"
              href={`https://github.com/${e.actor}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              @{e.actor}
            </a>
            <span className="col-span-5" title={e.reason}>
              {truncate(e.reason)}
            </span>
            <a
              className="col-span-2 text-right text-muted-foreground underline"
              href={e.source_comment_url}
              target="_blank"
              rel="noreferrer noopener"
            >
              view audit comment
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
