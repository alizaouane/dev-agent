import Link from 'next/link';
import { getCurrentUsername, getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { runAllScouts, type Proposal, type ProposalSource } from '@/lib/scout';
import { partitionBySnooze } from '@/lib/scout/snooze';
import { snoozeProposal, unsnoozeProposal } from '@/lib/actions';

const SOURCE_LABEL: Record<ProposalSource, string> = {
  unfinished_plan: 'Unfinished plan item',
  stale_blocked_issue: 'Stale blocked issue',
  spec_drift: 'Spec/code drift',
  pending_spec: 'Pending spec',
  bug_scout_finding: 'Bug-scout finding',
  unfinished_work_finding: 'Unfinished work (PM scan)',
  competitor_watch: 'Competitor to review',
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
 * issue, etc.) and offers two affordances:
 *  - **Discuss with PM** → pre-loads /intent with this proposal as the
 *    pitch. Use when you want to engage with it.
 *  - **Snooze 7d** → moves the proposal to a collapsed "Snoozed" section
 *    so it stops appearing on every page load. Use when you've decided
 *    "not now" but don't want to dismiss the underlying artifact.
 *
 * Query params:
 *  - `?show_snoozed=1` — render the snoozed section (default hidden)
 */
export default async function ProposalsPage(props: {
  searchParams: Promise<{ show_snoozed?: string }>;
}) {
  const octokit = await getOctokit();
  const repos = wiredRepos(await listAllowedRepos(octokit));
  const { show_snoozed } = await props.searchParams;
  const showSnoozed = show_snoozed === '1';

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

  const username = await getCurrentUsername();
  const proposals = await runAllScouts(octokit, repos);
  const { active, snoozed } = partitionBySnooze(username, proposals);
  const carryOver = active.filter((p) => p.group === 'carry_over');
  const newIdeas = active.filter((p) => p.group === 'new_idea');

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Proposals</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        What the PM agent thinks you should consider doing next, scanned across your{' '}
        {repos.length} wired-up{' '}
        {repos.length === 1 ? 'repo' : 'repos'}. Carry-over commitments rank above new ideas —
        finishing what&apos;s already in motion is usually higher leverage than starting
        something new. Snooze anything you&apos;ve decided &ldquo;not now&rdquo; on to keep
        the list tight.
      </p>

      {active.length === 0 ? (
        <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          Nothing in the active queue.
          {snoozed.length > 0 ? (
            <>
              {' '}
              {snoozed.length} snoozed{' '}
              {snoozed.length === 1 ? 'proposal' : 'proposals'} —{' '}
              <Link
                href="/proposals?show_snoozed=1"
                className="underline"
              >
                review them
              </Link>
              .
            </>
          ) : (
            <>
              {' '}
              Either you&apos;re caught up — or the PM doesn&apos;t see enough signal yet
              (no plans with unchecked items, no untriaged issues).
            </>
          )}
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

      {snoozed.length > 0 ? (
        <div className="mt-10 border-t border-border pt-6">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {snoozed.length} snoozed{' '}
              {snoozed.length === 1 ? 'proposal' : 'proposals'}.
            </p>
            <Link
              href={showSnoozed ? '/proposals' : '/proposals?show_snoozed=1'}
              className="text-sm underline"
            >
              {showSnoozed ? 'Hide snoozed' : 'Show snoozed'}
            </Link>
          </div>
          {showSnoozed ? (
            <Section
              title="Snoozed"
              description="Hidden until you un-snooze or the 7-day timer expires."
              proposals={snoozed}
              snoozedView
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  description,
  proposals,
  snoozedView = false,
}: {
  title: string;
  description: string;
  proposals: Proposal[];
  snoozedView?: boolean;
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
          <li
            key={p.id}
            className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between"
          >
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
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {snoozedView ? (
                <form action={unsnoozeProposal}>
                  <input type="hidden" name="proposal_id" value={p.id} />
                  <button
                    type="submit"
                    className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
                  >
                    Un-snooze
                  </button>
                </form>
              ) : (
                <>
                  <Link
                    href={`/intent?prefill=${encodeURIComponent(buildPmPrefill(p))}&repo=${encodeURIComponent(p.repo)}`}
                    className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
                  >
                    Discuss with PM
                  </Link>
                  <form action={snoozeProposal}>
                    <input type="hidden" name="proposal_id" value={p.id} />
                    <button
                      type="submit"
                      className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
                    >
                      Snooze 7d
                    </button>
                  </form>
                </>
              )}
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
