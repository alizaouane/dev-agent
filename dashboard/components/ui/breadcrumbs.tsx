'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

export type Crumb = { label: string; href?: string };

/** Pure function — derives the crumb trail for a given pathname.
 *  Returns [] for routes that should render no breadcrumb. */
export function crumbsForPath(pathname: string, repoQuery: string | null): Crumb[] {
  // Top-level routes: no breadcrumb
  const TOP_LEVEL = new Set([
    '/',
    '/repos',
    '/pipeline',
    '/proposals',
    '/activity',
    '/cost',
  ]);
  if (TOP_LEVEL.has(pathname)) return [];

  // /intent — only render a breadcrumb if scoped to a repo via ?repo=
  if (pathname === '/intent') {
    if (!repoQuery) return [];
    return [
      { label: 'Home', href: '/' },
      { label: 'Brainstorm', href: '/intent' },
      { label: repoQuery },
    ];
  }

  // /repos/:name
  const repoMatch = pathname.match(/^\/repos\/([^/]+)$/);
  if (repoMatch) {
    return [
      { label: 'Home', href: '/' },
      { label: 'Repos', href: '/repos' },
      { label: decodeURIComponent(repoMatch[1]) },
    ];
  }

  // /features/:issue
  const featureMatch = pathname.match(/^\/features\/([^/]+)$/);
  if (featureMatch) {
    return [
      { label: 'Home', href: '/' },
      { label: 'Features', href: '/pipeline' },
      { label: `#${featureMatch[1]}` },
    ];
  }

  return [];
}

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="border-b border-border bg-secondary/40">
      <ol className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-2">
              {c.href && !isLast ? (
                <Link href={c.href} data-no-style className="hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                <span className="text-foreground">{c.label}</span>
              )}
              {!isLast && <span aria-hidden>›</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Client convenience: auto-builds crumbs from the current URL. */
export function AutoBreadcrumbs() {
  const pathname = usePathname() ?? '/';
  const search = useSearchParams();
  const repo = search?.get('repo') ?? null;
  return <Breadcrumbs crumbs={crumbsForPath(pathname, repo)} />;
}
