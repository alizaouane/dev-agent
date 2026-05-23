'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { HelpPanel } from '@/components/help-panel';
import { AutoBreadcrumbs } from '@/components/ui/breadcrumbs';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

const PRIMARY = [
  { href: '/', label: 'Home' },
  { href: '/repos', label: 'Repos' },
  { href: '/intent', label: 'Brainstorm' },
];

const WORK = [
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/proposals', label: 'Proposals' },
];

const INSIGHTS = [
  { href: '/activity', label: 'Activity' },
  { href: '/cost', label: 'Cost' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

function NavLink({
  href,
  label,
  pathname,
  emphasis = 'primary',
}: {
  href: string;
  label: string;
  pathname: string;
  emphasis?: 'primary' | 'secondary';
}) {
  const active = isActive(pathname, href);
  return (
    <Link
      href={href}
      data-no-style
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-block border-b-2 pb-1 transition-colors',
        active
          ? 'border-accent font-medium text-foreground'
          : 'border-transparent hover:text-foreground',
        emphasis === 'primary' ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {label}
    </Link>
  );
}

export function NavLinks() {
  const pathname = usePathname() ?? '/';
  return (
    <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {PRIMARY.map((l) => (
        <NavLink key={l.href} {...l} pathname={pathname} emphasis="primary" />
      ))}
      <span aria-hidden className="hidden text-border sm:inline">|</span>
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">WORK</span>
      {WORK.map((l) => (
        <NavLink key={l.href} {...l} pathname={pathname} emphasis="secondary" />
      ))}
      <span className="ml-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">INSIGHTS</span>
      {INSIGHTS.map((l) => (
        <NavLink key={l.href} {...l} pathname={pathname} emphasis="secondary" />
      ))}
    </nav>
  );
}

/** Client wrapper for nav body — server wrapper passes the auth bits in. */
export function NavHeaderShell({
  username,
  signOutForm,
}: {
  username: string | null;
  signOutForm: ReactNode;
}) {
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" data-no-style className="font-semibold text-foreground">
          dev-agent
        </Link>
        <div className="hidden sm:block">
          <NavLinks />
        </div>
        <div className="flex items-center gap-3">
          <Button asChild variant="accent" size="sm">
            <Link href="/intent" data-no-style>
              Brainstorm new work
            </Link>
          </Button>
          <HelpPanel />
          {username && signOutForm}
        </div>
      </div>
      <AutoBreadcrumbs />
    </header>
  );
}
