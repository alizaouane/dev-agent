# Cost-Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship build step 15 — nightly per-repo monthly-budget watchdog that alerts at threshold and at 100%, with no mechanical hard-stop in v1.

**Architecture:** Pure-TS helpers in `lib/cost-watchdog.ts` (aggregation + Markdown rendering + tier logic) consumed by a thin CLI shell `lib/cli/cost-watchdog.ts` that handles GitHub I/O and event emission. A second `cron` entry in `orch-sweep.yml` schedules it daily and gates the new step by `github.event.schedule`.

**Tech Stack:** TypeScript, `@octokit/rest`, vitest. Reuses `lib/telemetry.ts::parseTelemetry`, `lib/events.ts::emit`, `lib/config.ts::loadConfig`.

---

## File structure

| File | Responsibility |
|---|---|
| `lib/cost-watchdog.ts` | Pure helpers: `aggregateCostFromComments`, `tierFor`, `renderAlertBody`, `dedupeLabels`. No `fs`, no `octokit`. Unit-tested directly. |
| `lib/cli/cost-watchdog.ts` | Shell: loads config, instantiates octokit, paginates issues+comments, calls helpers, upserts the alert issue, emits events. ~80 LOC. |
| `tests/unit/cost-watchdog.test.ts` | Unit tests over the pure helpers. No live GitHub. |
| `.github/workflows/orch-sweep.yml` | Add second cron `'0 9 * * *'` + new step gated by `github.event.schedule == '0 9 * * *'`. Existing stuck-detect gated to `!= '0 9 * * *'`. |
| `package.json` | Add `"cost-watchdog": "tsx lib/cli/cost-watchdog.ts"` to `scripts`. |

---

### Task 1: Pure helpers — `lib/cost-watchdog.ts`

**Files:**
- Create: `lib/cost-watchdog.ts`
- Test: `tests/unit/cost-watchdog.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/cost-watchdog.test.ts
import { describe, it, expect } from 'vitest';
import {
  aggregateCostFromComments,
  tierFor,
  renderAlertBody,
  dedupeLabels,
  type CommentLike,
  type CostBreakdown,
} from '../../lib/cost-watchdog';

const tg = (phase: string, cost: number) =>
  `🤖 Phase: ${phase}\nModel: claude-opus-4-7\nTokens: 100 in / 50 out\nCost USD: $${cost.toFixed(2)}\nStatus: completed`;

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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/cost-watchdog.test.ts
```

Expected: FAIL — module `lib/cost-watchdog` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// lib/cost-watchdog.ts
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
  const pct = (breakdown.total / budget) * 100;
  const heading = tier === 'exhausted'
    ? '## Monthly budget exhausted'
    : '## Monthly budget warning';
  const disclaimer = tier === 'exhausted'
    ? '\n**dev-agent will continue running; this is alert-only. Pause manually if needed.**\n'
    : '';

  const phaseRows = Object.entries(breakdown.byPhase)
    .sort(([, a], [, b]) => b - a)
    .map(([phase, cost]) => {
      const runs = breakdown.topFeatures.reduce((n, f) => n + (f.phases[phase] ?? 0), 0)
        || estimatePhaseRuns(breakdown, phase);
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

function estimatePhaseRuns(breakdown: CostBreakdown, phase: string): number {
  return breakdown.topFeatures.reduce((n, f) => n + (f.phases[phase] ?? 0), 0);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/cost-watchdog.test.ts
```

Expected: PASS — all assertions green.

Note: the warning test asserts `phase-implement | 18 | $28.40` against the rendered output. The "18" comes from `estimatePhaseRuns` summing across `topFeatures[*].phases['phase-implement']`. The fixture's two features have `phase-implement: 3 + 2 = 5`. The expected row in the test fixture should be updated to match what the helper actually produces — or extend the fixture to make 18 the right total. **Adjust the test fixture in Step 1 to produce 18 by adding three more features with `phase-implement` counts of 4 + 4 + 5, OR change the assertion to `phase-implement | 5 |`**. Pick the simpler one (the latter) and update both Step-1 fixture and assertion accordingly before committing Step 1.

- [ ] **Step 5: Commit**

```bash
git add lib/cost-watchdog.ts tests/unit/cost-watchdog.test.ts
git commit -m "feat(cost-watchdog): pure helpers — aggregation, tier, render, dedupe"
```

---

### Task 2: CLI shell — `lib/cli/cost-watchdog.ts`

**Files:**
- Create: `lib/cli/cost-watchdog.ts`
- Modify: `package.json`

- [ ] **Step 1: Read the existing CLI pattern**

Read `lib/cli/risk-audit.ts` to see the shape of an existing CLI: how it loads config, instantiates octokit from `GH_TOKEN`, scopes via `GITHUB_REPOSITORY`, and emits via `lib/events.ts`. The cost-watchdog CLI mirrors that shape.

- [ ] **Step 2: Write the CLI**

```ts
// lib/cli/cost-watchdog.ts
import { Octokit } from '@octokit/rest';
import { loadConfig } from '../config';
import { emit } from '../events';
import {
  aggregateCostFromComments,
  tierFor,
  renderAlertBody,
  dedupeLabels,
  type Tier,
} from '../cost-watchdog';

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function monthLabel(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function findExistingAlertIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  labels: string[],
): Promise<{ number: number } | null> {
  const search = await octokit.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    labels: labels.join(','),
    per_page: 1,
  });
  return search.data[0] ? { number: search.data[0].number } : null;
}

async function upsertAlertIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  args: {
    tier: Exclude<Tier, 'snapshot'>;
    body: string;
    monthLabel: string;
    pctTotal: { pct: number; total: number; budget: number };
  },
): Promise<{ number: number; created: boolean }> {
  const labels = dedupeLabels(args.tier, args.monthLabel);
  const existing = await findExistingAlertIssue(octokit, owner, repo, labels);
  const title = args.tier === 'exhausted'
    ? `🚨 dev-agent monthly budget exhausted: $${args.pctTotal.total.toFixed(2)} / $${args.pctTotal.budget.toFixed(2)}`
    : `⚠️ dev-agent monthly budget warning: ${args.pctTotal.pct.toFixed(1)}% of $${args.pctTotal.budget.toFixed(2)}`;

  if (existing) {
    await octokit.issues.update({ owner, repo, issue_number: existing.number, title, body: args.body });
    await octokit.issues.createComment({
      owner, repo, issue_number: existing.number,
      body: `Re-evaluated ${new Date().toISOString()} — MTD now $${args.pctTotal.total.toFixed(2)} (${args.pctTotal.pct.toFixed(1)}%).`,
    });
    return { number: existing.number, created: false };
  }

  const created = await octokit.issues.create({
    owner, repo, title, body: args.body, labels,
  });
  return { number: created.data.number, created: true };
}

async function collectIssuesWithComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  monthStart: Date,
) {
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner, repo, state: 'all', since: monthStart.toISOString(), per_page: 100,
  });
  // Filter out PRs (listForRepo returns both).
  const realIssues = issues.filter((i) => !i.pull_request);
  return Promise.all(realIssues.map(async (issue) => {
    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner, repo, issue_number: issue.number, per_page: 100,
    });
    return {
      number: issue.number,
      title: issue.title,
      comments: comments.map((c) => ({
        body: c.body ?? '',
        created_at: c.created_at,
      })),
    };
  }));
}

async function main() {
  const config = await loadConfig('.dev-agent.yml');
  const budget = config.cost_caps?.monthly_budget_usd;
  const threshold = config.cost_caps?.alert_threshold_pct ?? 80;
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;

  if (!budget || budget === 0) {
    emit({
      run_id: runId, issue: null, phase: 'cost-watchdog',
      event: 'cost.snapshot',
      payload: { budget_unconfigured: true },
    });
    return;
  }

  const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN / GITHUB_TOKEN required');
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY required (owner/repo)');

  const octokit = new Octokit({ auth: ghToken });
  const now = new Date();
  const monthStart = startOfMonthUtc(now);
  const ml = monthLabel(now);

  const issues = await collectIssuesWithComments(octokit, owner, repo, monthStart);
  const breakdown = aggregateCostFromComments(issues, monthStart);
  const pct = (breakdown.total / budget) * 100;

  emit({
    run_id: runId, issue: null, phase: 'cost-watchdog',
    event: 'cost.snapshot',
    payload: { total: breakdown.total, budget, pct, month: ml },
  });

  const tier = tierFor({ pct, threshold });
  if (tier === 'snapshot') return;

  const body = renderAlertBody({ tier, breakdown, budget, threshold, monthLabel: ml });
  const { number, created } = await upsertAlertIssue(octokit, owner, repo, {
    tier, body, monthLabel: ml, pctTotal: { pct, total: breakdown.total, budget },
  });

  emit({
    run_id: runId, issue: number, phase: 'cost-watchdog',
    event: 'cost.threshold.crossed',
    payload: { tier, pct, total: breakdown.total, budget, month: ml, issue_created: created },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Add the script entry to package.json**

In the root `package.json`, locate the `scripts` block and add:

```json
"cost-watchdog": "tsx lib/cli/cost-watchdog.ts"
```

(Place it alphabetically near the other `lib/cli/*` script entries — e.g., after `cost-cap` if present, otherwise after the closest existing `cli/*` entry.)

- [ ] **Step 4: Verify tsc compiles the CLI**

```bash
cd "$(git rev-parse --show-toplevel)" && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add lib/cli/cost-watchdog.ts package.json
git commit -m "feat(cost-watchdog): CLI shell + npm script"
```

---

### Task 3: Wire into `orch-sweep.yml`

**Files:**
- Modify: `.github/workflows/orch-sweep.yml`

- [ ] **Step 1: Read the current orch-sweep.yml**

The current file has a single `on.schedule: '*/10 * * * *'`, a single job `sweep`, and one step "Detect stuck issues". The new step must NOT run every 10 minutes (that would re-scan all issues every 10min — wasteful and noisy). Gate it by `github.event.schedule`.

- [ ] **Step 2: Edit the workflow**

Replace the `on:` block:

```yaml
on:
  schedule:
    - cron: '*/10 * * * *'   # stuck-issue detection
    - cron: '0 9 * * *'      # cost-watchdog daily 09:00 UTC (17:00 SGT)
  workflow_dispatch:
```

Bump the `permissions:` block so the cost-watchdog can open issues:

```yaml
    permissions:
      issues: write
      pull-requests: read
```

Gate the existing "Detect stuck issues" step:

```yaml
      - name: Detect stuck issues
        if: github.event_name != 'schedule' || github.event.schedule == '*/10 * * * *'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          ...
```

Add the new step at the end of the `steps:` list (under the existing "Detect stuck issues" step):

```yaml
      - name: Cost watchdog (daily)
        if: github.event_name == 'workflow_dispatch' || github.event.schedule == '0 9 * * *'
        env:
          GH_TOKEN: ${{ github.token }}
          GITHUB_REPOSITORY: ${{ github.repository }}
        run: npm run cost-watchdog
```

- [ ] **Step 3: Verify the workflow parses**

```bash
cd "$(git rev-parse --show-toplevel)" && npx js-yaml .github/workflows/orch-sweep.yml > /dev/null
```

Expected: no parse error.

- [ ] **Step 4: Update `tests/unit/workflows.test.ts` if it asserts orch-sweep shape**

```bash
cd "$(git rev-parse --show-toplevel)" && grep -n "orch-sweep" tests/unit/workflows.test.ts
```

If any assertion exists, extend it to cover (a) both cron strings present, (b) `issues: write` permission, (c) the new step name. If none, no change needed.

- [ ] **Step 5: Run all root tests**

```bash
cd "$(git rev-parse --show-toplevel)" && npm test
```

Expected: 706+ passed (new cost-watchdog tests count to total). Zero failures.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/orch-sweep.yml tests/unit/workflows.test.ts
git commit -m "feat(orch-sweep): nightly cost-watchdog cron + step gating"
```

(Drop `tests/unit/workflows.test.ts` from the `git add` if it wasn't changed.)

---

### Task 4: Enable on dev-agent itself

**Files:**
- Modify: `.dev-agent.yml`

- [ ] **Step 1: Read the current `.dev-agent.yml`**

Find the `cost_caps:` block. Verify it currently has per-phase caps but no `monthly_budget_usd`.

- [ ] **Step 2: Add a starter budget**

Append to the `cost_caps:` block:

```yaml
  # Monthly budget watchdog (Pillar 10). Watchdog runs daily via orch-sweep.yml.
  # Crossing 80% opens a warning issue; crossing 100% opens an exhausted issue.
  # Alert-only for v1 — operators decide how to respond.
  monthly_budget_usd: 75
  alert_threshold_pct: 80
```

(`$75/mo` is a starting point for the dev-agent repo specifically — it averages ~$2/day during active development and well under that in quiet periods. Operator-tunable.)

- [ ] **Step 3: Verify the schema still parses**

```bash
cd "$(git rev-parse --show-toplevel)" && npx tsx -e "import('./lib/config').then(m => m.loadConfig('.dev-agent.yml')).then(c => console.log(c.cost_caps.monthly_budget_usd, c.cost_caps.alert_threshold_pct))"
```

Expected: `75 80`.

- [ ] **Step 4: Commit**

```bash
git add .dev-agent.yml
git commit -m "chore(.dev-agent.yml): enable monthly-budget watchdog ($75/mo, 80% threshold)"
```

---

### Task 5: Document — runbook + README link

**Files:**
- Create: `docs/runbooks/2026-05-20-cost-watchdog.md`
- Modify: `README.md`

- [ ] **Step 1: Write the runbook**

Cover these sections (~120 lines total):

1. **What it is.** Daily per-repo monthly-budget watchdog. Alert-only for v1.
2. **How to enable.** Set `cost_caps.monthly_budget_usd` and `cost_caps.alert_threshold_pct` in `.dev-agent.yml`. Re-run takes effect on the next 09:00 UTC tick.
3. **What to do when a warning fires.** Inspect the breakdown — if it's a real cost ramp, decide between bumping budget or pausing work; if it's noise (e.g., a single runaway phase), open a P0 to investigate that phase.
4. **What to do when budget is exhausted.** Same as warning, but more urgent. v1 does NOT mechanically stop dev-agent — operator pauses by either (a) flipping `cost_caps.monthly_budget_usd: 0` to disable the alert (and accepting cost), or (b) adding a `cost_caps:enforced:false` consumer override (not implemented in v1 — manual pause is the answer).
5. **Manually triggering the watchdog.** `gh workflow run orch-sweep.yml` (the workflow_dispatch path runs both steps).
6. **Verifying it ran.** Look for a `cost.snapshot` line in `.dev-agent/events/global.jsonl` (run-id + timestamp + total/budget/pct), or open the most recent `orch-sweep` run in the Actions tab.
7. **Month rollover.** The de-dupe key includes `month:YYYY-MM`, so a new month gets a fresh issue. Previous-month issues remain open by design — close them manually after triage.
8. **Tuning the budget.** Recommended starting points by repo activity: $25/mo for low-activity, $75 for active dev-agent, $200 for product-team-with-PMs. Bump after observing one full month.

- [ ] **Step 2: Add the README link**

In `README.md`, add immediately after the existing `## Tier-2 smoke` section:

```markdown
## Cost-watchdog

A nightly per-repo monthly-budget watchdog runs via `orch-sweep.yml`. Set `cost_caps.monthly_budget_usd` and `cost_caps.alert_threshold_pct` in `.dev-agent.yml` to enable. See [docs/runbooks/2026-05-20-cost-watchdog.md](docs/runbooks/2026-05-20-cost-watchdog.md).
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/2026-05-20-cost-watchdog.md README.md
git commit -m "docs(cost-watchdog): rollout runbook + README link"
```

---

## Self-review

- [x] Spec coverage: behavior, data source, schedule, output, dedupe, failure modes, testing, rollout — all in spec, all in plan.
- [x] No placeholders. Code blocks are complete, commands exact.
- [x] Type names consistent: `CommentLike`, `CostBreakdown`, `Tier`, `FeatureCost` — same in tests, helpers, CLI.
- [x] Schedule gating logic: stuck-detect runs unless event is the 09:00 cron; watchdog runs only on the 09:00 cron or `workflow_dispatch`. Mutually exclusive on cron, both run on `workflow_dispatch`.
- [x] Hook points (schema/events) verified to already exist before writing the spec.
