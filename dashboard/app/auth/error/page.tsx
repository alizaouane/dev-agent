import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type SearchParams = Promise<{ reason?: string }>;

export default async function AuthErrorPage(props: { searchParams: SearchParams }) {
  const { reason } = await props.searchParams;
  const message =
    reason === 'not_allowlisted'
      ? 'Your GitHub account is not on the allowlist for this dashboard.'
      : reason === 'missing_login'
      ? 'We could not read your GitHub login from your OAuth profile. Try signing in again.'
      : 'Sign-in failed.';
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Access denied</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            If you should have access, ask the dashboard owner to add your GitHub username to the allowlist.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
