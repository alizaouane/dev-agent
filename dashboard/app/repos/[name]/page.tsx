import { getOctokit } from '@/lib/gh';
import { listAllowedRepos } from '@/lib/repos';
import { fetchPipeline } from '@/lib/pipeline';
import { InboxList } from '@/components/inbox-list';
import { readBugScoutSchedule } from '@/lib/bug-scout-schedule';
import { BugScoutScheduleForm } from '@/components/bug-scout-schedule-form';
import { ScanWithPmButton } from '@/components/scan-with-pm-button';
import { ScanCleanupButton } from '@/components/scan-cleanup-button';

const UNFINISHED_WORK_WORKFLOW_PATH = '.github/workflows/dev-agent-unfinished-work-scout.yml';
const CLEANUP_WORKFLOW_PATH = '.github/workflows/dev-agent-cleanup-scout.yml';

async function isWorkflowInstalled(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string,
  default_branch: string,
  path: string,
): Promise<boolean> {
  try {
    await octokit.repos.getContent({ owner, repo, path, ref: default_branch });
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return false;
    return false;
  }
}

export default async function RepoPage(props: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await props.params;
  const name = decodeURIComponent(rawName);
  const octokit = await getOctokit();
  const allRepos = await listAllowedRepos(octokit);
  const repo = allRepos.find((r) => `${r.owner}/${r.name}` === name);
  if (!repo) {
    return <p className="text-muted-foreground">Repo not found in allowlist.</p>;
  }
  const items = await fetchPipeline(octokit, [repo], { include_terminal: true });

  // Bug-scout schedule + unfinished-work scout install state both live
  // on the repo's default branch. Lookups are best-effort — failures
  // (rate-limit, transient network) shouldn't break the whole repo page,
  // so we surface forms in a degraded state.
  let scheduleSnapshot: Awaited<ReturnType<typeof readBugScoutSchedule>> | null = null;
  let scheduleError: string | null = null;
  let unfinishedWorkInstalled = false;
  let cleanupInstalled = false;
  if (repo.wired_up) {
    try {
      [scheduleSnapshot, unfinishedWorkInstalled, cleanupInstalled] = await Promise.all([
        readBugScoutSchedule(octokit, repo.owner, repo.name, repo.default_branch),
        isWorkflowInstalled(octokit, repo.owner, repo.name, repo.default_branch, UNFINISHED_WORK_WORKFLOW_PATH),
        isWorkflowInstalled(octokit, repo.owner, repo.name, repo.default_branch, CLEANUP_WORKFLOW_PATH),
      ]);
    } catch (err) {
      scheduleError = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">{name}</h1>

      {repo.wired_up ? (
        <>
          <section className="mb-8 rounded-md border border-border bg-card p-5">
            <h2 className="mb-1 text-base font-semibold">Scan with PM (deep)</h2>
            <ScanWithPmButton repo={name} workflowPresent={unfinishedWorkInstalled} />
          </section>

          <section className="mb-8 rounded-md border border-border bg-card p-5">
            <h2 className="mb-1 text-base font-semibold">Cleanup scan</h2>
            <ScanCleanupButton repo={name} workflowPresent={cleanupInstalled} />
          </section>

          <section className="mb-8 rounded-md border border-border bg-card p-5">
            <h2 className="mb-1 text-base font-semibold">Bug-scout schedule</h2>
            <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
              Controls how often the bug-scout LLM agent scans this repo for
              security, broken-logic, and code-smell findings. Each scan costs
              $0.30–$1.00 in Anthropic tokens; the listed monthly range
              assumes that. Findings appear under{' '}
              <code>kind:bug-scout</code> issues + on{' '}
              <code>/proposals</code>.
            </p>
            {scheduleError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <p className="font-medium">Failed to read current schedule</p>
                <p className="mt-1 text-muted-foreground">{scheduleError}</p>
              </div>
            ) : scheduleSnapshot ? (
              <BugScoutScheduleForm
                repo={name}
                current={scheduleSnapshot.preset}
                currentCron={scheduleSnapshot.cron}
              />
            ) : null}
          </section>
        </>
      ) : null}

      <h2 className="mb-3 text-base font-semibold">Pipeline</h2>
      <InboxList items={items} />
    </div>
  );
}
