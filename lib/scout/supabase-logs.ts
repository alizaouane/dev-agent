import type { Candidate } from './types';

type Config = { kind: 'supabase_logs'; project_ids: string[] };

type LogRow = {
  level?: string;
  event_message?: string;
  metadata?: { request?: { path?: string } };
};

export async function supabaseLogsAdapter(config: Config): Promise<Candidate[]> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    process.stderr.write('supabase_logs: SUPABASE_ACCESS_TOKEN not set, skipping\n');
    return [];
  }
  const out: Candidate[] = [];
  for (const ref of config.project_ids) {
    try {
      const url = `https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs.all?sql=${encodeURIComponent(
        "SELECT level, event_message FROM api_logs WHERE level IN ('error','crit') AND timestamp > now() - INTERVAL '24 hours' LIMIT 100",
      )}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        process.stderr.write(`supabase_logs: ${ref} HTTP ${resp.status}, skipping\n`);
        continue;
      }
      const body = (await resp.json()) as { result?: LogRow[] };
      const buckets = new Map<string, number>();
      for (const row of body.result ?? []) {
        const key = row.event_message?.slice(0, 80) ?? 'unknown';
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      for (const [msg, count] of buckets) {
        out.push({
          source: 'supabase_logs',
          title: `supabase error (${count}×): ${msg}`,
          body: `Project: ${ref}\nMessage: ${msg}\nOccurrences: ${count} in last 24h`,
          evidence_url: `https://supabase.com/dashboard/project/${ref}/logs/explorer`,
          severity_hint: count >= 10 ? 'high' : count >= 3 ? 'medium' : 'low',
          novelty_score: 0.6,
        });
      }
    } catch (err) {
      process.stderr.write(`supabase_logs: ${ref} fetch failed (${err instanceof Error ? err.message : String(err)}), skipping\n`);
    }
  }
  return out;
}
