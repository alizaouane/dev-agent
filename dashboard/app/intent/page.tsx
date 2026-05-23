import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { PmChat } from '@/components/pm-chat';
import { PageHeader } from '@/components/ui/page-header';

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
      <PageHeader
        title="Brainstorm"
        descriptor="Talk to the PM agent to start new work."
        helpTerm="intent-page"
      />

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
