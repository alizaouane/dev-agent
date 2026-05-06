import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { FailedRun } from '@/lib/run-failures';

/**
 * Inline failure diagnostics for the feature page. Replaces the
 * "open GitHub Actions UI to read the red banner" detour for the
 * recent-failures case. Each row shows: phase + mode, conclusion,
 * the first failed step name, and a tail of its logs. Empty state
 * hides the card so it doesn't clutter healthy features.
 */
export function FailedRunsPanel({ runs }: { runs: FailedRun[] }) {
  if (runs.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent failures</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {runs.map((r) => (
          <div
            key={r.id}
            className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.phase ?? 'phase'}</span>
              {r.invocation_mode ? (
                <Badge variant="secondary" className="text-xs">
                  {r.invocation_mode}
                </Badge>
              ) : null}
              <Badge variant="destructive" className="text-xs">
                {r.conclusion}
              </Badge>
              <span className="text-xs text-muted-foreground" suppressHydrationWarning>
                {formatStarted(r.created_at)}
              </span>
              <a
                href={r.html_url}
                rel="noreferrer noopener"
                target="_blank"
                className="ml-auto text-xs underline text-muted-foreground hover:text-foreground"
              >
                view on GitHub
              </a>
            </div>
            {r.failed_step ? (
              <div className="text-xs">
                <span className="text-muted-foreground">Failed step: </span>
                <span className="font-mono">{r.failed_step}</span>
              </div>
            ) : null}
            {r.log_tail ? (
              <details className="rounded border border-border bg-background p-2 text-xs">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Log tail
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug">
                  {r.log_tail}
                </pre>
              </details>
            ) : (
              <p className="text-xs text-muted-foreground">
                No log archive (run may have failed before any job ran, or logs expired). Use &ldquo;view on GitHub&rdquo;.
              </p>
            )}
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
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
