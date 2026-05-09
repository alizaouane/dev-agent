import type { VerificationRollup } from '@/lib/verification/types';

export function VerificationPostureStrip({ rollup }: { rollup: VerificationRollup }) {
  const isEmpty =
    rollup.shipped_count === 0 &&
    rollup.audit_caught_count === 0 &&
    rollup.risk_flagged_count === 0 &&
    rollup.smoke_failed_count === 0 &&
    rollup.total_cost_usd === 0;
  if (isEmpty) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
        No verification activity yet — runs will populate this once you ship a feature.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-card p-4 text-sm">
      <span className="font-medium">Last {rollup.window_days} days:</span>{' '}
      {rollup.shipped_count} features shipped ·{' '}
      {rollup.audit_caught_count} audits caught issues fixed pre-merge ·{' '}
      {rollup.risk_flagged_count} risk-flagged for re-review ·{' '}
      {rollup.smoke_failed_count} smoke check{rollup.smoke_failed_count === 1 ? '' : 's'} failed ·{' '}
      ${rollup.total_cost_usd.toFixed(2)} spent
    </div>
  );
}
