import { getOctokit } from '@/lib/gh';
import { listAllowedRepos } from '@/lib/repos';
import { fetchPipeline } from '@/lib/pipeline';
import { InboxList } from '@/components/inbox-list';

export default async function RepoPage(props: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await props.params;
  const name = decodeURIComponent(rawName);
  const octokit = await getOctokit();
  const allRepos = await listAllowedRepos(octokit);
  const repo = allRepos.find((r) => `${r.owner}/${r.name}` === name);
  if (!repo) {
    return <p className="text-muted-foreground">Repo not found in allowlist.</p>;
  }
  const items = await fetchPipeline(octokit, [repo], { include_terminal: true });
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">{name}</h1>
      <InboxList items={items} />
    </div>
  );
}
