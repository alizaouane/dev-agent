import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { fetchPipeline } from '@/lib/pipeline';
import { ActivityFeed } from '@/components/activity-feed';
import { PageHeader } from '@/components/ui/page-header';

export default async function ActivityPage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  const items = await fetchPipeline(octokit, wiredRepos(repos), { include_terminal: true });
  return (
    <div>
      <PageHeader
        title="Activity"
        descriptor="Audit log of everything dev-agent did recently."
        helpTerm="activity-page"
      />
      <ActivityFeed items={items} />
    </div>
  );
}
