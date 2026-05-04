import Link from 'next/link';
import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { runAllScouts, type Proposal, type ProposalSource } from '@/lib/scout';

const SOURCE_LABEL: Record<ProposalSource, string> = {
  unfinished_plan: 'Unfinished plan item',
  stale_blocked_issue: 'Stale blocked issue',
  spec_drift: 'Spec/code drift',
  untriaged_issue: 'Untriaged issue',
};

/**
 * Proposals queue. Aggregates findings from every scout source across
 * every wired-up repo, grouped into:
 *   - **Carry-over commitments** — work the user already committed to
 *     and hasn't finished. Ranked above new ideas because deciding to
 *     finish what you started is cheaper than deciding to start
 *     something new.
 *   - **New ideas** — net-new work the user hasn't seen yet (untriaged
 *     issue reports, future scout sources).
 *
 * Each proposal links to the underlying GitHub artifact (plan file,
 * issue, etc.) and offers a "Discuss with PM" button that pre-loads
 * the brainstorm chat with the proposal text so the user can decide
 * whether to ship it.
 */
export default async function ProposalsPage() {
  const octokit = await getOctokit();
  const repos = wiredRepos(await listAllowedRepos(octokit));

  if (repos.length === 0) {
    return (
      <div>
        <h1 className="mb-2 text-2xl font-semibold">Proposals</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          The PM agent watches your wired-up repos for unfinished work and untriaged issues.
        </p>
        <p className="text-sm">
          Wire up at least one repo on{' '}
          <Link href="/repos" className="underline">
            /repos
          </Link>{' '}
          to start seeing proposals.
        </p>
      </div>
    );
  }

  const proposals = await runAllScouts(octokit, repos);
  const carryOver = proposals.filter((p) => p.group === 'carry_over');
  const newIdeas = proposals.filter((p) => p.group === 'new_idea');

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Proposals</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        What the PM agent thinks you should consider doing next, scanned across your{' '}
        {repos.length} wired-up{' '}
        {repos.length === 1 ? 'repo' : 'repos'}. Carry-over commitments rank above new ideas —
        finishing what&apos;s already in motion is usually higher leverage than starting
        something new.
      </p>

      {proposals.length === 0 ? (
        <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          Nothing in the queue. Either you&apos;re caught up — or the PM doesn&apos;t see
          enough signal yet (no plans with unchecked items, no untriaged issues).
        </div>
      ) : (
        <>
          <Section
            title="Carry-over commitments"
            description="Work you already started or committed to. Finish these before starting something new."
            proposals={carryOver}
          />
          <Section
            title="New ideas"
            description="Things you haven't decided on yet. Discuss with the PM to figure out if they're worth doing."
            proposals={newIdeas}
          />
        </>
      )}
    </div>
  );
}

function Section({
  title,
  description,
  proposals,
}: {
  title: string;
  description: string;
  proposals: Proposal[];
}) {
  if (proposals.length === 0) return null;
  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold">
        {title} ({proposals.length})
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">{description}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {proposals.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {SOURCE_LABEL[p.source]}
                </span>
                <span className="text-xs text-muted-foreground">{p.repo}</span>
              </div>
              <a
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block font-medium text-foreground hover:underline"
              >
                {p.title}
              </a>
              <p className="mt-1 text-sm text-muted-foreground">{p.description}</p>
            </div>
            <div className="shrink-0">
              <Link
                href={`/intent?prefill=${encodeURIComponent(buildPmPrefill(p))}&repo=${encodeURIComponent(p.repo)}`}
                className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
              >
                Discuss with PM
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Format the proposal as a one-paragraph pitch the user (or the PM
 * agent reading it) can react to. Keeps it short — the PM chat will
 * fetch the full context (pm.md, pipeline) on the first turn anyway.
 */
function buildPmPrefill(p: Proposal): string {
  return `${SOURCE_LABEL[p.source]} in ${p.repo}: ${p.title}. ${p.description} (${p.url})`;
}
