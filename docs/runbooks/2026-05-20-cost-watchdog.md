# Cost-watchdog rollout

**Date:** 2026-05-20
**Applies to:** Repos using `orch-sweep.yml` with a `.dev-agent.yml` (Pillar 10)
**Status:** v1 — alert-only. No mechanical hard-stop.

---

## What it is

A daily per-repo monthly-budget watchdog. It runs at 09:00 UTC (17:00 SGT) as the second cron schedule on `orch-sweep.yml`, alongside the existing every-10-minute stuck-issue detection — the two steps are mutually exclusive on the cron path and both run on `workflow_dispatch`. Each tick sums `cost_usd` from telemetry comments on issues updated this month, compares the total against the repo's configured `cost_caps.monthly_budget_usd`, and either emits a silent snapshot event or opens an alert issue. The alert issue is upserted once per (tier, month) pair: crossing the warning threshold (default 80%) opens a `budget-warning` issue, and crossing 100% opens a separate `budget-exhausted` issue. Subsequent runs in the same month update the same issue body and post a re-evaluation comment rather than spawning duplicates. v1 is alert-only — dev-agent does not mechanically stop running when budget is crossed. Operators triage and decide.

---

## How to enable

Set `cost_caps.monthly_budget_usd` (and optionally `cost_caps.alert_threshold_pct`) in the repo's `.dev-agent.yml`:

```yaml
cost_caps:
  monthly_budget_usd: 75
  alert_threshold_pct: 80
```

The threshold defaults to 80 when omitted. Changes take effect on the next 09:00 UTC tick, or immediately via `workflow_dispatch` (see "Manually triggering" below).

**Missing `.dev-agent.yml` is not an error.** Repos that have `orch-sweep.yml` wired up but no `.dev-agent.yml` at the root will see the watchdog emit a `cost.snapshot` event with `budget_unconfigured: true` and exit 0 — no failure, no alert, no noise. To actually get budget tracking, add the file with at minimum `schema_version: 1` and a `cost_caps.monthly_budget_usd` value. Setting `monthly_budget_usd: 0` (or omitting it) has the same effect as missing config — the snapshot event records the unconfigured state and the watchdog exits without alerting.

---

## What to do when a warning fires

A `⚠️ dev-agent monthly budget warning` issue lands with labels `cost-watchdog`, `budget-warning`, and `month:YYYY-MM`. Open it and look at the two tables in the body:

- **Top 5 most expensive features this month** — the issues with the highest MTD spend, with a per-phase run count for each.
- **Breakdown by phase** — total spend per phase (`phase-implement`, `phase-swarm-review`, `phase-acm`, etc.) with run counts.

Common triggers and the right response:

- **One runaway phase on a single issue.** Usually `phase-implement` on a thrashy feature — the model keeps retrying, each attempt costs real money, and the per-feature row in the table is wildly out of proportion to the rest. Open a P0 on that issue to investigate. Common root causes: a broken test that keeps failing in a way the model can't recover from, an ambiguous spec, or a phase-cap that's too high.
- **Genuine ramp-up.** Every feature row is roughly proportional, the phase mix looks normal, you just shipped more features this month. Bump `monthly_budget_usd` in `.dev-agent.yml` to the new sustainable level.
- **Coincidental burst at month-end.** The warning fires at 80%, not 100% — you have headroom. If the rest of the month is expected to be quiet, the simplest move is to wait and see whether spend actually reaches the budget. If it doesn't, the next month's de-dupe key resets the alert.

---

## What to do when budget is exhausted

A `🚨 dev-agent monthly budget exhausted` issue lands with labels `cost-watchdog`, `budget-exhausted`, and `month:YYYY-MM`. The body includes the same two tables plus an `**alert-only**` disclaimer reminding the operator that dev-agent will continue running. The triage steps are the same as the warning, with more urgency. v1 does NOT mechanically stop dev-agent. To pause spend, the operator has two paths:

- **Flip `cost_caps.monthly_budget_usd: 0` in `.dev-agent.yml`.** This disables the alert (the watchdog treats budget=0 as unconfigured) and accepts the cost. Useful when you've decided to ship through a sprint deadline and don't want a re-evaluation comment posted every morning.
- **Manually pause the wired repos.** Close active dev-agent issues, remove `state:user-intent` labels from queued features, or pause the orchestrator at the dashboard level. The watchdog re-evaluates the next morning. Spend stops accruing as soon as the in-flight phases finish; the alert issue stays open until you close it.

A consumer-side `/cost-override` comment command is not shipped in v1. The two paths above are the only escape hatches.

---

## Manually triggering the watchdog

```bash
gh workflow run orch-sweep.yml --repo <owner>/<repo>
```

The `workflow_dispatch` path runs both the stuck-issue detection step AND the cost-watchdog step. On the cron path the two steps are mutually exclusive (the 10-minute schedule runs stuck-detect only; the 09:00 UTC schedule runs watchdog only). The watchdog finishes in under a minute on repos with under ~200 issues this month — pagination is the dominant cost, not aggregation.

---

## Verifying it ran

Three places to look:

- **`.dev-agent/events/global.jsonl`** in the repo. The watchdog emits a `cost.snapshot` line on every run, with `run_id`, `ts`, and a payload of either `{total, budget, pct, month}` or `{budget_unconfigured: true}`. If a threshold was crossed it also emits a second `cost.threshold.crossed` line with `tier`, `issue_created`, and the alert issue number. Both lines use `issue: null` (they're global events) so they land in `global.jsonl`, not a per-issue file.
- **The Actions tab** → most recent `orch-sweep` run → the "Cost watchdog (daily)" step. Green = ran. The step's stdout includes the snapshot payload if you need to confirm what the watchdog saw.
- **Open issues with label `cost-watchdog`** in the repo. If a threshold has crossed this month, the alert issue is there. Filter by `month:YYYY-MM` for the current month if the repo has accumulated stale alerts from previous months.

---

## Month rollover

The de-dupe key includes a `month:YYYY-MM` label, so a new calendar month gets a fresh alert issue — the watchdog's existing-issue lookup is keyed on the full label triple (`cost-watchdog` + tier + month), and a new month means the lookup misses and a new issue is created.

Previous-month alert issues remain OPEN by design. The watchdog never auto-closes them — the assumption is that an operator triaged them and either bumped the budget, fixed the underlying cost driver, or accepted the spend, and the issue should stay open with that context in the comment timeline until the operator manually closes it. Close previous-month issues after triage so the repo's open-issue list stays clean.

---

## Tuning the budget

Recommended starting points by repo activity (USD/month):

- **$25** for a low-activity consumer repo (1-2 small features/week, mostly hand-filed `kind:user-intent` issues that move through the pipeline once).
- **$75** for an active consumer repo (5-10 features/week, regular swarm-review cycles, occasional re-runs). This is the starting budget for dev-agent's own `.dev-agent.yml`.
- **$200** for a fleet-managing repo (a PM or two feeding dev-agent multiple features per day, frequent swarm-review iterations, tier-2 smoke runs).

These are starting points, not prescriptions. Observe one full calendar month of real data — `cost.snapshot` events accumulate in `.dev-agent/events/global.jsonl` daily — and bump the budget to roughly 1.3× the observed peak month. The 80% threshold then gives you a one-week warning at typical burn rates.

---

## Edge cases worth knowing

- **PR comments are not counted.** The aggregator reads `issues.listComments` for each issue updated this month. dev-agent posts telemetry to the issue, not the PR. If your consumer repo has customized telemetry to post on PRs instead, the watchdog will under-count. The fix is to keep telemetry on the issue (the watchdog cannot be reconfigured to read PR comments in v1).
- **Failed phases that crashed before posting telemetry contribute $0** to the sum. The watchdog under-reports rather than failing — if your Anthropic console total is materially higher than the watchdog's MTD figure, look for phases that crashed mid-run (the orchestrator logs these in the per-issue `.dev-agent/events/<N>.jsonl`).
- **Comments older than the start of the current UTC month are filtered out**, even on issues that were updated this month. This is intentional — the watchdog tracks MTD spend, not "all activity on issues that happened to be touched this month". A long-running feature that started in April and finished in May will only count its May telemetry comments toward the May total.
- **The aggregator only reads telemetry comments where `parseTelemetry` returns a non-null value with a numeric `cost_usd`.** Malformed or partial telemetry is skipped silently — the same forgiving-parse behavior the rest of the pipeline uses.
