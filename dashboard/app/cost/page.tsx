import { getOctokit } from '@/lib/gh';
import { listAllowedRepos } from '@/lib/repos';
import { fetchPipeline } from '@/lib/pipeline';
import { CostChart, type DailyCost } from '@/components/cost-chart';
import { parseTelemetry } from '@/lib/telemetry';

const PHASES = ['implement', 'staging_deploy', 'promote_to_prod', 'smoke_verify', 'rollback'] as const;
type PhaseKey = (typeof PHASES)[number];

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export default async function CostPage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  const items = await fetchPipeline(octokit, repos, { include_terminal: true });

  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const buckets: Record<string, Record<PhaseKey, number>> = {};
  for (const it of items) {
    const [owner, name] = it.repo.split('/');
    const cs = await octokit.issues.listComments({
      owner,
      repo: name,
      issue_number: it.issue_number,
      per_page: 100,
    });
    const comments = (cs as unknown as { data?: Array<{ body?: string; created_at?: string }> }).data ?? [];
    for (const c of comments) {
      if (!c.created_at) continue;
      const ts = new Date(c.created_at).getTime();
      if (ts < since) continue;
      const t = parseTelemetry(c.body ?? '');
      if (!t) continue;
      const day = dayOf(c.created_at);
      const phaseKey = t.phase.replace(/-/g, '_') as PhaseKey;
      if (!PHASES.includes(phaseKey)) continue;
      buckets[day] ??= { implement: 0, staging_deploy: 0, promote_to_prod: 0, smoke_verify: 0, rollback: 0 };
      buckets[day][phaseKey] += t.cost_usd;
    }
  }
  const data: DailyCost[] = Object.keys(buckets)
    .sort()
    .map((day) => ({ day, ...buckets[day] }));

  const total = data.reduce(
    (sum, d) => sum + d.implement + d.staging_deploy + d.promote_to_prod + d.smoke_verify + d.rollback,
    0,
  );

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Cost</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Anthropic spend across all repos, last 30 days. Total: <strong>${total.toFixed(2)}</strong>.
      </p>
      <CostChart data={data} />
    </div>
  );
}
