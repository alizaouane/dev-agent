import { execFileSync } from 'node:child_process';
import type { Candidate } from './types';

type Config = { kind: 'vercel_logs'; project: string };

export async function vercelLogsAdapter(config: Config): Promise<Candidate[]> {
  if (!process.env.VERCEL_TOKEN) {
    process.stderr.write('vercel_logs: VERCEL_TOKEN not set, skipping\n');
    return [];
  }
  let output: string;
  try {
    output = execFileSync(
      'vc',
      ['logs', config.project, '--since=24h', '--output=json', '--token', process.env.VERCEL_TOKEN],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    process.stderr.write(`vercel_logs: vc CLI unavailable or failed (${err instanceof Error ? err.message : String(err)}), skipping\n`);
    return [];
  }
  const lines = output.split('\n').filter((l) => l.trim().startsWith('{'));
  const errorBuckets = new Map<string, { count: number; sample: string }>();
  for (const line of lines) {
    let parsed: { level?: string; message?: string; requestPath?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.level !== 'error' || !parsed.message) continue;
    const key = (parsed.requestPath ?? 'no-path') + ':' + parsed.message.slice(0, 80);
    const cur = errorBuckets.get(key) ?? { count: 0, sample: parsed.message };
    cur.count += 1;
    errorBuckets.set(key, cur);
  }
  return [...errorBuckets.entries()].map(([key, { count, sample }]) => ({
    source: 'vercel_logs' as const,
    title: `prod error (${count}×): ${sample.slice(0, 80)}`,
    body: `Path: ${key.split(':')[0]}\nSample: ${sample}\nOccurrences: ${count} in last 24h`,
    evidence_url: null,
    severity_hint: count >= 10 ? 'high' : count >= 3 ? 'medium' : 'low',
    novelty_score: Math.min(0.9, 0.4 + count * 0.05),
  }));
}
