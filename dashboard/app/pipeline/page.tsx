import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { fetchPipeline } from '@/lib/pipeline';
import { PipelineBoard } from '@/components/pipeline-board';

export default async function PipelinePage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  // Pipeline only has data for wired-up repos — unwired repos have no
  // `state:*` issues yet by definition.
  const all = await fetchPipeline(octokit, wiredRepos(repos));
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Pipeline</h1>
      <PipelineBoard items={all} />
    </div>
  );
}
