import Link from 'next/link';
import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { runAllScouts } from '@/lib/scout';
import { loadHomeBands } from '@/lib/dashboard/home-bands';
import { Button } from '@/components/ui/button';
import { FeatureCard } from '@/components/feature-card';
import { RepoCard } from '@/components/repo-card';
import { VerificationPostureStrip } from '@/components/verification-posture-strip';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Term } from '@/components/ui/term';

export default async function HomePage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  const wired = wiredRepos(repos);

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

  const [bands, proposals] = await Promise.all([
    loadHomeBands(octokit, wired),
    runAllScouts(octokit, wired).catch(() => []),
  ]);
  const topProposals = proposals.slice(0, 5);

  return (
    <div className="flex flex-col gap-10">
      {/* Band 1 — Hero */}
      <PageHeader
        title="Home"
        descriptor={
          bands.hero.state === 'wired'
            ? bands.hero.message
            : 'Everything that needs you across your wired repos.'
        }
        helpTerm="home-page"
        actions={
          <Link href="/intent" data-no-style>
            <Button variant="accent" size="lg">Brainstorm new work</Button>
          </Link>
        }
      />

      {/* Band 2 — Needs you */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
          Needs you now
          <Term k="needs-you-now" variant="icon" />
        </h2>
        {bands.needsAction.length === 0 ? (
          <EmptyState title="Nothing waiting on you — nice." body="" />
        ) : (
          <div className="flex flex-col gap-2">
            {bands.needsAction.map((i) => (
              <FeatureCard key={`${i.repo}#${i.issue_number}`} item={i} />
            ))}
          </div>
        )}
      </section>

      {/* Band 3 — In motion */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
          In motion
          <Term k="in-motion" variant="icon" />
        </h2>
        {bands.inMotion.length === 0 ? (
          <EmptyState
            title="No active runs."
            body="Start one with Brainstorm new work or pick from PM proposes below."
            cta={{ label: 'Brainstorm', href: '/intent' }}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {bands.inMotion.map((i) => (
              <FeatureCard key={`${i.repo}#${i.issue_number}`} item={i} />
            ))}
          </div>
        )}
      </section>

      {/* Band 4 — Recently shipped */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
          Recently shipped (last 7d)
          <Term k="recently-shipped" variant="icon" />
        </h2>
        {bands.recentlyShipped.length === 0 ? (
          <EmptyState
            title="No features shipped in the last 7 days."
            body="Once a feature merges, it lands here with verification badges."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {bands.recentlyShipped.map((i) => (
              <FeatureCard key={`${i.repo}#${i.issue_number}`} item={i} />
            ))}
          </div>
        )}
      </section>

      {/* Band 5 — PM proposes */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            PM proposes
            <Term k="pm-proposes" variant="icon" />
          </h2>
          <Link href="/proposals" className="text-sm underline">
            See all ({proposals.length})
          </Link>
        </div>
        {topProposals.length === 0 ? (
          <EmptyState
            title="PM has nothing to suggest."
            body="Either you're caught up, or no scout sources are wired yet."
          />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {topProposals.map((p) => (
              <li key={p.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{p.source}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{p.repo}</span>
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="mt-1 block font-medium hover:underline">
                    {p.title}
                  </a>
                </div>
                <Link
                  href={`/intent?repo=${encodeURIComponent(p.repo)}&prefill=${encodeURIComponent(p.title)}`}
                  className="text-sm underline"
                >
                  Discuss with PM
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Band 6 — Verification posture */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
          Verification posture
          <Term k="verification-posture" variant="icon" />
        </h2>
        <VerificationPostureStrip rollup={bands.posture} />
      </section>

      {/* Band 7 — Repo summary cards */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Your repos</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {bands.repoSummaries.map((s) => (
            <RepoCard key={s.repo} {...s} />
          ))}
        </div>
      </section>
    </div>
  );
}
