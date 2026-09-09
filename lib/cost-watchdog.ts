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
  byPhaseRuns: Record<string, number>;
  topFeatures: FeatureCost[];
}

export type Tier = 'snapshot' | 'warning' | 'exhausted';

// Defense against forged telemetry: any single comment claiming more than
// $1000 is implausible for any v1 phase (the highest configured per-phase
// cap is $5) and would inflate MTD totals into false-positive alerts.
// Real outliers above the cap signal an upstream bug to investigate;
// dropping them is the safer default for the alert path.
export const MAX_COST_PER_COMMENT_USD = 1000;

export function aggregateCostFromComments(
  issues: { number: number; title: string; comments: CommentLike[] }[],
  monthStart: Date,
): CostBreakdown {
  const byPhase: Record<string, number> = {};
  const byPhaseRuns: Record<string, number> = {};
  const perIssue = new Map<number, FeatureCost>();

  for (const issue of issues) {
    for (const c of issue.comments) {
      if (new Date(c.created_at) < monthStart) continue;
      const t = parseTelemetry(c.body);
      if (!t || !Number.isFinite(t.cost_usd) || t.cost_usd < 0 || t.cost_usd > MAX_COST_PER_COMMENT_USD) continue;
      byPhase[t.phase] = (byPhase[t.phase] ?? 0) + t.cost_usd;
      byPhaseRuns[t.phase] = (byPhaseRuns[t.phase] ?? 0) + 1;
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
  return { total, byPhase, byPhaseRuns, topFeatures };
}

export function tierFor(input: { pct: number; threshold: number }): Tier {
  if (input.pct >= 100) return 'exhausted';
  if (input.pct >= input.threshold) return 'warning';
  return 'snapshot';
}

/** Why a budget gate allowed or refused a phase run. */
export type BudgetGateReason =
  | 'no-budget-configured'
  | 'within-budget'
  | 'would-exceed'
  | 'exhausted'
  | 'override';

/** The decision a pre-flight budget gate reached, and why. */
export interface BudgetGateDecision {
  allow: boolean;
  reason: BudgetGateReason;
  spentUsd: number;
  budgetUsd: number;
  pct: number;
  /** Operator-facing sentence; safe to put straight into a workflow log. */
  message: string;
}

/**
 * Decide whether a phase run may START, given month-to-date spend.
 *
 * This is the pre-flight half of §22.1. The nightly watchdog reports what has
 * already been spent, which is monitoring — by the time it files an issue the
 * money is gone. This refuses the run instead, which is control.
 *
 * The projected cost of the phase about to run is included deliberately: a
 * budget with $2 left should not admit a $5 implement phase and discover the
 * overshoot afterwards.
 *
 * KNOWN BOUND — concurrent admission. Each caller reads month-to-date spend
 * independently, so N phases starting before any of them posts telemetry can
 * each see the same total and each be admitted. The overshoot is bounded by the
 * sum of the concurrent phases' caps (with current defaults, a few dollars
 * against a $50 ceiling), not unbounded — the runaway this gate exists to stop
 * is a cron firing daily for a week, which it does stop. Repos that need a hard
 * ceiling should additionally serialise spending workflows with a shared
 * `concurrency:` group; that is a throughput trade-off, so it is opt-in rather
 * than imposed here.
 *
 * @param input.spentUsd - Month-to-date spend for the repo.
 * @param input.budgetUsd - `cost_caps.monthly_budget_usd`; 0 or absent means
 *   no budget is configured, and the gate stays out of the way.
 * @param input.phaseCostUsd - Configured cap for the phase about to run, used
 *   as its projected cost. Omit when unknown.
 * @param input.override - Set when an operator has explicitly authorised the
 *   run past the cap; recorded in the decision rather than hidden.
 * @returns Whether to proceed, with the reason and an operator-facing message.
 */
export function budgetGateDecision(input: {
  spentUsd: number;
  budgetUsd: number;
  phaseCostUsd?: number;
  override?: boolean;
}): BudgetGateDecision {
  const spentUsd = Number.isFinite(input.spentUsd) && input.spentUsd > 0 ? input.spentUsd : 0;
  const budgetUsd = Number.isFinite(input.budgetUsd) && input.budgetUsd > 0 ? input.budgetUsd : 0;
  const projected = Number.isFinite(input.phaseCostUsd ?? NaN) && (input.phaseCostUsd ?? 0) > 0
    ? (input.phaseCostUsd as number)
    : 0;
  const pct = budgetUsd > 0 ? (spentUsd / budgetUsd) * 100 : 0;
  const base = { spentUsd, budgetUsd, pct };

  if (budgetUsd <= 0) {
    return {
      ...base,
      allow: true,
      reason: 'no-budget-configured',
      message:
        'No cost_caps.monthly_budget_usd configured — the budget gate is inactive. ' +
        'Set one so spend cannot run unbounded (§22.1).',
    };
  }

  if (input.override) {
    return {
      ...base,
      allow: true,
      reason: 'override',
      message:
        `Budget override in effect: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} spent ` +
        `(${pct.toFixed(0)}%). Proceeding because an operator authorised it.`,
    };
  }

  if (spentUsd >= budgetUsd) {
    return {
      ...base,
      allow: false,
      reason: 'exhausted',
      message:
        `Monthly budget exhausted: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} spent ` +
        `(${pct.toFixed(0)}%). Refusing to start this phase. Raise the budget, wait for the ` +
        'month to roll over, or re-run with the override input.',
    };
  }

  if (projected > 0 && spentUsd + projected > budgetUsd) {
    return {
      ...base,
      allow: false,
      reason: 'would-exceed',
      message:
        `This phase would exceed the monthly budget: $${spentUsd.toFixed(2)} spent, ` +
        `$${projected.toFixed(2)} projected, budget $${budgetUsd.toFixed(2)}. Refusing to start ` +
        'it rather than discovering the overshoot afterwards.',
    };
  }

  return {
    ...base,
    allow: true,
    reason: 'within-budget',
    message:
      `Within budget: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} spent (${pct.toFixed(0)}%)` +
      (projected > 0 ? `, $${projected.toFixed(2)} projected for this phase.` : '.'),
  };
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
      const runs = breakdown.byPhaseRuns[phase] ?? 0;
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
