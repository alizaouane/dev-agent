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
 * Money is summed as fractional cents and divided to USD once at the end (÷100),
 * rounded only at display — no per-row rounding, because `amount` has unbounded
 * decimal precision. Rows whose `amount` is not a finite number are skipped
 * rather than poisoning the total.
 *
 * @param buckets Daily buckets from `fetchCostReport` (may be empty).
 * @returns Ascending daily series, the grand `total_usd`, and per-series totals.
 */
export function shapeDailyByModel(buckets: CostBucket[]): DailyCostSummary {
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
