import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { PmChat } from '@/components/pm-chat';

/**
 * Drop-intent flow. Replaces the old terminal `/develop` slash-command
 * handoff with an in-browser PM brainstorm chat. The user pitches an
 * idea, the PM agent pushes back / surfaces conflicts / scopes it, and
 * when they're aligned the user clicks "Approve and start" to file the
 * issue + dispatch the implement workflow.
 *
 * Query params:
 *  - `prefill` — initial text to seed the chat input with (e.g. when
 *    the user clicks a proposal on `/proposals`).
 *  - `repo` — `owner/name` to pre-select in the repo dropdown.
 */
export default async function IntentPage(props: {
  searchParams: Promise<{ prefill?: string; repo?: string }>;
}) {
  const octokit = await getOctokit();
  const repos = wiredRepos(await listAllowedRepos(octokit));
  const dashboardKeySet = Boolean(process.env.ANTHROPIC_API_KEY);
  const { prefill, repo: prefillRepo } = await props.searchParams;

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Brainstorm with the PM</h1>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Chat with the PM agent to bring a new idea, sharpen scope, or argue
        through a tradeoff. It reads your repo&apos;s
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

      <PmChat
        repos={repos}
        initialInput={prefill ?? ''}
        initialRepo={prefillRepo ?? null}
      />
    </div>
  );
}
