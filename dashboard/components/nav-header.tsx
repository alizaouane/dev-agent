import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { auth, signOut } from '@/lib/auth';

const PRIMARY = [
  { href: '/', label: 'Home' },
  { href: '/repos', label: 'Repos' },
  { href: '/intent', label: 'Brainstorm' },
];

const SECONDARY = [
  { href: '/proposals', label: 'Proposals' },
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/activity', label: 'Activity' },
  { href: '/cost', label: 'Cost' },
];

export function NavLinks() {
  return (
    <nav className="flex flex-wrap items-center gap-4 text-sm">
      {PRIMARY.map((l) => (
        <Link key={l.href} href={l.href} className="font-medium hover:text-foreground">
          {l.label}
        </Link>
      ))}
      <span aria-hidden className="hidden text-border sm:inline">|</span>
      {SECONDARY.map((l) => (
        <Link key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

export async function NavHeader() {
  const session = await auth();
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="font-semibold">
          dev-agent
        </Link>
        <div className="hidden sm:block">
          <NavLinks />
        </div>
        <div className="flex items-center gap-3">
          <Link href="/intent">
            <Button size="sm">Brainstorm new work</Button>
          </Link>
          {session?.user && (
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/auth/signin' });
              }}
            >
              <Button type="submit" variant="ghost" size="sm">
                @{session.user.username}
              </Button>
            </form>
          )}
        </div>
      </div>
    </header>
  );
}
