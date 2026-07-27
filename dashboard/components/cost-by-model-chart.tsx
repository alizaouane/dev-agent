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
