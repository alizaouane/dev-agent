# Cost Dashboard — Phase 1: Real Anthropic Spend

**Date:** 2026-06-27
**Status:** Draft (design)
**Author:** interactive session (Ali + Claude)

## Problem

The dashboard [/cost](../../../dashboard/app/cost/page.tsx) page shows **$0.00** and an
empty chart, even though there has been weeks of real Anthropic API spend (daily
`bug-scout` / `cleanup-scout` / `unfinished-work-scout` runs across `caliente-booking-app`,
`social-media-content`, and `whatsapp-console`, plus tier2/swarm runs).

Root cause (verified empirically this session):

1. **The actual spenders never report cost.** 100% of real spend is
   `anthropics/claude-code-action@v1` invocations inside the `phase-*` workflows.
   Those runs do not emit telemetry in dev-agent's format. The wired repos have
   **zero** `🤖 Phase` telemetry comments despite weeks of runs.
2. **The only telemetry comments that exist are stub `printf` blocks** with
   `Cost: $0` or no cost line; the parser requires `Cost:` + `Tokens:`
   ([lib/telemetry.ts:187](../../../lib/telemetry.ts)), so they contribute nothing.
3. **Even a reporting scout would be dropped** — [cost/page.tsx:8](../../../dashboard/app/cost/page.tsx)
   only counts `implement / staging_deploy / promote_to_prod / smoke_verify / rollback`;
   scouts aren't in the list.
4. **The page only reads comments on pipeline issues** — scouts file their own
   issues, so their spend is invisible regardless.

The telemetry-comment design assumed the (now-dormant, stub-by-default) SDK path
`lib/anthropic-client.ts` would execute and self-report. The product actually runs
`claude-code-action`, which reports nothing back. The page is faithfully showing the
absence of recorded data.

## Goals

1. The /cost page shows a **real spend total that matches the Anthropic Console**,
   including historical spend, with **no per-workflow instrumentation**.
2. The misleading silent `$0.00` is replaced by either real data or an **explicit
   "not configured / failed" state**.
3. A **daily spend chart broken down by model** (sonnet / haiku / opus).
4. Keep the existing per-phase telemetry chart on the page, relabeled as a Phase 2
   ("coming soon") feature, so the roadmap is visible and Phase 2 has a home.

## Non-goals (deferred to Phase 2)

- **Per-repo and per-phase attribution.** The Cost Report API groups by
  org / workspace / model / day — not by repo or dev-agent phase. True per-repo/phase
  attribution requires instrumenting each `claude-code-action` run to capture and
  persist its own usage. That is Phase 2 and needs a persistence layer.
- **Capturing local / manual (non-CI) spend** into the dashboard. Phase 1 shows the
  org-level total from Anthropic, which already *includes* all spend (CI, local,
  interactive) but cannot attribute the non-CI portion. Attribution is Phase 2.
- **A budget hard-stop / kill-switch.** Tracked separately (see SESSION_LOG
  2026-06-27 entry); not part of this spec.
- **Fixing the hardcoded `cost_7d_usd: 0`** on the home repo cards
  ([home-bands.ts:72](../../../dashboard/lib/dashboard/home-bands.ts)). That is per-repo
  attribution → Phase 2.

## Data source: Anthropic Admin Cost Report API

`GET https://api.anthropic.com/v1/organizations/cost_report`

- **Auth:** an Anthropic **Admin API key** (prefix `sk-ant-admin01-`), sent as
  `x-api-key: <key>` with `anthropic-version: 2023-06-01`. This is definitive — the
  Admin API docs state "pass the key in the `x-api-key` header on every request."
  (The Bearer example in the cost-report reference is the OAuth-token variant; it is
  not what we use for a static admin-key env var.)
- **Query params used:** `bucket_width=1d`, `group_by[]=description` (array syntax —
  this is what populates per-`model` + `token_type` rows), `starting_at` (RFC 3339,
  **floored to UTC midnight** — see Risks), `ending_at` (now). With `1d` granularity a
  30-day window is ≤ 31 buckets and fits in a single page; still follow `page` /
  `next_page` while `has_more` is true, defensively.
- **Response shape (verified against docs 2026-06-27):**
  ```
  { data: [ { starting_at, ending_at, results: [ {
      amount,            // STRING in fractional cents, e.g. "123.78912". USD = Number/100.
      currency,          // "USD"
      cost_type,         // "tokens" | "web_search" | "code_execution" | "session_usage"
      model,             // e.g. "claude-sonnet-4-6"  (null unless group_by=description; also null for non-token cost_type)
      token_type,        // "uncached_input_tokens" | "output_tokens" | "cache_read_input_tokens" | ...
      context_window,    // "0-200k" | "200k-1M"
      service_tier, workspace_id, inference_geo, description
  } ] } ], has_more, next_page }
  ```
- **`amount` is in fractional cents as a decimal string.** USD value = `Number(amount) / 100`.
  Example: `"123.45"` = `$1.2345` (the Console *displays* this rounded to `$1.23`; the
  raw value carries more precision). **Only round at the display boundary, never mid-sum**
  (see C2 in Architecture).
- **Granularity caveat:** `model` / `token_type` / `context_window` / `service_tier`
  are populated only when `group_by[]=description`, and are still `null` for
  **non-token** cost types (`web_search`, `code_execution`, `session_usage`) even with
  the grouping. Per bucket there are many result rows (model × token_type ×
  context_window × tier); we sum them per day per model. Non-token rows have `model: null`
  and are bucketed separately (see folding rule).
- **Excludes Priority Tier:** the docs warn that Priority Tier costs use a different
  billing model and are **not** included in this endpoint. For an org with a Priority
  Tier commitment the dashboard total will be lower than the Console (see Risks; UI
  footnote).
- **Freshness:** new spend appears within ~5 minutes. Recommended sustained polling is
  ~1/min; there is no tight rate limit forcing hourly. We still revalidate hourly for
  cost/UX reasons (below), and surface a "data lags ~5 min" note by the total.

### Why this source

It is the **same number the user sees in the Console** (ground truth), it is
**retroactive** (historical buckets return immediately, so weeks of past scout spend
appear at once), and it needs **no changes pushed to consumer repos**. The trade-off
is granularity (no per-repo/phase), which the user explicitly accepted as Phase 2.

## Architecture / components

### `dashboard/lib/anthropic-cost.ts` (new, `server-only`)

Two responsibilities, kept separate so the logic is unit-testable without a network:

- `fetchCostReport({ startingAt, endingAt }): Promise<CostReportResult>`
  - Reads `process.env.ANTHROPIC_ADMIN_KEY`. If unset → `{ ok: false, reason: 'no_key' }`.
  - Calls the endpoint with the params above, following `next_page` to completion.
  - On 401/403 → `{ ok: false, reason: 'unauthorized' }`. On other non-2xx / network
    error → `{ ok: false, reason: 'fetch_failed', message }`.
  - On success → `{ ok: true, buckets: CostBucket[] }`.
- `shapeDailyByModel(buckets: CostBucket[]): DailyCostSummary` — **pure function**:
  - **C2 — money precision: sum fractional cents, divide once, round only at display.**
    (Revised during implementation.) The original prescription — accumulate integer
    milli-cents via `Math.round(Number(amount) * 1000)` — is **wrong for this data**:
    `amount` carries unbounded decimal precision (e.g. `123.78912` cents), so rounding
    to a fixed integer scale *introduces* error (drops the sub-milli-cent part) rather
    than removing it. Correct approach: sum each row's `Number(amount)` (fractional
    cents) as a float per series, convert to USD (`/ 100`) once at the end, and round
    only at the display boundary (`toFixed`). Float summation across realistic per-day
    row counts stays exact far beyond the 2-dp Console display — the "drift a cent"
    fear does not materialize at these magnitudes — so Goal 1 (matches the Console)
    holds without the rounding bug.
  - Folds each row into a series:
    - `model` contains `sonnet` → `sonnet`; `haiku` → `haiku`; `opus` → `opus`.
    - `model` is non-null but matches none of the above → `other_model` (a **new/unknown
      model family** — surfaced via a `console.warn` so a new family is noticed, not buried).
    - `model` is null (non-token cost: web_search / code_execution / session_usage) →
      `non_token`. **`other_model` and `non_token` are distinct series** — they mean very
      different things and must not be conflated in one "other" bucket (S6).
  - Aggregates per `day` (`starting_at.slice(0,10)`, a UTC date) × series, summing across
    all token types, context windows, and service tiers.
  - Returns `{ days: DailyModelCost[], total_usd, by_series }` where
    `DailyModelCost = { day; sonnet; haiku; opus; other_model; non_token }` (all USD numbers).

Types: `CostReportResult` is a discriminated union on `ok`. No `any`.

### `dashboard/components/cost-by-model-chart.tsx` (new)

Recharts stacked `BarChart`, daily on the x-axis, one stacked series per model family,
mirroring the existing [cost-chart.tsx](../../../dashboard/components/cost-chart.tsx)
(same Recharts version, same styling conventions). Props: `{ data: DailyModelCost[] }`.

### `dashboard/app/cost/page.tsx` (modified)

- Compute the 30-day window, call `fetchCostReport`.
- **`ok: true` with spend:** render the real total (`$total_usd.toFixed(2)`, "matches
  your Anthropic Console (excl. Priority Tier); data lags ~5 min") +
  `<CostByModelChart data={days} />`.
- **`ok: true` with zero buckets (N1):** render an explicit "No Anthropic spend
  recorded in this window yet." — a **distinct** empty state, NOT `$0.00`. This is the
  legitimately-empty-org case and must not reproduce the misleading-zero bug.
- **`ok: false`:** render an explicit notice (no chart, never `$0.00`):
  - `no_key` → "Set `ANTHROPIC_ADMIN_KEY` on the dashboard to see real spend." + a
    one-line pointer to the setup steps.
  - `unauthorized` → "Admin key rejected — confirm it's an `sk-ant-admin01-…` key."
  - `fetch_failed` → "Couldn't reach the Anthropic Cost API." + the error message.
  - Mirrors the existing not-configured pattern in
    [repos/page.tsx:34-44](../../../dashboard/app/repos/page.tsx).
- **Below**, the "coming in Phase 2" placeholder: a **static** muted section ("Per-repo
  & per-phase breakdown — coming in Phase 2, requires per-run instrumentation").
  **N2 — do NOT keep the old data fetch.** The current section calls `getOctokit` →
  `listAllowedRepos` → `fetchPipeline` → paginates every issue's comments across all
  wired repos ([cost/page.tsx:15-58](../../../dashboard/app/cost/page.tsx)). That burns
  GitHub rate limit and can throw, to render a section that is always empty until
  Phase 2. Remove that fetch; render a static placeholder instead.

### Caching / freshness

Page-level `export const revalidate = 3600` (hourly). **Rationale: cost/UX, not a rate
limit** — the endpoint tolerates ~1/min polling and data lags ~5 min, so hourly is a
deliberate cost/refresh tradeoff (tunable).
- **S3 — set the fetch cache mode explicitly.** With ISR, the inner cost-API `fetch`
  is also subject to Next's data cache; set `next: { revalidate: 3600 }` on the cost
  fetch (or `cache: 'no-store'` if we want the route cache to be the only layer) so
  the two cache layers don't interact ambiguously across the paginated loop.
- **Do not statically prerender this segment.** It reads `process.env.ANTHROPIC_ADMIN_KEY`
  and makes a network call; if prerendered at build (where the secret may be absent) it
  would cache a permanent `no_key` page. Ensure the segment is dynamic-with-ISR (the
  `revalidate` export plus env/network access makes it dynamic; verify it is not
  forced-static).

### Config / env

- `ANTHROPIC_ADMIN_KEY` — **server-only secret**, never `NEXT_PUBLIC_`.
- **How to obtain (C3 — corrected path; include in dashboard env docs):** Anthropic
  Console → **Settings → Admin keys** (direct: `platform.claude.com/settings/admin-keys`),
  requires org **admin/owner** role → **Create key** → copy the `sk-ant-admin01-…`
  value (Console admin keys have **no selectable scopes** — every admin key is full
  org access) → set it as a secret env var on the dashboard host (e.g. Vercel project
  env / deployment secret). Treat it as highly sensitive — it can read org-wide billing.

## Data flow

```
Admin Cost Report API  (cents, per day, per model+token_type, paginated)
  → fetchCostReport()        (auth, paginate, map errors to a discriminated result)
  → shapeDailyByModel()      (÷100 → USD, fold model→family, sum per day×family)
  → page                     (real total + daily-by-model stacked chart, or explicit notice)
```

No database in Phase 1 — the Cost Report API is the durable, queryable store.

## Testing strategy

- **`dashboard/__tests__/lib/anthropic-cost.test.ts`** (unit, vitest):
  - `shapeDailyByModel` against a fixture mirroring the documented response. The
    fixture MUST include a fractional-cents amount (e.g. `"123.78912"`) and a
    **non-token** row (`cost_type: "web_search"`, `model: null`) so the `non_token`
    series is exercised on real org spend, not an invented null.
    - cents → USD conversion (`Number(amount) / 100`).
    - series folding: `claude-sonnet-4-6` → `sonnet`, `claude-haiku-4-5` → `haiku`,
      `claude-opus-4-7` → `opus`, an unknown non-null model → `other_model`,
      `model: null` non-token row → `non_token`.
    - multiple token-type / context-window rows for the same model+day sum into one.
    - **`total_usd` must be a computed expectation, not a hand-typed golden** (compute
      it from the fixture in the test) — and assert no float drift by also accumulating
      the fixture in scaled-integer cents (C1/C2).
    - multi-day ordering (UTC `day` strings ascending).
  - Error mapping: missing env → `no_key`; (mocked fetch) 401/403 → `unauthorized`,
    500/network → `fetch_failed`.
- The page (server component) and chart get light/no unit coverage; the shaping
  function holds the logic and is fully covered.

## Risks / open items

- **Priority Tier excluded (S4):** orgs with a Priority Tier commitment will see a
  dashboard total *lower* than the Console, because those costs aren't in this
  endpoint. Surface a UI footnote ("excludes Priority Tier"); document the gap.
- **UTC day buckets (S7):** `starting_at` snaps to UTC midnight and `day` is a UTC
  date. Floor the window's `starting_at` to `…T00:00:00Z`; expect the first/last
  bucket to be partial. A user in a non-UTC zone sees "today" lag — acceptable, but
  reconcile the page's "last 30 days" copy with UTC-day semantics.
- **Empty-data state (N1):** a legitimately-empty org returns `ok: true` with zero
  buckets — must render the distinct "no spend yet" state, not `$0.00` (handled in the
  page layout above).
- **Workspace scoping:** if the org has multiple workspaces, the report aggregates all
  of them — correct for "total spend across all repos." Per-workspace filtering via
  `group_by[]=workspace_id` is available but unused in Phase 1.
- **Freshness lag:** ~5 min between a run finishing and its cost appearing; the UI
  notes this so a just-finished run that isn't visible yet doesn't read as a bug.

## Phase 2 (out of scope, recorded for continuity)

Per-repo/per-phase attribution + capture of non-CI spend: instrument each
`claude-code-action` run to read its own token usage, compute cost via
[lib/pricing.ts](../../../lib/pricing.ts), and persist it (Supabase table or the
events system) keyed by repo + phase + day. Then fix `cost_7d_usd` on the home cards
and the per-phase chart from that store. Requires changes pushed to every wired repo.
