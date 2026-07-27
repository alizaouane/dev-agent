import { fetchCostReport, shapeDailyByModel } from '@/lib/anthropic-cost';
import { CostByModelChart } from '@/components/cost-by-model-chart';
import { PageHeader } from '@/components/ui/page-header';

// Refresh hourly. Rationale is cost/UX, not a hard rate limit — the endpoint
// tolerates ~1/min and data lags ~5 min. Reading a secret + doing a network
// call keeps this segment dynamic-with-ISR (never statically prerendered).
export const revalidate = 3600;

/** RFC 3339 timestamp at UTC midnight `days` ago (start of that UTC day). */
function utcMidnightDaysAgo(days: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days),
  ).toISOString();
}

/** Amber notice shown when the report can't be produced — never a silent $0. */
function Notice({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-muted-foreground">{body}</p>
    </div>
  );
}

/**
 * Cost page. Shows real, Console-matching Anthropic spend for the last 30 UTC
 * days (total + daily-by-model chart) from the Admin Cost Report API, or an
 * explicit not-configured / empty / error state. Per-repo/phase attribution is
 * Phase 2.
 */
export default async function CostPage() {
  const startingAt = utcMidnightDaysAgo(30);
  const endingAt = new Date().toISOString();
  const report = await fetchCostReport({ startingAt, endingAt });

  let body: React.ReactNode;

  if (!report.ok) {
    if (report.reason === 'no_key') {
      body = (
        <Notice
          title="ANTHROPIC_ADMIN_KEY isn't set on this dashboard yet."
          body={
            <>
              Real Anthropic spend is read from the Admin Cost Report API. Create an
              admin key in the Anthropic Console (Settings → Admin keys — prefix{' '}
              <code>sk-ant-admin01-</code>, requires org admin/owner) and set it as{' '}
              <code>ANTHROPIC_ADMIN_KEY</code> in this dashboard&apos;s environment
              (e.g. Vercel → Settings → Environment Variables).
            </>
          }
        />
      );
    } else if (report.reason === 'unauthorized') {
      body = (
        <Notice
          title="Admin key rejected."
          body={<>Confirm <code>ANTHROPIC_ADMIN_KEY</code> is a valid <code>sk-ant-admin01-…</code> key with org access.</>}
        />
      );
    } else {
      body = (
        <Notice
          title="Couldn't reach the Anthropic Cost API."
          body={report.message ?? 'Unknown error — try again shortly.'}
        />
      );
    }
  } else {
    const summary = shapeDailyByModel(report.buckets);
    if (summary.days.length === 0 || summary.total_usd === 0) {
      body = (
        <p className="mb-6 text-sm text-muted-foreground">
          No Anthropic spend recorded in the last 30 days.
        </p>
      );
    } else {
      body = (
        <>
          <p className="mb-6 text-sm text-muted-foreground">
            Anthropic spend, last 30 UTC days. Total: <strong>${summary.total_usd.toFixed(2)}</strong>.{' '}
            <span className="text-xs">(matches your Anthropic Console, excl. Priority Tier; data lags ~5 min)</span>
          </p>
          <CostByModelChart data={summary.days} />
        </>
      );
    }
  }

  return (
    <div>
      <PageHeader
        title="Cost"
        descriptor="Real Anthropic spend, last 30 days."
        helpTerm="cost-page"
      />
      {body}

      <div className="mt-10 border-t pt-6">
        <h2 className="text-sm font-medium text-muted-foreground">
          Per-repo &amp; per-phase breakdown — coming in Phase 2
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Attributing spend to individual repos and pipeline phases requires per-run
          instrumentation of the phase workflows. Tracked as Phase 2.
        </p>
      </div>
    </div>
  );
}
