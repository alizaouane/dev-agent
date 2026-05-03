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

export type DailyCost = {
  day: string; // YYYY-MM-DD
  implement: number;
  staging_deploy: number;
  promote_to_prod: number;
  rollback: number;
  smoke_verify: number;
};

export function CostChart({ data }: { data: DailyCost[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="day" fontSize={11} />
        <YAxis tickFormatter={(v: number) => `$${v.toFixed(2)}`} fontSize={11} />
        <Tooltip formatter={(value) => `$${(value as number).toFixed(4)}`} />
        <Legend />
        <Bar dataKey="implement" stackId="a" fill="#4f46e5" />
        <Bar dataKey="staging_deploy" stackId="a" fill="#0891b2" />
        <Bar dataKey="promote_to_prod" stackId="a" fill="#16a34a" />
        <Bar dataKey="smoke_verify" stackId="a" fill="#eab308" />
        <Bar dataKey="rollback" stackId="a" fill="#dc2626" />
      </BarChart>
    </ResponsiveContainer>
  );
}
