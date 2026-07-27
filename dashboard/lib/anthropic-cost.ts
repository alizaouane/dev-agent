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
