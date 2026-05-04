import Link from 'next/link';
import { getOctokit, getCurrentUsername } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { runAllScouts, type Proposal } from '@/lib/scout';
import { recommendNext } from '@/lib/recommend-next';

/**
 * In-memory TTL cache for the PM recommendation, keyed by username +
 * the set of proposal ids currently in the queue.
 *
 * Why in-memory: Next.js' `unstable_cache` runs callbacks in an
 * isolated scope that can't access cookies/headers (so it can't reach
 * the user's session via `getOctokit()`). The single-user deployment
 * shape here means a module-scope Map is enough to dedupe rapid
 * refreshes within a warm Vercel instance — cold starts evict, which
 * is fine. Multi-tenant later: swap to a session-aware backing store.
 */
type CacheEntry = { recommendation: string; expires: number };
const RECOMMENDATION_CACHE = new Map<string, CacheEntry>();
const RECOMMENDATION_TTL_MS = 30 * 60 * 1000;

function cacheKey(username: string, proposals: Proposal[]): string {
  // Sort to make the key invariant under proposal-list order changes.
  // Two visits with the same set of items dedupe even if scout sources
  // run in different orders.
  const ids = [...proposals.map((p) => p.id)].sort().join('|');
  return `${username}::${ids}`;
}

/**
 * "What should I do next?" — PM agent picks a single highest-value item
 * from the proposal queue and explains why, with effort estimate and
 * the single risk to watch.
 *
 * Server-rendered: the recommendation is computed on every page load.
 * That's a non-trivial Anthropic call (~$0.05–0.15 depending on queue
 * size), so this page is meant to be hit deliberately when the user
 * wants direction, not as a default landing page. Caching is a
 * follow-up enhancement (Phase 3.5+).
 */
export default async function NextPage() {
  const octokit = await getOctokit();
  const repos = wiredRepos(await listAllowedRepos(octokit));
  const dashboardKeySet = Boolean(process.env.ANTHROPIC_API_KEY);

  if (repos.length === 0) {
    return <NoReposState />;
  }
  if (!dashboardKeySet) {
    return <NoApiKeyState />;
  }

  const proposals = await runAllScouts(octokit, repos);

  let recommendation: string | null = null;
  let recommendationError: string | null = null;
  let cacheHit = false;

  const username = await getCurrentUsername();
  const key = cacheKey(username, proposals);
  const now = Date.now();
  const cached = RECOMMENDATION_CACHE.get(key);
  if (cached && cached.expires > now) {
    recommendation = cached.recommendation;
    cacheHit = true;
  } else {
    try {
      recommendation = await recommendNext({ octokit, wiredRepos: repos, proposals });
      RECOMMENDATION_CACHE.set(key, {
        recommendation,
        expires: now + RECOMMENDATION_TTL_MS,
      });
    } catch (err) {
      recommendationError = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">What should I do next?</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        The PM agent reads your <code>pm.md</code> goals, what&apos;s in flight, and the
        proposal queue (
        <Link href="/proposals" className="underline">
          /proposals
        </Link>
        ) and picks a single thing worth doing. If you disagree, head to{' '}
        <Link href="/intent" className="underline">
          /intent
        </Link>{' '}
        to argue with it.
      </p>

      {recommendationError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <p className="font-medium">PM call failed</p>
          <p className="mt-1 text-muted-foreground">{recommendationError}</p>
        </div>
      ) : null}

      {recommendation ? (
        <>
          {cacheHit ? (
            <p className="mb-2 text-xs text-muted-foreground">
              Cached. The PM regenerates a fresh recommendation when the proposal queue
              changes or after 30 min, whichever comes first.
            </p>
          ) : null}
          <article className="prose prose-sm max-w-2xl rounded-md border border-border bg-card p-6 dark:prose-invert">
          {/* The PM is prompted to emit `### Recommendation` / `### Why`
              / `### Effort` / `### Watch out for` headings — we render
              them as plain markdown text. A future enhancement could
              parse the structure and render each section as a styled
              card; for now the user gets clean readable markdown. */}
          <Markdown text={recommendation} />
          </article>
        </>
      ) : null}

      <div className="mt-6">
        <Link
          href="/intent"
          className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Discuss with PM
        </Link>
      </div>
    </div>
  );
}

/**
 * Minimal markdown renderer. Splits on newlines, recognizes headings,
 * blockquotes, and bullet lists. Avoids a full markdown parser dep —
 * the PM's output structure is constrained by the prompt and we
 * don't need general markdown features.
 */
function Markdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: React.ReactElement[] = [];
  let listItems: string[] = [];

  function flushList() {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {listItems.map((it, i) => (
          <li key={i}>{renderInline(it)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const Tag = (`h${Math.min(level + 2, 6)}`) as keyof React.JSX.IntrinsicElements;
      blocks.push(<Tag key={blocks.length}>{renderInline(heading[2])}</Tag>);
      continue;
    }
    if (line.startsWith('> ')) {
      flushList();
      blocks.push(
        <blockquote key={blocks.length}>{renderInline(line.slice(2))}</blockquote>,
      );
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      listItems.push(bullet[1]);
      continue;
    }
    flushList();
    blocks.push(<p key={blocks.length}>{renderInline(line)}</p>);
  }
  flushList();
  return <>{blocks}</>;
}

/**
 * Tiny inline formatter: `**bold**` and `` `code` ``. Anything else is
 * passed through as text. Keeps the PM output readable without
 * pulling in a markdown library.
 */
function renderInline(text: string): React.ReactNode {
  // Pre-split into segments alternating between text / code / bold to
  // avoid double-applying transformations on overlapping ranges.
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let i = 0;
  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);
    const codeIdx = codeMatch ? codeMatch.index ?? Infinity : Infinity;
    const boldIdx = boldMatch ? boldMatch.index ?? Infinity : Infinity;
    if (codeIdx === Infinity && boldIdx === Infinity) {
      parts.push(<span key={i++}>{remaining}</span>);
      break;
    }
    if (codeIdx <= boldIdx && codeMatch) {
      if (codeIdx > 0) parts.push(<span key={i++}>{remaining.slice(0, codeIdx)}</span>);
      parts.push(<code key={i++}>{codeMatch[1]}</code>);
      remaining = remaining.slice(codeIdx + codeMatch[0].length);
    } else if (boldMatch) {
      if (boldIdx > 0) parts.push(<span key={i++}>{remaining.slice(0, boldIdx)}</span>);
      parts.push(<strong key={i++}>{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldIdx + boldMatch[0].length);
    } else {
      parts.push(<span key={i++}>{remaining}</span>);
      break;
    }
  }
  return <>{parts}</>;
}

function NoReposState() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">What should I do next?</h1>
      <p className="text-sm text-muted-foreground">
        Wire up at least one repo on{' '}
        <Link href="/repos" className="underline">
          /repos
        </Link>{' '}
        before the PM can recommend anything.
      </p>
    </div>
  );
}

function NoApiKeyState() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">What should I do next?</h1>
      <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
        <p className="font-medium">
          <code>ANTHROPIC_API_KEY</code> is not configured on the dashboard.
        </p>
        <p className="mt-1 text-muted-foreground">
          Set it on Vercel &rarr; Settings &rarr; Environment Variables (Production), then
          redeploy.
        </p>
      </div>
    </div>
  );
}
