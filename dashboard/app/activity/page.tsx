import { getOctokit } from '@/lib/gh';
import { listAllowedRepos } from '@/lib/repos';
import { fetchPipeline } from '@/lib/pipeline';
import { ActivityFeed } from '@/components/activity-feed';

export default async function ActivityPage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  const items = await fetchPipeline(octokit, repos, { include_terminal: true });
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Activity</h1>
      <ActivityFeed items={items} />
    </div>
  );
}
