import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { fetchPipeline } from '@/lib/pipeline';
import { PipelineBoard } from '@/components/pipeline-board';
import { PageHeader } from '@/components/ui/page-header';

export default async function PipelinePage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  // Pipeline only has data for wired-up repos — unwired repos have no
  // `state:*` issues yet by definition.
  const all = await fetchPipeline(octokit, wiredRepos(repos));
  return (
    <div>
      <PageHeader
        title="Pipeline"
        descriptor="Every in-flight feature, grouped by gate."
        helpTerm="pipeline-page"
      />
      <PipelineBoard items={all} />
    </div>
  );
}
