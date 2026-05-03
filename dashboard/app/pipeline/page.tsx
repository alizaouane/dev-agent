import { getOctokit } from '@/lib/gh';
import { listAllowedRepos } from '@/lib/repos';
import { fetchPipeline } from '@/lib/pipeline';
import { PipelineBoard } from '@/components/pipeline-board';

export default async function PipelinePage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  const all = await fetchPipeline(octokit, repos);
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Pipeline</h1>
      <PipelineBoard items={all} />
    </div>
  );
}
