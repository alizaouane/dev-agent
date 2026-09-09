import type { ReadinessVerdict, RequirementStatus } from '@/lib/onboarding';

/**
 * Onboarding checklist for a repo: what is configured, what is not, and what
 * each gap actually costs.
 *
 * Replaces a checklist that tracked milestones — first proposal, first feature
 * shipped — none of which is what stalls a new project. Configuration is.
 *
 * Every row states a consequence, not just a name. A checklist item that reads
 * "PR fixer workflow ☐" gets skipped; one that says mentioning the agent on a
 * pull request currently does nothing gets acted on. Rows already met collapse
 * to a line, so the page shows the work remaining rather than a wall of ticks.
 */

/** Icon and colour for one check state. */
const MARK: Record<RequirementStatus['state'], { glyph: string; className: string }> = {
  met: { glyph: '✓', className: 'text-muted-foreground' },
  missing: { glyph: '☐', className: 'text-destructive' },
  unknown: { glyph: '?', className: 'text-amber-600 dark:text-amber-500' },
  'not-applicable': { glyph: '–', className: 'text-muted-foreground' },
};

/**
 * Render the readiness checklist.
 *
 * @param repoName - `owner/name`, for the heading.
 * @param rows - Every requirement with its probed state.
 * @param verdict - The summary over those rows.
 */
export function RepoReadiness({
  repoName,
  rows,
  verdict,
}: {
  repoName: string;
  rows: RequirementStatus[];
  verdict: ReadinessVerdict;
}) {
  const outstanding = rows.filter((r) => r.state === 'missing' || r.state === 'unknown');
  const settled = rows.filter((r) => r.state === 'met' || r.state === 'not-applicable');

  return (
    <div className="rounded-md border border-border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">Onboarding · {repoName}</h3>
        <span
          className={
            verdict.ready ? 'text-sm text-muted-foreground' : 'text-sm font-medium text-destructive'
          }
        >
          {verdict.message}
        </span>
      </div>

      {outstanding.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-4">
          {outstanding.map((r) => (
            <li key={r.id} className="text-sm">
              <p className={`font-medium ${MARK[r.state].className}`}>
                {MARK[r.state].glyph} {r.label}
                {r.required ? null : (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">optional</span>
                )}
              </p>
              <p className="mt-1 max-w-2xl text-muted-foreground">{r.consequence}</p>
              <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                {r.state === 'unknown' && r.detail ? `Could not check: ${r.detail}. ` : null}
                {r.remedy}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      {settled.length > 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {settled.map((r) => `${MARK[r.state].glyph} ${r.label}`).join('   ')}
        </p>
      ) : null}
    </div>
  );
}
