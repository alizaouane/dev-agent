import { getOctokit } from '@/lib/gh';
import { FeatureDetail } from '@/components/feature-detail';
import { parseTelemetry } from '@/lib/telemetry';

type SearchParams = Promise<{ repo?: string }>;

export default async function FeaturePage(props: {
  params: Promise<{ issue: string }>;
  searchParams: SearchParams;
}) {
  const { issue } = await props.params;
  const { repo } = await props.searchParams;
  if (!repo) throw new Error('repo query param required');
  const [owner, name] = repo.split('/');
  const issue_number = parseInt(issue, 10);
  const octokit = await getOctokit();

  const [{ data: issueData }, comments] = await Promise.all([
    octokit.issues.get({ owner, repo: name, issue_number }),
    octokit.issues.listComments({ owner, repo: name, issue_number, per_page: 100 }),
  ]);
  const stateLabel =
    (issueData.labels.map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean) as string[]).find((l) =>
      l.startsWith('state:'),
    ) ?? 'state:unknown';

  const telemetry = ((comments as unknown as { data?: Array<{ body?: string }> }).data ?? [])
    .map((c) => parseTelemetry(c.body ?? ''))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  // Best-effort PR link extraction from comments
  const prMatch = ((comments as unknown as { data?: Array<{ body?: string }> }).data ?? [])
    .map((c) => c.body?.match(/PR:\s*#(\d+)/))
    .find((m) => m);
  const prUrl = prMatch ? `https://github.com/${owner}/${name}/pull/${prMatch[1]}` : null;

  return (
    <FeatureDetail
      repo={`${owner}/${name}`}
      issue={{
        number: issue_number,
        title: issueData.title,
        body: issueData.body ?? '',
        html_url: issueData.html_url,
        state: stateLabel,
      }}
      telemetry={telemetry}
      prUrl={prUrl}
    />
  );
}
