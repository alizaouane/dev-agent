import Link from 'next/link';
import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, type RepoInfo } from '@/lib/repos';
import { WireUpButton } from '@/components/wire-up-button';

/**
 * Repos index. The on-ramp for new consumers: shows every repo the user can
 * see, split into "wired up" (has .dev-agent.yml on the default branch) and
 * "available to wire up" (everything else). The latter group has a one-click
 * action that drops the web-app-template files into the repo via PR.
 */
export default async function ReposPage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  // Surfaced server-side so the page can warn before the user clicks
  // "Wire up dev-agent" — the auto-push of ANTHROPIC_API_KEY only works
  // when the dashboard itself has the key in its env. Without this hint,
  // a user wiring up their first repo would only learn the secret wasn't
  // auto-pushed by reading the resulting PR body.
  const dashboardKeySet = Boolean(process.env.ANTHROPIC_API_KEY);

  const wired = repos.filter((r) => r.wired_up);
  const unwired = repos.filter((r) => !r.wired_up);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Repositories</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Every GitHub repo you can access. Wire up dev-agent on a repo to start filing
        issues that the agent picks up automatically.
      </p>

      {!dashboardKeySet && repos.length > 0 ? (
        <div className="mb-6 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
          <p className="font-medium">Heads up: <code>ANTHROPIC_API_KEY</code> isn&apos;t set on this dashboard yet.</p>
          <p className="mt-1 text-muted-foreground">
            Wiring up a repo will still create the PR, but you&apos;ll need to add the key as a repo
            secret manually after merge. Set <code>ANTHROPIC_API_KEY</code> on the dashboard&apos;s
            environment (Vercel → Settings → Environment Variables) to enable auto-push for every
            future wire-up.
          </p>
        </div>
      ) : null}

      {repos.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <RepoSection
            title={`Wired up (${wired.length})`}
            description="These repos have .dev-agent.yml at the default branch. Issues you file with state:* labels here flow through the pipeline."
            repos={wired}
            wired
          />
          <RepoSection
            title={`Available to wire up (${unwired.length})`}
            description="These repos are accessible to your GitHub token but don't have dev-agent yet. Wire-up commits the template config + workflow directly to the default branch — no PR review noise."
            repos={unwired}
            wired={false}
          />
        </>
      )}
    </div>
  );
}

function RepoSection({
  title,
  description,
  repos,
  wired,
}: {
  title: string;
  description: string;
  repos: RepoInfo[];
  wired: boolean;
}) {
  if (repos.length === 0) return null;
  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold">{title}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{description}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {repos.map((r) => (
          <li key={`${r.owner}/${r.name}`} className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {wired ? (
                  <Link
                    href={`/repos/${encodeURIComponent(`${r.owner}/${r.name}`)}`}
                    className="truncate font-medium text-foreground hover:underline"
                  >
                    {r.owner}/{r.name}
                  </Link>
                ) : (
                  <a
                    href={r.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate font-medium text-foreground hover:underline"
                  >
                    {r.owner}/{r.name}
                  </a>
                )}
                <span className="text-xs text-muted-foreground">{r.default_branch}</span>
              </div>
              {r.description ? (
                <p className="mt-1 truncate text-sm text-muted-foreground">{r.description}</p>
              ) : null}
            </div>
            {wired ? (
              <Link
                href={`/repos/${encodeURIComponent(`${r.owner}/${r.name}`)}`}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
              >
                View
              </Link>
            ) : (
              <WireUpButton owner={r.owner} repo={r.name} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="rounded-md border border-border bg-card p-8 text-center">
      <h2 className="mb-2 text-lg font-semibold">No repos visible</h2>
      <p className="mx-auto mb-4 max-w-md text-sm text-muted-foreground">
        Your GitHub token doesn&apos;t list any repositories. The most common causes:
      </p>
      <ul className="mx-auto mb-6 max-w-md list-disc text-left text-sm text-muted-foreground">
        <li>The OAuth scope is missing <code>repo</code> — sign out and back in.</li>
        <li>
          <code>ALLOWED_GH_USERNAMES</code> or <code>ALLOWED_GH_ORGS</code> is set on the
          deployment but excludes you. Check the dashboard environment.
        </li>
      </ul>
    </div>
  );
}
