import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CancelRunButton } from '@/components/cancel-run-button';
import { RunProgress } from '@/components/run-progress';
import type { ActiveRun } from '@/lib/active-runs';

/**
 * "Running now" panel on the feature page. Shows in-flight workflow
 * runs targeting this issue. Empty state hides the card entirely so it
 * doesn't waste space on completed features. Each row expands to a
 * live step-by-step progress view (polled client-side).
 */
export function ActiveRunsPanel({ runs, repo }: { runs: ActiveRun[]; repo: string }) {
  if (runs.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Running now</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {runs.map((r) => (
          <div
            key={r.id}
            className="flex flex-col gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
              </span>
              <span className="font-medium">{r.phase ?? 'phase'}</span>
              {r.invocation_mode ? (
                <Badge variant="secondary" className="text-xs">
                  {r.invocation_mode}
                </Badge>
              ) : null}
              <span className="text-xs text-muted-foreground" suppressHydrationWarning>
                started {formatStarted(r.created_at)}
              </span>
              <a
                href={r.html_url}
                rel="noreferrer noopener"
                target="_blank"
                className="ml-auto text-xs underline text-muted-foreground hover:text-foreground"
              >
                view logs
              </a>
              <CancelRunButton repo={repo} runId={r.id} />
            </div>
            <details className="rounded border border-blue-500/30 bg-background/40 px-2 py-1">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Live progress
              </summary>
              <div className="mt-2">
                <RunProgress runId={r.id} repo={repo} />
              </div>
            </details>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function formatStarted(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return `${h}h ago`;
}
