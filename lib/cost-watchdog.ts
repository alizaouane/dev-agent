import { parseTelemetry } from './telemetry';

export interface CommentLike {
  body: string;
  created_at: string;
}

export interface FeatureCost {
  issue: number;
  title: string;
  cost: number;
  phases: Record<string, number>; // phase name → run count
}

export interface CostBreakdown {
  total: number;
  byPhase: Record<string, number>;
  topFeatures: FeatureCost[];
}

export type Tier = 'snapshot' | 'warning' | 'exhausted';

export function aggregateCostFromComments(
  issues: { number: number; title: string; comments: CommentLike[] }[],
  monthStart: Date,
): CostBreakdown {
  const byPhase: Record<string, number> = {};
  const perIssue = new Map<number, FeatureCost>();

  for (const issue of issues) {
    for (const c of issue.comments) {
      if (new Date(c.created_at) < monthStart) continue;
      const t = parseTelemetry(c.body);
      if (!t || typeof t.cost_usd !== 'number') continue;
      byPhase[t.phase] = (byPhase[t.phase] ?? 0) + t.cost_usd;
      let fc = perIssue.get(issue.number);
      if (!fc) {
        fc = { issue: issue.number, title: issue.title, cost: 0, phases: {} };
        perIssue.set(issue.number, fc);
      }
      fc.cost += t.cost_usd;
      fc.phases[t.phase] = (fc.phases[t.phase] ?? 0) + 1;
    }
  }

  const total = Object.values(byPhase).reduce((a, b) => a + b, 0);
  const topFeatures = [...perIssue.values()].sort((a, b) => b.cost - a.cost).slice(0, 5);
  return { total, byPhase, topFeatures };
}

export function tierFor(input: { pct: number; threshold: number }): Tier {
  if (input.pct >= 100) return 'exhausted';
  if (input.pct >= input.threshold) return 'warning';
  return 'snapshot';
}

export function dedupeLabels(tier: Exclude<Tier, 'snapshot'>, monthLabel: string): string[] {
  return ['cost-watchdog', tier === 'warning' ? 'budget-warning' : 'budget-exhausted', `month:${monthLabel}`];
}

export function renderAlertBody(args: {
  tier: Exclude<Tier, 'snapshot'>;
  breakdown: CostBreakdown;
  budget: number;
  threshold: number;
  monthLabel: string;
}): string {
  const { tier, breakdown, budget, threshold, monthLabel } = args;
  const pct = budget > 0 ? (breakdown.total / budget) * 100 : 0;
  const heading = tier === 'exhausted'
    ? '## Monthly budget exhausted'
    : '## Monthly budget warning';
  const disclaimer = tier === 'exhausted'
    ? '\n**dev-agent will continue running; this is alert-only. Pause manually if needed.**\n'
    : '';

  const phaseRows = Object.entries(breakdown.byPhase)
    .sort(([, a], [, b]) => b - a)
    .map(([phase, cost]) => {
      const runs = breakdown.topFeatures.reduce((n, f) => n + (f.phases[phase] ?? 0), 0);
      return `${phase} | ${runs} | $${cost.toFixed(2)}`;
    });

  const featureRows = breakdown.topFeatures.map((f, i) => {
    const phasesSummary = Object.entries(f.phases)
      .map(([p, n]) => `${p}(×${n})`)
      .join(', ');
    return `| ${i + 1} | #${f.issue} ${f.title} | ${phasesSummary} | $${f.cost.toFixed(2)} |`;
  });

  return [
    heading,
    '',
    tier === 'exhausted'
      ? 'Month-to-date dev-agent spend has exceeded the monthly budget.'
      : 'Month-to-date dev-agent spend has crossed the warning threshold.',
    disclaimer,
    `- **MTD spend:** $${breakdown.total.toFixed(2)} (${pct.toFixed(1)}% of $${budget.toFixed(2)} budget)`,
    `- **Threshold:** ${threshold}%`,
    `- **Month:** ${monthLabel}`,
    '',
    '### Top 5 most expensive features this month',
    '',
    '| # | Issue | Phases | Cost |',
    '|---|---|---|---|',
    ...featureRows,
    '',
    '### Breakdown by phase',
    '',
    '| Phase | Runs | Cost |',
    '|---|---|---|',
    ...phaseRows,
    '',
    'To adjust the budget, edit `.dev-agent.yml` → `cost_caps.monthly_budget_usd`.',
  ].join('\n');
}
