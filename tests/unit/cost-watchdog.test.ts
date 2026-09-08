import { describe, it, expect } from 'vitest';
import {
  aggregateCostFromComments,
  budgetGateDecision,
  tierFor,
  renderAlertBody,
  dedupeLabels,
  type CommentLike,
  type CostBreakdown,
} from '../../lib/cost-watchdog';

const tg = (phase: string, cost: number) =>
  `🤖 Phase: ${phase}\nModel: claude-opus-4-7\nTokens: 100 in / 50 out\nCost: $${cost.toFixed(2)}\nStatus: completed`;

describe('aggregateCostFromComments', () => {
  it('sums cost_usd across telemetry comments, ignores non-telemetry', () => {
    const issues: { number: number; title: string; comments: CommentLike[] }[] = [
      {
        number: 128,
        title: 'user-profile-redesign',
        comments: [
          { body: tg('phase-implement', 5.20), created_at: '2026-05-10T10:00:00Z' },
          { body: tg('phase-staging-deploy', 6.20), created_at: '2026-05-10T11:00:00Z' },
          { body: 'random user comment', created_at: '2026-05-10T12:00:00Z' },
        ],
      },
      {
        number: 131,
        title: 'invoice-pdf-export',
        comments: [
          { body: tg('phase-implement', 8.20), created_at: '2026-05-11T09:00:00Z' },
        ],
      },
    ];
    const breakdown = aggregateCostFromComments(issues, new Date('2026-05-01T00:00:00Z'));
    expect(breakdown.total).toBeCloseTo(19.60, 2);
    expect(breakdown.byPhase['phase-implement']).toBeCloseTo(13.40, 2);
    expect(breakdown.byPhase['phase-staging-deploy']).toBeCloseTo(6.20, 2);
    expect(breakdown.byPhaseRuns['phase-implement']).toBe(2);
    expect(breakdown.byPhaseRuns['phase-staging-deploy']).toBe(1);
    expect(breakdown.topFeatures[0].issue).toBe(128);
    expect(breakdown.topFeatures[0].cost).toBeCloseTo(11.40, 2);
  });

  it('filters out comments older than monthStart', () => {
    const issues = [{
      number: 1, title: 'old', comments: [
        { body: tg('phase-implement', 100), created_at: '2026-04-30T23:59:00Z' },
        { body: tg('phase-implement', 5), created_at: '2026-05-01T00:01:00Z' },
      ],
    }];
    const breakdown = aggregateCostFromComments(issues, new Date('2026-05-01T00:00:00Z'));
    expect(breakdown.total).toBeCloseTo(5, 2);
  });

  it('skips comments where parseTelemetry returns null', () => {
    const issues = [{
      number: 1, title: 'x', comments: [
        { body: '🤖 Phase: phase-implement\n(missing fields)', created_at: '2026-05-10T10:00:00Z' },
      ],
    }];
    const breakdown = aggregateCostFromComments(issues, new Date('2026-05-01T00:00:00Z'));
    expect(breakdown.total).toBe(0);
  });

  it('skips comments with non-finite, negative, or implausibly-large cost_usd', () => {
    const issues = [{
      number: 1, title: 'x', comments: [
        // parseTelemetry accepts numeric strings; cap-evasion attempts with
        // NaN/Infinity/negative/implausibly-large values must not be summed.
        { body: `🤖 Phase: phase-implement\nModel: claude-opus-4-7\nTokens: 1 in / 1 out\nCost: $NaN\nStatus: completed`, created_at: '2026-05-10T10:00:00Z' },
        { body: `🤖 Phase: phase-implement\nModel: claude-opus-4-7\nTokens: 1 in / 1 out\nCost: $Infinity\nStatus: completed`, created_at: '2026-05-10T10:00:00Z' },
        { body: `🤖 Phase: phase-implement\nModel: claude-opus-4-7\nTokens: 1 in / 1 out\nCost: $-50\nStatus: completed`, created_at: '2026-05-10T10:00:00Z' },
        // Forged-looking absurd value — must be dropped (forged telemetry
        // could otherwise inflate MTD into a false `budget-exhausted`).
        { body: `🤖 Phase: phase-implement\nModel: claude-opus-4-7\nTokens: 1 in / 1 out\nCost: $9999999\nStatus: completed`, created_at: '2026-05-10T10:00:00Z' },
        { body: tg('phase-implement', 1.50), created_at: '2026-05-10T10:00:00Z' },
      ],
    }];
    const breakdown = aggregateCostFromComments(issues, new Date('2026-05-01T00:00:00Z'));
    expect(breakdown.total).toBeCloseTo(1.50, 2);
    expect(breakdown.byPhaseRuns['phase-implement']).toBe(1);
  });
});

describe('tierFor', () => {
  it('returns snapshot below threshold', () => {
    expect(tierFor({ pct: 50, threshold: 80 })).toBe('snapshot');
  });
  it('returns warning at threshold', () => {
    expect(tierFor({ pct: 80, threshold: 80 })).toBe('warning');
  });
  it('returns warning between threshold and 100', () => {
    expect(tierFor({ pct: 95, threshold: 80 })).toBe('warning');
  });
  it('returns exhausted at 100', () => {
    expect(tierFor({ pct: 100, threshold: 80 })).toBe('exhausted');
  });
  it('returns exhausted above 100', () => {
    expect(tierFor({ pct: 142, threshold: 80 })).toBe('exhausted');
  });
});

describe('renderAlertBody', () => {
  const breakdown: CostBreakdown = {
    total: 42.30,
    byPhase: { 'phase-implement': 28.40, 'phase-swarm-review': 9.80, 'phase-acm': 2.60, 'phase-evidence-collector': 1.50 },
    // Run counts reflect ALL issues, not just topFeatures — the alert table
    // and topFeatures are computed independently so they can diverge here.
    byPhaseRuns: { 'phase-implement': 18, 'phase-swarm-review': 11, 'phase-acm': 14, 'phase-evidence-collector': 9 },
    topFeatures: [
      { issue: 128, title: 'user-profile-redesign', cost: 11.40, phases: { 'phase-implement': 3, 'phase-staging-deploy': 1 } },
      { issue: 131, title: 'invoice-pdf-export', cost: 8.20, phases: { 'phase-implement': 2, 'phase-swarm-review': 1 } },
    ],
  };

  it('renders the warning body with budget, pct, and tables', () => {
    const body = renderAlertBody({
      tier: 'warning', breakdown, budget: 50, threshold: 80, monthLabel: '2026-05',
    });
    expect(body).toMatch(/Monthly budget warning/);
    expect(body).toMatch(/\$42\.30 \(84\.6% of \$50\.00 budget\)/);
    expect(body).toMatch(/#128 user-profile-redesign/);
    expect(body).toMatch(/phase-implement \| 18 \| \$28\.40/);
    expect(body).not.toMatch(/exhausted/i);
  });

  it('renders the exhausted body with the alert-only disclaimer', () => {
    const body = renderAlertBody({
      tier: 'exhausted',
      breakdown: { ...breakdown, total: 52.10 },
      budget: 50, threshold: 80, monthLabel: '2026-05',
    });
    expect(body).toMatch(/exhausted/i);
    expect(body).toMatch(/alert-only/i);
    expect(body).toMatch(/\$52\.10/);
  });
});

describe('dedupeLabels', () => {
  it('returns the right label set per tier and month', () => {
    expect(dedupeLabels('warning', '2026-05')).toEqual(['cost-watchdog', 'budget-warning', 'month:2026-05']);
    expect(dedupeLabels('exhausted', '2026-05')).toEqual(['cost-watchdog', 'budget-exhausted', 'month:2026-05']);
  });
});

describe('budgetGateDecision', () => {
  // §22.1: the nightly watchdog reports spend that has already happened, which
  // is monitoring. These cases are the control half — refusing the run.

  it('allows a run comfortably inside the budget', () => {
    const d = budgetGateDecision({ spentUsd: 10, budgetUsd: 75, phaseCostUsd: 5 });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('within-budget');
  });

  it('refuses once spend has reached the budget', () => {
    const d = budgetGateDecision({ spentUsd: 75, budgetUsd: 75, phaseCostUsd: 5 });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('exhausted');
  });

  it('refuses a phase whose projected cost would cross the budget', () => {
    // The case alert-only monitoring cannot catch: $2 of headroom against a
    // $5 phase is an overshoot that is only visible afterwards.
    const d = budgetGateDecision({ spentUsd: 73, budgetUsd: 75, phaseCostUsd: 5 });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('would-exceed');
  });

  it('allows a phase that exactly fits the remaining budget', () => {
    const d = budgetGateDecision({ spentUsd: 70, budgetUsd: 75, phaseCostUsd: 5 });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('within-budget');
  });

  it('stays out of the way when no budget is configured', () => {
    const d = budgetGateDecision({ spentUsd: 500, budgetUsd: 0 });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('no-budget-configured');
    expect(d.message).toMatch(/no cost_caps\.monthly_budget_usd/i);
  });

  it('records an operator override rather than hiding it', () => {
    const d = budgetGateDecision({ spentUsd: 200, budgetUsd: 75, override: true });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('override');
    expect(d.message).toMatch(/operator authorised/i);
  });

  it('treats missing or nonsensical spend as zero rather than failing open', () => {
    const d = budgetGateDecision({ spentUsd: Number.NaN, budgetUsd: 75, phaseCostUsd: 5 });
    expect(d.allow).toBe(true);
    expect(d.spentUsd).toBe(0);
  });

  it('ignores a negative phase cost instead of crediting the budget', () => {
    const d = budgetGateDecision({ spentUsd: 74, budgetUsd: 75, phaseCostUsd: -100 });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('within-budget');
  });

  it('reports percentage spent for the operator message', () => {
    const d = budgetGateDecision({ spentUsd: 60, budgetUsd: 75 });
    expect(Math.round(d.pct)).toBe(80);
  });
});
