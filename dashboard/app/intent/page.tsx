import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { PmChat } from '@/components/pm-chat';

/**
 * Drop-intent flow. Replaces the old terminal `/develop` slash-command
 * handoff with an in-browser PM brainstorm chat. The user pitches an
 * idea, the PM agent pushes back / surfaces conflicts / scopes it, and
 * when they're aligned the user clicks "Approve and start" to file the
 * issue + dispatch the implement workflow.
 */
export default async function IntentPage() {
  const octokit = await getOctokit();
  const repos = wiredRepos(await listAllowedRepos(octokit));
  const dashboardKeySet = Boolean(process.env.ANTHROPIC_API_KEY);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Drop intent</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Pitch an idea to the PM agent. It reads your repo&apos;s
        <code className="mx-1">.dev-agent/pm.md</code>
        for context (goals, things to avoid, recent decisions) and pushes back
        before scope creep can take root. When you&apos;re aligned, approve and
        the implement workflow runs automatically.
      </p>

      {!dashboardKeySet ? (
        <div className="mb-6 max-w-2xl rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
          <p className="font-medium">
            <code>ANTHROPIC_API_KEY</code> is not configured on the dashboard.
          </p>
          <p className="mt-1 text-muted-foreground">
            The PM chat needs the dashboard&apos;s own Anthropic key to stream
            responses. Add <code>ANTHROPIC_API_KEY</code> in Vercel &rarr;
            Settings &rarr; Environment Variables, then redeploy.
          </p>
        </div>
      ) : null}

      <PmChat repos={repos} />
    </div>
  );
}
