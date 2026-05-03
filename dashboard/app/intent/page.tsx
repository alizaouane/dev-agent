import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { IntentForm } from '@/components/intent-form';

export default async function IntentPage() {
  const octokit = await getOctokit();
  // Drop-intent only makes sense for wired-up repos — there's no pipeline
  // to drop into otherwise.
  const repos = wiredRepos(await listAllowedRepos(octokit));
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Drop intent</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Creates a GitHub issue with <code>state:scoping</code>. To run the spec brainstorm, copy the
        <code> /develop &lt;url&gt; </code> command shown in the issue body and paste it into a Claude Code
        session in the target repo.
      </p>
      <IntentForm repos={repos} />
    </div>
  );
}
