import { getOctokit } from '@/lib/gh';
import { listAllowedRepos } from '@/lib/repos';
import { fetchPipeline, needsActionFilter } from '@/lib/pipeline';
import { InboxList } from '@/components/inbox-list';

export default async function InboxPage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  const all = await fetchPipeline(octokit, repos);
  const needsAction = all.filter(needsActionFilter);
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Inbox</h1>
      <InboxList items={needsAction} />
    </div>
  );
}
