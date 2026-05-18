import Link from 'next/link';
import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { runAllScouts, type Proposal, type ProposalSource } from '@/lib/scout';
import { enrichProposalsWithFreshness, type FreshnessHint } from '@/lib/scout/freshness';
import { loadSnoozeMap, partitionBySnooze } from '@/lib/scout/snooze';
import { resolveProposalAction, snoozeProposal, unsnoozeProposal } from '@/lib/actions';
import {
  categorizeProposals,
  categorizationCacheKey,
  getCachedCategorization,
  setCachedCategorization,
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  PROPOSAL_CATEGORIES,
  type ProposalCategory,
} from '@/lib/categorize-proposals';

const SOURCE_LABEL: Record<ProposalSource, string> = {
  unfinished_plan: 'Unfinished plan item',
  stale_blocked_issue: 'Stale blocked issue',
  spec_drift: 'Spec/code drift',
  pending_spec: 'Pending spec',
  bug_scout_finding: 'Bug-scout finding',
  unfinished_work_finding: 'Unfinished work (PM scan)',
  cleanup_finding: 'Cleanup proposal',
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
  searchParams: Promise<{ show_snoozed?: string; repo?: string }>;
}) {
  const octokit = await getOctokit();
  const repos = wiredRepos(await listAllowedRepos(octokit));
  const { show_snoozed, repo: repoParam } = await props.searchParams;
  const showSnoozed = show_snoozed === '1';

  // When `?repo=owner/name` matches a wired repo, scope the whole page to
  // it: scouts run for one repo (fast) and only its proposals show. A
  // `repo` param that doesn't match a wired repo falls back to the
  // all-repos view with a notice rather than erroring.
  const scopedRepo = repoParam
    ? repos.find((r) => `${r.owner}/${r.name}` === repoParam)
    : undefined;
  const scopedRepos = scopedRepo ? [scopedRepo] : repos;
  const repoParamUnmatched = Boolean(repoParam) && !scopedRepo;

  // Preserve repo scoping across the snoozed toggle.
  const repoQuery = scopedRepo
    ? `repo=${encodeURIComponent(`${scopedRepo.owner}/${scopedRepo.name}`)}`
    : '';
  const showSnoozedHref = repoQuery
    ? `/proposals?${repoQuery}&show_snoozed=1`
    : '/proposals?show_snoozed=1';
  const hideSnoozedHref = repoQuery ? `/proposals?${repoQuery}` : '/proposals';

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

  // Run scouts + load persistent snoozes in parallel — both pay
  // network for ~the same few hundred ms; serial would double the wait.
  // Snoozes are read from each consumer repo's `.dev-agent/pm.md`
  // frontmatter so they survive Vercel cold starts.
  const [proposals, snoozeMap] = await Promise.all([
    runAllScouts(octokit, scopedRepos),
    loadSnoozeMap(octokit, scopedRepos),
  ]);
  const { active, snoozed } = partitionBySnooze(proposals, snoozeMap);
  const carryOver = active.filter((p) => p.group === 'carry_over');
  const newIdeas = active.filter((p) => p.group === 'new_idea');

  // Freshness check: per-source deterministic heuristics that flag
  // proposals already addressed elsewhere (merged PR mentions the spec,
  // file modified after the bug-scout issue was filed, etc.). Hinted
  // proposals render dimmed with a "Likely already done" pill; the
  // user still has to click Resolve. Only applied to active proposals
  // — snoozed rows are off the user's radar by definition.
  const freshnessMap = await enrichProposalsWithFreshness(octokit, active);

  // PM-driven categorization. The LLM groups proposals into themes
  // (cleanup / implementation / tech_debt / investigation) so the user
  // can read the queue by topic instead of chronologically. Cached for
  // 30 min keyed on the proposal-set hash so reloads are free.
  let categories: Map<string, ProposalCategory> | null = null;
  let categorizationCacheHit = false;
  const dashboardKeySet = Boolean(process.env.ANTHROPIC_API_KEY);
  if (active.length > 0 && dashboardKeySet) {
    const key = categorizationCacheKey(active);
    const cached = getCachedCategorization(key);
    if (cached) {
      categories = cached;
      categorizationCacheHit = true;
    } else {
      categories = await categorizeProposals(active);
      if (categories) setCachedCategorization(key, categories);
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">
        {scopedRepo ? `Proposals · ${scopedRepo.owner}/${scopedRepo.name}` : 'Proposals'}
      </h1>
      {repoParamUnmatched ? (
        <p className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <code>{repoParam}</code> isn&apos;t a wired-up repo — showing all repos instead.
        </p>
      ) : null}
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        {scopedRepo ? (
          <>
            What the PM agent thinks you should consider doing next in{' '}
            <code>{scopedRepo.owner}/{scopedRepo.name}</code>.{' '}
            <Link href="/proposals" className="underline">View all repos</Link>.
          </>
        ) : (
          <>
            What the PM agent thinks you should consider doing next, scanned across your{' '}
            {repos.length} wired-up {repos.length === 1 ? 'repo' : 'repos'}. Carry-over
            commitments rank above new ideas — finishing what&apos;s already in motion is
            usually higher leverage than starting something new. Snooze anything you&apos;ve
            decided &ldquo;not now&rdquo; on to keep the list tight.
          </>
        )}
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
                href={showSnoozedHref}
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
      ) : categories ? (
        <>
          <p className="mb-4 text-xs text-muted-foreground">
            Grouped by theme by the PM agent
            {categorizationCacheHit ? ' (cached, regenerates when the queue changes or after 30 min)' : ''}.
            Carry-over commitments still rank above new ideas within each theme.
          </p>
          {PROPOSAL_CATEGORIES.map((cat) => {
            const items = active
              .filter((p) => categories?.get(p.id) === cat)
              .sort((a, b) => {
                // Carry-over above new-idea within a category (preserves
                // the existing "finish what you started" prioritization).
                if (a.group !== b.group) return a.group === 'carry_over' ? -1 : 1;
                return 0;
              });
            return (
              <Section
                key={cat}
                title={CATEGORY_LABELS[cat]}
                description={CATEGORY_DESCRIPTIONS[cat]}
                proposals={items}
                freshnessMap={freshnessMap}
              />
            );
          })}
        </>
      ) : (
        <>
          {/* Categorization unavailable (no API key, or LLM fail). Fall
              back to the original carry-over / new-ideas grouping. */}
          <Section
            title="Carry-over commitments"
            description="Work you already started or committed to. Finish these before starting something new."
            proposals={carryOver}
            freshnessMap={freshnessMap}
          />
          <Section
            title="New ideas"
            description="Things you haven't decided on yet. Discuss with the PM to figure out if they're worth doing."
            proposals={newIdeas}
            freshnessMap={freshnessMap}
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
              href={showSnoozed ? hideSnoozedHref : showSnoozedHref}
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
  freshnessMap,
}: {
  title: string;
  description: string;
  proposals: Proposal[];
  snoozedView?: boolean;
  /**
   * Optional per-proposal freshness hints. When present, hinted
   * proposals render dimmed with a "Likely already done" pill above
   * the title. Snoozed sections don't pass this — those rows are off
   * the user's radar by definition.
   */
  freshnessMap?: Map<string, FreshnessHint>;
}) {
  if (proposals.length === 0) return null;
  return (
    // Native <details> gives per-section collapse with zero JS, zero
    // hydration cost, and accessible disclosure semantics. Default
    // `open` so the page reads the same as before on first paint;
    // user clicks the summary to fold up sections they don't want to
    // scan right now.
    //
    // **Accessibility note (PR #69 review):** an <h2> nested inside
    // <summary> can drop its heading role in some browser/screen-reader
    // combinations because <summary> exposes itself as a button and
    // child heading roles are sometimes flattened. To preserve
    // heading-by-heading navigation (rotor / list-of-headings), we
    // render a real <h2> OUTSIDE the <details> as a sibling sr-only
    // element — sighted users see the styled span inside the summary;
    // AT users navigating by headings still find the section. The
    // visible label is just a span styled to look like an h2.
    <section className="mb-10">
      <h2 className="sr-only">
        {title} ({proposals.length})
      </h2>
      <details open className="group">
        <summary className="mb-4 flex cursor-pointer list-none items-baseline justify-between gap-3 select-none rounded-md px-2 py-1 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <div className="min-w-0 flex-1">
            <span className="block text-lg font-semibold">
              {title} ({proposals.length})
            </span>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
          <span
            aria-hidden="true"
            className="shrink-0 self-center text-muted-foreground transition-transform duration-150 group-open:rotate-90"
          >
            ▶
          </span>
        </summary>
      <ul className="divide-y divide-border rounded-md border border-border">
        {proposals.map((p) => {
          const hint = freshnessMap?.get(p.id);
          return (
          <li
            key={p.id}
            data-likely-done={hint ? 'true' : undefined}
            className={`flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between ${
              hint ? 'opacity-60' : ''
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {SOURCE_LABEL[p.source]}
                </span>
                <span className="text-xs text-muted-foreground">{p.repo}</span>
                {hint ? (
                  <span
                    className="rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
                    title={hint.reason}
                  >
                    Likely already done — {hint.reason}
                  </span>
                ) : null}
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
                  {resolveLabel(p) ? (
                    <form action={resolveProposalAction}>
                      <input type="hidden" name="proposal_id" value={p.id} />
                      {/* Source-specific meta — only the relevant fields are
                          read by the action; the rest are ignored. Sending
                          all of them keeps the form template small. */}
                      {p.meta?.plan_file ? (
                        <input
                          type="hidden"
                          name="meta_plan_file"
                          value={String(p.meta.plan_file)}
                        />
                      ) : null}
                      {p.meta?.line ? (
                        <input
                          type="hidden"
                          name="meta_line"
                          value={String(p.meta.line)}
                        />
                      ) : null}
                      {p.meta?.spec_path ? (
                        <input
                          type="hidden"
                          name="meta_spec_path"
                          value={String(p.meta.spec_path)}
                        />
                      ) : null}
                      <button
                        type="submit"
                        className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
                      >
                        {resolveLabel(p)}
                      </button>
                    </form>
                  ) : null}
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
          );
        })}
        </ul>
      </details>
    </section>
  );
}

/**
 * Per-source button label for the Resolve action. Returns `null` when
 * Resolve isn't wired for this source (the row hides the button entirely
 * — Snooze is still the right move there). Rolled-up plan entries
 * (`unfinished_plan` without a `#L<n>` suffix) also return null since
 * we can't safely flip every checkbox in a long file.
 */
function resolveLabel(p: Proposal): string | null {
  switch (p.source) {
    case 'unfinished_plan':
      // Rolled-up entry has no per-line anchor — let the user open the
      // file and check items individually instead of one click flipping
      // 60 boxes.
      return p.id.includes('#L') ? 'Mark done' : null;
    case 'pending_spec':
      return 'File as scoping issue';
    case 'bug_scout_finding':
    case 'unfinished_work_finding':
    case 'cleanup_finding':
    case 'untriaged_issue':
      return 'Close issue';
    case 'spec_drift':
    case 'competitor_watch':
    case 'stale_blocked_issue':
      // Deferred to v2 — Snooze covers the immediate "I'm done with this
      // for now" case; Resolve for these sources needs source-specific
      // semantics we haven't designed yet.
      return null;
    default: {
      // Exhaustiveness check: TypeScript will narrow `p.source` to
      // `never` here; if a new source is added without updating this
      // switch, this branch becomes dead and the switch becomes
      // exhaustive again.
      const _exhaustive: never = p.source;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Format the proposal as a one-paragraph pitch the user (or the PM
 * agent reading it) can react to. Keeps it short — the PM chat will
 * fetch the full context (pm.md, pipeline) on the first turn anyway.
 */
function buildPmPrefill(p: Proposal): string {
  return `${SOURCE_LABEL[p.source]} in ${p.repo}: ${p.title}. ${p.description} (${p.url})`;
}
