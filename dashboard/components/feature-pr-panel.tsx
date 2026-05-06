import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MergePRButton } from '@/components/merge-pr-button';
import type { FeaturePR } from '@/lib/feature-pr';

/**
 * Per-feature PR panel: shows the linked PR, head/base refs, check
 * status, and a merge button when the PR is mergeable. Closes the
 * dashboard's loop after the implement phase ships — the operator
 * can review, see CI status, and merge without leaving.
 */
export function FeaturePRPanel({
  pr,
  repo,
}: {
  pr: FeaturePR | null;
  repo: string;
}) {
  if (!pr) return null;
  const stateColor =
    pr.state === 'merged'
      ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300'
      : pr.state === 'closed'
        ? 'bg-muted text-muted-foreground'
        : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pull request</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <a
            href={pr.html_url}
            rel="noreferrer noopener"
            target="_blank"
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            #{pr.number} {pr.title}
          </a>
          <span className={`rounded px-2 py-0.5 text-xs ${stateColor}`}>{pr.state}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            <code>{pr.head_ref}</code> → <code>{pr.base_ref}</code>
          </span>
          <ChecksBadge state={pr.checks_state} count={pr.check_runs.length} />
          {pr.mergeable === false ? (
            <Badge variant="destructive" className="text-xs">
              not mergeable
            </Badge>
          ) : null}
        </div>

        {pr.check_runs.length > 0 ? (
          <details className="rounded border border-border bg-card p-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {pr.check_runs.length} check{pr.check_runs.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {pr.check_runs.map((c, i) => (
                <li key={`${c.name}-${i}`} className="flex items-center gap-2">
                  <CheckRunDot conclusion={c.conclusion} status={c.status} />
                  <span className="font-mono text-[11px]">{c.name}</span>
                  <span className="text-muted-foreground">
                    {c.status === 'completed' ? c.conclusion ?? '' : c.status}
                  </span>
                  {c.html_url ? (
                    <a
                      href={c.html_url}
                      rel="noreferrer noopener"
                      target="_blank"
                      className="ml-auto underline-offset-4 hover:underline"
                    >
                      logs
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {pr.state === 'open' ? (
          <MergePRButton
            repo={repo}
            pr={pr.number}
            mergeable={pr.mergeable}
            checksState={pr.checks_state}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function ChecksBadge({
  state,
  count,
}: {
  state: FeaturePR['checks_state'];
  count: number;
}) {
  if (count === 0 || state === null) return null;
  const map: Record<NonNullable<FeaturePR['checks_state']>, { label: string; cls: string }> = {
    success: { label: 'checks pass', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
    failure: { label: 'checks failing', cls: 'bg-destructive/15 text-destructive' },
    pending: { label: 'checks pending', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
    neutral: { label: 'checks neutral', cls: 'bg-muted text-muted-foreground' },
  };
  const v = map[state];
  return <span className={`rounded px-2 py-0.5 ${v.cls}`}>{v.label}</span>;
}

function CheckRunDot({
  conclusion,
  status,
}: {
  conclusion: string | null;
  status: string;
}) {
  // Compact 8x8 status dot to keep the per-check row scannable.
  let cls = 'bg-muted-foreground/40';
  if (status !== 'completed') cls = 'bg-amber-500';
  else if (conclusion === 'success') cls = 'bg-emerald-500';
  else if (conclusion === 'failure' || conclusion === 'timed_out') cls = 'bg-destructive';
  else if (conclusion === 'skipped' || conclusion === 'cancelled') cls = 'bg-muted-foreground/60';
  return <span aria-hidden className={`inline-flex h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}
