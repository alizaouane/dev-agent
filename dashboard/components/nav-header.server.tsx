import { Button } from '@/components/ui/button';
import { auth, signOut } from '@/lib/auth';
import { NavHeaderShell } from '@/components/nav-header';

export async function NavHeader() {
  const session = await auth();
  const signOutForm = session?.user ? (
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
  ) : null;
  return <NavHeaderShell username={session?.user?.username ?? null} signOutForm={signOutForm} />;
}
