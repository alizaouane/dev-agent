# Cost-Watchdog (Pillar 10, Build Step 15) — Design

**Date:** 2026-05-20
**Status:** Approved — ready for implementation plan
**Scope:** `lib/cli/cost-watchdog.ts` + `orch-sweep.yml` extension + unit tests. No phase-workflow changes.

---

## Context

Build step 15 of the industry-grade-verification initiative calls for a **nightly cost watchdog** that reads each repo's `.dev-agent.yml` `cost_caps.monthly_budget_usd` and surfaces an alert when month-to-date spend crosses the configured `alert_threshold_pct` or 100%.

The hook points already exist in the codebase:

- `lib/schema.ts:103-122` defines `cost_caps.monthly_budget_usd` and `cost_caps.alert_threshold_pct`, with a comment pointing at `lib/cli/cost-watchdog.ts`.
- `lib/events.ts:38-42` lists `cost.threshold.crossed` as a conventional event verb, and `phase: 'cost-watchdog'` as a conventional phase name.
- `lib/telemetry.ts:22-30` defines `TelemetryPayload.cost_usd` and `parseTelemetry()` already returns it. Every dev-agent phase posts one telemetry comment per run.

Nothing in the codebase consumes those fields yet. This spec wires them up.

## Goal

Surface budget overruns the same business day they happen, without blocking work programmatically — operator decides whether to bump the budget, pause work, or override. Hard mechanical stop is **explicitly deferred** to v1.1.

## Non-goals

- Mechanical hard-stop (no repo label, no flag file, no orchestrator gate).
- Per-feature cost caps (those already exist via `lib/cost-cap.ts` `CostCapTracker`).
- Forecasting / projection ("at current rate you'll hit 100% in 3 days") — month-to-date snapshot is enough for v1.
- Cross-repo aggregation. Each repo runs its own watchdog scoped to itself.

## Behavior

**When it runs.** Daily at 09:00 UTC (= 17:00 SGT, start of business day). Added as a second `cron` entry in the existing `orch-sweep.yml` workflow. The existing every-10-minute stuck-issue sweep keeps running on `*/10 * * * *`; the watchdog step is gated by `github.event.schedule == '0 9 * * *'`.

**Where the cost data comes from.** GitHub issue comments. Every dev-agent phase posts one telemetry comment of the form:

```
🤖 Phase: phase-implement
Model: claude-opus-4-7
Tokens: 12500 in / 4200 out
Cost: $0.84
Status: completed
```

The watchdog paginates `octokit.issues.listForRepo` for issues `updated >= <start-of-month>`, then for each issue paginates `listComments`, runs `parseTelemetry()` on each body, and sums `cost_usd` from any comment whose `created_at` is also `>= start-of-month`. (The issue may have been opened months ago but had a phase run this month — filter by **comment date**, not issue date.)

**What it does with the sum.**

| Condition | Action |
|---|---|
| `sum < alert_threshold_pct%` of budget | Emit a `cost.snapshot` event. No issue. |
| `alert_threshold_pct% ≤ sum < 100%` | Open or update one warning issue (label `cost-watchdog` + `budget-warning`). Emit `cost.threshold.crossed` event with `tier: "warning"`. |
| `sum ≥ 100%` of budget | Open or update one exhausted issue (label `cost-watchdog` + `budget-exhausted`). Emit `cost.threshold.crossed` event with `tier: "exhausted"`. |

**De-duplication.** The watchdog searches for an open issue with the relevant label combo before opening a new one. If found, it edits the issue body in-place with the latest figures and posts a follow-up comment ("MTD now $52.10 / $50.00 — up from $48.30 yesterday"). At month rollover, the new month gets a new issue (label-search includes `cost-watchdog` AND a `month:YYYY-MM` label so prior months don't get re-edited).

**Skip cases.** If `monthly_budget_usd` is `undefined` or `0` in the loaded config, the watchdog exits 0 with a single `cost.snapshot` event noting `budget_unconfigured: true`. No alert. Same for `alert_threshold_pct` undefined → default to `80`.

## Output

### Warning issue body

```markdown
## Monthly budget warning

Month-to-date dev-agent spend has crossed the warning threshold.

- **MTD spend:** $42.30 (84.6% of $50.00 budget)
- **Threshold:** 80%
- **Month:** 2026-05

### Top 5 most expensive features this month

| # | Issue | Phases | Cost |
|---|---|---|---|
| 1 | #128 user-profile-redesign | implement(×3), staging-deploy | $11.40 |
| 2 | #131 invoice-pdf-export | implement(×2), swarm-review | $8.20 |
| ... |

### Breakdown by phase

| Phase | Runs | Cost |
|---|---|---|
| phase-implement | 18 | $28.40 |
| phase-swarm-review | 11 | $9.80 |
| phase-acm | 14 | $2.60 |
| phase-evidence-collector | 9 | $1.50 |

To adjust the budget, edit `.dev-agent.yml` → `cost_caps.monthly_budget_usd`.
```

### Exhausted issue

Same shape, title `🚨 dev-agent monthly budget exhausted: $52.10 / $50.00`, body header changed to "exhausted" and a one-line "**dev-agent will continue running; this is alert-only. Pause manually if needed.**"

## CLI shape

`lib/cli/cost-watchdog.ts`:

```ts
async function main() {
  const config = await loadConfig('.dev-agent.yml');
  const budget = config.cost_caps?.monthly_budget_usd;
  const threshold = config.cost_caps?.alert_threshold_pct ?? 80;
  if (!budget) { emit({ event: 'cost.snapshot', payload: { budget_unconfigured: true } }); return; }

  const octokit = makeOctokitFromGhToken();
  const { owner, repo } = parseRepoFromEnv();          // GITHUB_REPOSITORY
  const monthStart = startOfMonthUtc(new Date());

  const breakdown = await collectMonthToDateCost(octokit, owner, repo, monthStart);
  const pct = (breakdown.total / budget) * 100;

  emit({ event: 'cost.snapshot', payload: { total: breakdown.total, budget, pct } });

  if (pct < threshold) return;
  const tier = pct >= 100 ? 'exhausted' : 'warning';
  await upsertAlertIssue(octokit, owner, repo, { breakdown, budget, pct, tier });
  emit({ event: 'cost.threshold.crossed', payload: { tier, pct, total: breakdown.total } });
}
```

`collectMonthToDateCost` and `upsertAlertIssue` are exported as pure-data functions so they can be unit-tested without `octokit`.

## Files

| File | Change |
|---|---|
| `lib/cli/cost-watchdog.ts` | new — CLI |
| `lib/cost-watchdog.ts` | new — pure-TS helpers (cost aggregation, issue-body rendering, threshold logic). The CLI is a thin shell over this. |
| `.github/workflows/orch-sweep.yml` | add second cron + new watchdog step gated by `github.event.schedule` |
| `tests/unit/cost-watchdog.test.ts` | new — covers cost aggregation, threshold tiers, issue body rendering, de-dupe key, budget-unconfigured skip |
| `package.json` | add `"cost-watchdog": "tsx lib/cli/cost-watchdog.ts"` to scripts |

No changes to `lib/schema.ts` (fields already exist), `lib/events.ts` (event verb already conventional), or any `phase-*.yml`.

## Failure modes

- **GitHub API rate limits:** Pagination uses `octokit.paginate` (auto-backoff). Worst case: a 5000-issue repo with 100 comments each = 500k requests, but a monthly query window keeps real volume to <100 issues × <30 comments. Falls inside the 5000/hr authenticated limit.
- **Partial telemetry:** A phase that crashed before posting telemetry contributes $0 to the sum. The watchdog under-reports rather than failing.
- **Clock skew at month rollover:** Cost is bucketed by comment `created_at` (server-assigned UTC), so the boundary is consistent across the consumer repo and the watchdog runner.
- **Multiple watchdog runs in the same day:** The de-dupe (one issue per month per tier) makes repeat runs idempotent — same-day re-runs just update the existing issue.

## Testing

Unit tests live entirely on the pure-TS helpers:

1. `aggregateCostFromComments` sums correctly across multiple issues, ignores non-telemetry comments, filters by comment date.
2. `tierFor({ pct, threshold })` returns `'snapshot' | 'warning' | 'exhausted'` correctly at boundaries.
3. `renderAlertBody` matches a frozen Markdown snapshot for both warning and exhausted tiers.
4. `dedupeKey(month, tier)` is stable across runs.
5. Budget-unconfigured exits with `cost.snapshot` event and no issue.

No live-GitHub test. The CLI shell layer is small enough to lean on existing CLI patterns (`acm-extract.ts` / `risk-audit.ts`) for I/O wiring.

## Rollout

The watchdog is opt-in via `cost_caps.monthly_budget_usd`. Repos that don't set it get a no-op event and nothing else. Day-one rollout = `dev-agent` itself (set a budget in `.dev-agent.yml` after merge). No template change needed — `web-app-template/.dev-agent.yml` can adopt it independently later.
