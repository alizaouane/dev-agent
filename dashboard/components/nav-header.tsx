import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { auth, signOut } from '@/lib/auth';

export async function NavHeader() {
  const session = await auth();
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="font-semibold">
          dev-agent
        </Link>
        <nav className="hidden gap-4 text-sm sm:flex">
          <Link href="/" className="text-muted-foreground hover:text-foreground">
            Inbox
          </Link>
          <Link href="/pipeline" className="text-muted-foreground hover:text-foreground">
            Pipeline
          </Link>
          <Link href="/cost" className="text-muted-foreground hover:text-foreground">
            Cost
          </Link>
          <Link href="/activity" className="text-muted-foreground hover:text-foreground">
            Activity
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/intent">
            <Button size="sm">Drop intent</Button>
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
