import Link from 'next/link';
import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { fetchPipeline, needsActionFilter } from '@/lib/pipeline';
import { InboxList } from '@/components/inbox-list';

export default async function InboxPage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  const wired = wiredRepos(repos);

  // First-run UX: if no repos are wired up yet, send the user to /repos to
  // onboard one rather than showing an empty inbox with no path forward.
  if (wired.length === 0) {
    return (
      <div className="mx-auto max-w-2xl py-12 text-center">
        <h1 className="mb-2 text-2xl font-semibold">Welcome to dev-agent</h1>
        <p className="mb-6 text-muted-foreground">
          {repos.length === 0
            ? "We don't see any GitHub repos for your account yet. Make sure your token includes the repo scope."
            : `You have ${repos.length} repo${repos.length === 1 ? '' : 's'} accessible, but none are wired up to dev-agent yet.`}
        </p>
        <Link
          href="/repos"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {repos.length === 0 ? 'See my repos' : 'Wire up your first repo'}
        </Link>
      </div>
    );
  }

  const all = await fetchPipeline(octokit, wired);
  const needsAction = all.filter(needsActionFilter);
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Inbox</h1>
      <InboxList items={needsAction} />
    </div>
  );
}
