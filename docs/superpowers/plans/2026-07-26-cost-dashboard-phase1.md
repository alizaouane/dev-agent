# Cost Dashboard Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard `/cost` page show real, Console-matching Anthropic spend (total + daily-by-model chart) pulled live from the Admin Cost Report API, replacing the misleading silent `$0.00`.

**Architecture:** A server-only lib (`dashboard/lib/anthropic-cost.ts`) with a pure shaping function (`shapeDailyByModel`, unit-tested) and an impure fetcher (`fetchCostReport`, mocked-fetch tested). The `/cost` server component calls them, renders a total + a new stacked `CostByModelChart`, and shows explicit not-configured / empty / error states instead of `$0.00`. No database — the Cost Report API is the durable store. Per-repo/phase attribution is Phase 2 (out of scope).

**Tech Stack:** Next.js 15 App Router (server components + ISR), TypeScript strict, recharts ^3.8.1, vitest.

**Spec:** [docs/superpowers/specs/2026-06-27-cost-dashboard-phase1-design.md](../specs/2026-06-27-cost-dashboard-phase1-design.md)

## Global Constraints

- **TypeScript strict; zero `any`** without an inline justification comment.
- **100% docstring coverage** (TSDoc) on every exported symbol — meaningful contracts, not signature restatements.
- **Money precision:** sum each row's fractional-cents `amount` per series, divide to USD **once at the end** (÷100), and round **only at display**. Do not round per row to a fixed integer scale — `amount` has unbounded decimal precision, so a fixed scale would itself introduce error; float summation at these magnitudes stays exact well beyond the 2-dp display.
- **`amount` from the API is fractional cents as a decimal string** → USD = `Number(amount) / 100`. Round only at the display boundary.
- **`ANTHROPIC_ADMIN_KEY` is a server-only secret** — never `NEXT_PUBLIC_`, never logged.
- **Auth:** `x-api-key: <admin key>` + `anthropic-version: 2023-06-01`. Query uses `group_by[]=description` (array syntax) + `bucket_width=1d`.
- **UTC day buckets:** `starting_at` floored to UTC midnight; `day = starting_at.slice(0,10)` is a UTC date.
- **Test paths:** `dashboard/__tests__/…`, vitest, `@/` path alias, `import { describe, it, expect } from 'vitest'`.
- Run all commands from `dashboard/` (the Next app root).

## File Structure

- **Create** `dashboard/lib/anthropic-cost.ts` — types, `shapeDailyByModel` (pure), `fetchCostReport` (impure). Single responsibility: turn the Cost Report API into a shaped daily-by-model summary or a typed error.
- **Create** `dashboard/components/cost-by-model-chart.tsx` — presentational stacked bar chart (mirrors `cost-chart.tsx`).
- **Create** `dashboard/__tests__/lib/anthropic-cost.test.ts` — unit tests for both functions.
- **Modify** `dashboard/app/cost/page.tsx` — rewrite to use the new lib + chart + states; remove the dead GitHub-telemetry fetch, replace with a static Phase-2 placeholder.
- **Modify** dashboard env docs (`dashboard/.env.example` if present, else `dashboard/README.md`) — document `ANTHROPIC_ADMIN_KEY`.

---

### Task 1: Cost types + pure `shapeDailyByModel`

**Files:**
- Create: `dashboard/lib/anthropic-cost.ts`
- Test: `dashboard/__tests__/lib/anthropic-cost.test.ts`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces: the exported types below, and `shapeDailyByModel(buckets: CostBucket[]): DailyCostSummary`. Task 2 adds `fetchCostReport` to the same file; Tasks 3–4 consume `DailyModelCost` / `DailyCostSummary` / `CostReportResult`.

- [ ] **Step 1: Write the failing test**

Create `dashboard/__tests__/lib/anthropic-cost.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  shapeDailyByModel,
  type CostBucket,
} from '@/lib/anthropic-cost';

/** One results row with sensible defaults; override per test. */
function row(over: Partial<CostBucket['results'][number]>): CostBucket['results'][number] {
  return {
    amount: '0',
    currency: 'USD',
    cost_type: 'tokens',
    model: 'claude-sonnet-4-6',
    token_type: 'uncached_input_tokens',
    context_window: '0-200k',
    service_tier: 'standard',
    workspace_id: null,
    inference_geo: 'global',
    description: null,
    ...over,
  };
}

describe('shapeDailyByModel', () => {
  it('converts fractional cents to USD, folds model families, and separates non-token cost', () => {
    const buckets: CostBucket[] = [
      {
        starting_at: '2026-07-01T00:00:00Z',
        ending_at: '2026-07-02T00:00:00Z',
        results: [
          // sonnet: two token-type rows same day+model must sum
          row({ amount: '123.78912', model: 'claude-sonnet-4-6', token_type: 'uncached_input_tokens' }),
          row({ amount: '10', model: 'claude-sonnet-4-6', token_type: 'output_tokens' }),
          row({ amount: '50', model: 'claude-haiku-4-5' }),
          row({ amount: '200', model: 'claude-opus-4-7' }),
          // unknown non-null model → other_model
          row({ amount: '5', model: 'claude-future-9' }),
          // non-token cost: model null → non_token
          row({ amount: '30', model: null, token_type: null, context_window: null, service_tier: null, cost_type: 'web_search' }),
        ],
      },
      {
        starting_at: '2026-07-02T00:00:00Z',
        ending_at: '2026-07-03T00:00:00Z',
        results: [row({ amount: '400', model: 'claude-sonnet-4-6' })],
      },
    ];

    const out = shapeDailyByModel(buckets);

    // Two UTC days, ascending.
    expect(out.days.map((d) => d.day)).toEqual(['2026-07-01', '2026-07-02']);

    // Day 1 sonnet = (123.78912 + 10) cents / 100 = 1.3378912 USD
    expect(out.days[0].sonnet).toBeCloseTo((123.78912 + 10) / 100, 10);
    expect(out.days[0].haiku).toBeCloseTo(50 / 100, 10);
    expect(out.days[0].opus).toBeCloseTo(200 / 100, 10);
    expect(out.days[0].other_model).toBeCloseTo(5 / 100, 10);
    expect(out.days[0].non_token).toBeCloseTo(30 / 100, 10);
    expect(out.days[1].sonnet).toBeCloseTo(400 / 100, 10);

    // total = computed from the fixture (NOT a hand-typed golden). Summed as
    // fractional cents then divided once — no per-row rounding, so this matches
    // the implementation exactly.
    const allCents = [123.78912, 10, 50, 200, 5, 30, 400];
    const expectedTotal = allCents.reduce((s, c) => s + c, 0) / 100;
    expect(out.total_usd).toBeCloseTo(expectedTotal, 10);
    expect(out.by_series.sonnet).toBeCloseTo((123.78912 + 10 + 400) / 100, 10);
  });

  it('ignores rows with a non-finite amount instead of poisoning the total', () => {
    const buckets: CostBucket[] = [
      {
        starting_at: '2026-07-01T00:00:00Z',
        ending_at: '2026-07-02T00:00:00Z',
        results: [row({ amount: 'not-a-number' }), row({ amount: '100', model: 'claude-haiku-4-5' })],
      },
    ];
    const out = shapeDailyByModel(buckets);
    expect(Number.isFinite(out.total_usd)).toBe(true);
    expect(out.total_usd).toBeCloseTo(1, 10);
  });

  it('returns an empty summary for no buckets', () => {
    const out = shapeDailyByModel([]);
    expect(out.days).toEqual([]);
    expect(out.total_usd).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- anthropic-cost`
Expected: FAIL — `Cannot find module '@/lib/anthropic-cost'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

> **Money precision (corrected):** accumulate each row's fractional-cents `amount`
> as a float per series, and divide to USD **once at the end**; round only at the
> display boundary (`toFixed`). Do NOT round per row to a fixed integer scale —
> `amount` carries unbounded decimal precision (e.g. `123.78912` cents), so any
> fixed scale (milli-cents) introduces its own rounding error. Float summation of
> realistic per-day row counts is exact to far beyond the 2-dp Console display, so
> the total still matches the Console — which is the actual goal.

Create `dashboard/lib/anthropic-cost.ts`:

```ts
import 'server-only';

/** A single cost line item from the Admin Cost Report API (group_by=description). */
export type CostResultRow = {
  /** Cost in fractional CENTS as a decimal string, e.g. "123.78912". USD = Number/100. */
  amount: string;
  currency: string;
  cost_type: 'tokens' | 'web_search' | 'code_execution' | 'session_usage' | null;
  /** Model id, e.g. "claude-sonnet-4-6". null unless group_by=description and cost_type=tokens. */
  model: string | null;
  token_type: string | null;
  context_window: string | null;
  service_tier: string | null;
  workspace_id: string | null;
  inference_geo: string | null;
  description: string | null;
};

/** One daily time bucket from the Cost Report API. */
export type CostBucket = {
  /** RFC 3339, start of the UTC day (inclusive). */
  starting_at: string;
  /** RFC 3339, end of the UTC day (exclusive). */
  ending_at: string;
  results: CostResultRow[];
};

/** The chart series a cost row is folded into. */
export type ModelSeries = 'sonnet' | 'haiku' | 'opus' | 'other_model' | 'non_token';

/** USD cost for one UTC day, split by model series. */
export type DailyModelCost = {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  sonnet: number;
  haiku: number;
  opus: number;
  /** Non-null model that matched no known family (a new/unknown model). */
  other_model: number;
  /** Non-token cost (web search, code execution, session usage). */
  non_token: number;
};

/** Shaped, display-ready cost summary in USD. */
export type DailyCostSummary = {
  /** Ascending by UTC day. */
  days: DailyModelCost[];
  total_usd: number;
  by_series: Record<ModelSeries, number>;
};

const EMPTY_SERIES = (): Record<ModelSeries, number> => ({
  sonnet: 0,
  haiku: 0,
  opus: 0,
  other_model: 0,
  non_token: 0,
});

/**
 * Fold one cost row into a chart series. Non-null models that match no known
 * family become `other_model` (and are warned about, so a new family is noticed
 * rather than silently buried); null-model rows are non-token costs.
 */
function seriesFor(row: CostResultRow): ModelSeries {
  const m = row.model;
  if (m == null) return 'non_token';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus')) return 'opus';
  console.warn(`[anthropic-cost] unknown model family, bucketing as other_model: ${m}`);
  return 'other_model';
}

/**
 * Aggregate raw Cost Report buckets into per-UTC-day, per-model-series USD totals.
 *
 * Each row's `amount` (fractional cents) is summed as a float per series and
 * divided to USD once at the end (÷100); callers round only at display. We do
 * NOT round per row to a fixed integer scale — `amount` carries unbounded
 * decimal precision, so a fixed scale would itself introduce error. Float
 * summation of realistic row counts stays exact well beyond the 2-dp Console
 * display, so the total matches the Console. Rows whose `amount` is not a finite
 * number are skipped rather than poisoning the total.
 *
 * @param buckets Daily buckets from `fetchCostReport` (may be empty).
 * @returns Ascending daily series, the grand `total_usd`, and per-series totals.
 */
export function shapeDailyByModel(buckets: CostBucket[]): DailyCostSummary {
  // Accumulate fractional cents per series; convert to USD (÷100) once at the end.
  const perDay = new Map<string, Record<ModelSeries, number>>();
  const totals = EMPTY_SERIES();

  for (const bucket of buckets) {
    const day = bucket.starting_at.slice(0, 10);
    let dayAcc = perDay.get(day);
    if (!dayAcc) {
      dayAcc = EMPTY_SERIES();
      perDay.set(day, dayAcc);
    }
    for (const r of bucket.results) {
      const cents = Number(r.amount);
      if (!Number.isFinite(cents)) continue;
      const s = seriesFor(r);
      dayAcc[s] += cents;
      totals[s] += cents;
    }
  }

  const toUsd = (cents: number): number => cents / 100;

  const days: DailyModelCost[] = [...perDay.keys()].sort().map((day) => {
    const acc = perDay.get(day)!;
    return {
      day,
      sonnet: toUsd(acc.sonnet),
      haiku: toUsd(acc.haiku),
      opus: toUsd(acc.opus),
      other_model: toUsd(acc.other_model),
      non_token: toUsd(acc.non_token),
    };
  });

  const by_series: Record<ModelSeries, number> = {
    sonnet: toUsd(totals.sonnet),
    haiku: toUsd(totals.haiku),
    opus: toUsd(totals.opus),
    other_model: toUsd(totals.other_model),
    non_token: toUsd(totals.non_token),
  };

  const total_usd = toUsd(
    totals.sonnet + totals.haiku + totals.opus + totals.other_model + totals.non_token,
  );

  return { days, total_usd, by_series };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- anthropic-cost`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/anthropic-cost.ts dashboard/__tests__/lib/anthropic-cost.test.ts
git commit -m "feat(dashboard): cost types + pure shapeDailyByModel (Phase 1 cost)"
```

---

### Task 2: `fetchCostReport` (auth, pagination, typed errors)

**Files:**
- Modify: `dashboard/lib/anthropic-cost.ts` (append the fetcher + `CostReportResult` type)
- Test: `dashboard/__tests__/lib/anthropic-cost.test.ts` (append a `fetchCostReport` describe block)

**Interfaces:**
- Consumes: `CostBucket` (Task 1).
- Produces: `fetchCostReport(opts: { startingAt: string; endingAt: string }): Promise<CostReportResult>` and `CostReportResult = { ok: true; buckets: CostBucket[] } | { ok: false; reason: 'no_key' | 'unauthorized' | 'fetch_failed'; message?: string }`. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/__tests__/lib/anthropic-cost.test.ts` (add `beforeEach`, `afterEach`, `vi` to the vitest import):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchCostReport } from '@/lib/anthropic-cost';

describe('fetchCostReport', () => {
  const OLD_ENV = process.env.ANTHROPIC_ADMIN_KEY;
  afterEach(() => {
    process.env.ANTHROPIC_ADMIN_KEY = OLD_ENV;
    vi.restoreAllMocks();
  });

  it('returns no_key when the admin key is unset', async () => {
    delete process.env.ANTHROPIC_ADMIN_KEY;
    const r = await fetchCostReport({ startingAt: 'a', endingAt: 'b' });
    expect(r).toEqual({ ok: false, reason: 'no_key' });
  });

  it('returns unauthorized on a 401', async () => {
    process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin01-x';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const r = await fetchCostReport({ startingAt: 'a', endingAt: 'b' });
    expect(r).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('returns fetch_failed on a 500', async () => {
    process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin01-x';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const r = await fetchCostReport({ startingAt: 'a', endingAt: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('fetch_failed');
  });

  it('follows pagination and concatenates buckets', async () => {
    process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin01-x';
    const page1 = { data: [{ starting_at: '2026-07-01T00:00:00Z', ending_at: '2026-07-02T00:00:00Z', results: [] }], has_more: true, next_page: 'PAGE2' };
    const page2 = { data: [{ starting_at: '2026-07-02T00:00:00Z', ending_at: '2026-07-03T00:00:00Z', results: [] }], has_more: false, next_page: null };
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('PAGE2') ? page2 : page1), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await fetchCostReport({ startingAt: '2026-07-01T00:00:00Z', endingAt: '2026-07-03T00:00:00Z' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.buckets.map((b) => b.starting_at)).toEqual(['2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z']);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Auth + query shape on the first call.
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstUrl).toContain('group_by%5B%5D=description'); // group_by[]=description, URL-encoded
    expect(firstUrl).toContain('bucket_width=1d');
    expect((firstInit.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-admin01-x');
    expect((firstInit.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- anthropic-cost`
Expected: FAIL — `fetchCostReport` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `dashboard/lib/anthropic-cost.ts`:

```ts
/** Result of a Cost Report fetch: shaped buckets, or a typed failure reason. */
export type CostReportResult =
  | { ok: true; buckets: CostBucket[] }
  | { ok: false; reason: 'no_key' | 'unauthorized' | 'fetch_failed'; message?: string };

const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';

/** Raw pagination envelope returned by the Cost Report API. */
type CostReportPage = { data: CostBucket[]; has_more: boolean; next_page: string | null };

/**
 * Fetch org-wide daily cost from the Admin Cost Report API, grouped by
 * description (so each row carries model + token_type). Reads the admin key
 * from `ANTHROPIC_ADMIN_KEY`; follows `next_page` to completion. All failures
 * are mapped to a typed result so callers render an explicit state — never a
 * silent $0.
 *
 * @param opts.startingAt RFC 3339, floored to UTC midnight by the caller.
 * @param opts.endingAt RFC 3339 upper bound (exclusive).
 * @returns `{ ok: true, buckets }` or `{ ok: false, reason }`.
 */
export async function fetchCostReport(opts: {
  startingAt: string;
  endingAt: string;
}): Promise<CostReportResult> {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) return { ok: false, reason: 'no_key' };

  const buckets: CostBucket[] = [];
  let page: string | undefined;

  try {
    do {
      const params = new URLSearchParams({
        starting_at: opts.startingAt,
        ending_at: opts.endingAt,
        bucket_width: '1d',
      });
      params.append('group_by[]', 'description');
      if (page) params.set('page', page);

      const res = await fetch(`${COST_REPORT_URL}?${params.toString()}`, {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        // ISR data-cache: refresh hourly, matching the page's revalidate.
        next: { revalidate: 3600 },
      });

      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' };
      if (!res.ok) return { ok: false, reason: 'fetch_failed', message: `HTTP ${res.status}` };

      const json = (await res.json()) as CostReportPage;
      buckets.push(...json.data);
      page = json.has_more ? json.next_page ?? undefined : undefined;
    } while (page);
  } catch (err) {
    return {
      ok: false,
      reason: 'fetch_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, buckets };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- anthropic-cost`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/anthropic-cost.ts dashboard/__tests__/lib/anthropic-cost.test.ts
git commit -m "feat(dashboard): fetchCostReport with auth, pagination, typed errors"
```

---

### Task 3: `CostByModelChart` component

**Files:**
- Create: `dashboard/components/cost-by-model-chart.tsx`

**Interfaces:**
- Consumes: `DailyModelCost[]` (Task 1).
- Produces: `CostByModelChart({ data }: { data: DailyModelCost[] })`. Consumed by Task 4.

**Note on testing:** this is a presentational recharts client component; like the existing `cost-chart.tsx` it carries no unit test — it's verified by `tsc` (Step 2) and visually at the end. The logic under test lives in `shapeDailyByModel` (Task 1).

- [ ] **Step 1: Write the component**

Create `dashboard/components/cost-by-model-chart.tsx` (mirrors [cost-chart.tsx](../../../dashboard/components/cost-chart.tsx)):

```tsx
'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { DailyModelCost } from '@/lib/anthropic-cost';

/**
 * Stacked daily bar chart of Anthropic spend, one series per model family
 * (plus unknown models and non-token costs). Presentational only — receives
 * already-shaped, USD-valued rows from `shapeDailyByModel`.
 */
export function CostByModelChart({ data }: { data: DailyModelCost[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="day" fontSize={11} />
        <YAxis tickFormatter={(v: number) => `$${v.toFixed(2)}`} fontSize={11} />
        <Tooltip formatter={(value) => `$${(value as number).toFixed(4)}`} />
        <Legend />
        <Bar dataKey="sonnet" stackId="a" fill="#0891b2" name="Sonnet" />
        <Bar dataKey="haiku" stackId="a" fill="#16a34a" name="Haiku" />
        <Bar dataKey="opus" stackId="a" fill="#4f46e5" name="Opus" />
        <Bar dataKey="other_model" stackId="a" fill="#a855f7" name="Other model" />
        <Bar dataKey="non_token" stackId="a" fill="#eab308" name="Non-token" />
      </BarChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck` (or `npx tsc --noEmit`)
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/components/cost-by-model-chart.tsx
git commit -m "feat(dashboard): CostByModelChart stacked daily-by-model chart"
```

---

### Task 4: Rewrite `/cost` page + env docs

**Files:**
- Modify: `dashboard/app/cost/page.tsx` (full rewrite)
- Modify: `dashboard/.env.example` (or `dashboard/README.md` if no `.env.example`) — document `ANTHROPIC_ADMIN_KEY`

**Interfaces:**
- Consumes: `fetchCostReport`, `shapeDailyByModel` (Tasks 1–2), `CostByModelChart` (Task 3).
- Produces: the rendered page (no exports consumed downstream).

- [ ] **Step 1: Rewrite the page**

Replace the entire contents of `dashboard/app/cost/page.tsx`:

```tsx
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
    // Threshold, not exact-zero: any total that would DISPLAY as $0.00 (i.e.
    // under half a cent) must route to the empty state, or we reproduce the
    // very silent-$0.00 bug this feature exists to kill (spec goal 2 / N1).
    if (summary.days.length === 0 || summary.total_usd < 0.005) {
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
```

- [ ] **Step 2: Type-check + build**

Run: `npm run typecheck && npm run build`
Expected: no type errors; build succeeds. (The old `PHASES` / `parseTelemetry` / `fetchPipeline` imports are gone — confirm no leftover references.)

- [ ] **Step 3: Document the env var**

If `dashboard/.env.example` exists, add:

```bash
# Admin API key (sk-ant-admin01-…) for the /cost page's real-spend total.
# Console → Settings → Admin keys (requires org admin/owner). Server-only secret.
ANTHROPIC_ADMIN_KEY=
```

If there is no `.env.example`, add the same note under an "Environment variables" section in `dashboard/README.md` (create the section if absent).

- [ ] **Step 4: Commit**

```bash
git add dashboard/app/cost/page.tsx dashboard/.env.example dashboard/README.md
git commit -m "feat(dashboard): /cost shows real Anthropic spend + explicit states (Phase 1)"
```

---

### Task 5: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, including the new `anthropic-cost` tests; no regressions.

- [ ] **Step 2: Type-check + build**

Run: `npm run typecheck && npm run build`
Expected: all clean. (The dashboard package has no standalone `lint` script; `next build` runs lint as part of the build.)

- [ ] **Step 3: Manual smoke (optional, needs a real key)**

With `ANTHROPIC_ADMIN_KEY` set locally, run `npm run dev`, open `/cost`, confirm a non-zero total that matches the Anthropic Console and a populated daily-by-model chart. Without the key set, confirm the amber "ANTHROPIC_ADMIN_KEY isn't set" notice renders (not `$0.00`).

- [ ] **Step 4: Commit any fixes** (only if Steps 1–3 surfaced issues).

---

## Self-Review

**Spec coverage:**
- Real Console-matching total → Task 4 (total from `shapeDailyByModel.total_usd`). ✓
- Daily-by-model chart → Tasks 1, 3, 4. ✓
- No silent $0 (explicit not-configured/empty/error states) → Task 4 `Notice` + empty branch. ✓
- Admin Cost Report API, `group_by[]=description`, `bucket_width=1d`, pagination, `x-api-key` + `anthropic-version` → Task 2. ✓
- `amount` in fractional cents ÷100; integer-milli-cent accumulation (C1/C2) → Task 1. ✓
- Model-family folding with `other_model` vs `non_token` separated + warn (S6) → Task 1 `seriesFor`. ✓
- UTC day buckets, window floored to UTC midnight (S7) → Task 4 `utcMidnightDaysAgo`. ✓
- ISR fetch-cache mode set explicitly (S3) → Task 2 `next: { revalidate }` + Task 4 `revalidate` + dynamic-not-static note. ✓
- Priority Tier + freshness caveats surfaced in UI (S4/S2) → Task 4 total copy. ✓
- Remove dead GitHub telemetry fetch; static Phase-2 placeholder (N2) → Task 4. ✓
- `ANTHROPIC_ADMIN_KEY` env docs (C3 corrected path/prefix) → Task 4 Step 3. ✓
- Unit tests incl. fractional cents, non-token row, computed total, error mapping → Tasks 1–2. ✓

**Placeholder scan:** no TBD/TODO; all code shown in full. ✓

**Type consistency:** `CostBucket`, `CostResultRow`, `DailyModelCost`, `DailyCostSummary`, `CostReportResult`, `ModelSeries` defined in Task 1/2 and used verbatim in Tasks 3–4. `fetchCostReport` / `shapeDailyByModel` signatures match across tasks. ✓
