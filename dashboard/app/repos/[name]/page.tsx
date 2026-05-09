// dashboard/app/repos/[name]/page.tsx
import Link from 'next/link';
import { getOctokit } from '@/lib/gh';
import { listAllowedRepos } from '@/lib/repos';
import { loadRepoWorkspace } from '@/lib/dashboard/repo-workspace';
import { runAllScouts } from '@/lib/scout';
import { readBugScoutSchedule } from '@/lib/bug-scout-schedule';
import { Button } from '@/components/ui/button';
import { FeatureCard } from '@/components/feature-card';
import { VerificationPostureStrip } from '@/components/verification-posture-strip';
import { EmptyState } from '@/components/empty-state';
import { BugScoutScheduleForm } from '@/components/bug-scout-schedule-form';
import { ScanWithPmButton } from '@/components/scan-with-pm-button';
import { ScanCleanupButton } from '@/components/scan-cleanup-button';
import { SetupChecklist, type SetupSteps } from '@/components/setup-checklist';
import { PILLAR_LABELS } from '@/lib/verification/types';

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
  } catch {
    return false;
  }
}

async function probeFile(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<boolean> {
  try {
    await octokit.repos.getContent({ owner, repo, path, ref });
    return true;
  } catch {
    return false;
  }
}

export default async function RepoPage(props: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await props.params;
  const name = decodeURIComponent(rawName);
  const octokit = await getOctokit();
  const allRepos = await listAllowedRepos(octokit);
  const repo = allRepos.find((r) => `${r.owner}/${r.name}` === name);
  if (!repo) return <p className="text-muted-foreground">Repo not found in allowlist.</p>;

  const [workspace, proposals, scheduleSnapshot, unfinishedWorkInstalled, cleanupInstalled] =
    await Promise.all([
      loadRepoWorkspace(octokit, repo),
      runAllScouts(octokit, [repo]).catch(() => []),
      repo.wired_up
        ? readBugScoutSchedule(octokit, repo.owner, repo.name, repo.default_branch).catch(() => null)
        : Promise.resolve(null),
      repo.wired_up
        ? isWorkflowInstalled(octokit, repo.owner, repo.name, repo.default_branch, UNFINISHED_WORK_WORKFLOW_PATH)
        : Promise.resolve(false),
      repo.wired_up
        ? isWorkflowInstalled(octokit, repo.owner, repo.name, repo.default_branch, CLEANUP_WORKFLOW_PATH)
        : Promise.resolve(false),
    ]);

  const [pmMdPresent] = await Promise.all([
    repo.wired_up
      ? probeFile(octokit, repo.owner, repo.name, '.dev-agent/pm.md', repo.default_branch)
      : Promise.resolve(false),
  ]);
  const setupSteps: SetupSteps = {
    wired: repo.wired_up,
    pm_md_present: pmMdPresent,
    scout_configured: unfinishedWorkInstalled,
    first_proposal: proposals.length > 0,
    first_feature_shipped: workspace.recentlyShipped.length > 0 || workspace.inFlight.length > 0,
  };

  return (
    <div className="flex flex-col gap-10">
      <SetupChecklist repoName={name} steps={setupSteps} />
      {/* Band 1 — Repo header */}
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{name}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {repo.wired_up ? 'Wired ✓' : 'Not wired'} · default branch {repo.default_branch} ·{' '}
            <a href={repo.html_url} target="_blank" rel="noreferrer noopener" className="underline">
              GitHub
            </a>
          </p>
        </div>
        <Link href={`/intent?repo=${encodeURIComponent(name)}`}>
          <Button size="lg">Brainstorm new work on {name}</Button>
        </Link>
      </section>

      {/* Band 2 — In flight */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">In flight</h2>
        {workspace.inFlight.length === 0 ? (
          <EmptyState title="Nothing in flight on this repo." body="" />
        ) : (
          <div className="flex flex-col gap-2">
            {workspace.inFlight.map((i) => (
              <FeatureCard key={`${i.repo}#${i.issue_number}`} item={i} hideRepo />
            ))}
          </div>
        )}
      </section>

      {/* Band 3 — PM proposes */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">PM proposes</h2>
          <Link href="/proposals" className="text-sm underline">
            See all
          </Link>
        </div>
        {proposals.length === 0 ? (
          <EmptyState title="PM doesn't see anything pressing for this repo right now." body="" />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {proposals.slice(0, 5).map((p) => (
              <li key={p.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{p.source}</span>
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="mt-1 block font-medium hover:underline">
                    {p.title}
                  </a>
                </div>
                <Link
                  href={`/intent?repo=${encodeURIComponent(name)}&prefill=${encodeURIComponent(p.title)}`}
                  className="text-sm underline"
                >
                  Discuss with PM
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Band 4 — Recently shipped */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Recently shipped (last 14d)</h2>
        {workspace.recentlyShipped.length === 0 ? (
          <EmptyState title="No features shipped in the last 14 days." body="" />
        ) : (
          <div className="flex flex-col gap-2">
            {workspace.recentlyShipped.map((i) => (
              <FeatureCard key={`${i.repo}#${i.issue_number}`} item={i} hideRepo />
            ))}
          </div>
        )}
      </section>

      {/* Band 5 — Verification posture for this repo */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Verification posture (this repo)</h2>
        <div className="flex flex-col gap-3">
          <VerificationPostureStrip rollup={workspace.posture} />
          <div className="rounded-md border border-border bg-card p-4 text-sm">
            <p className="mb-2 font-medium">Configured pillars</p>
            <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {(Object.keys(workspace.pillars) as Array<keyof typeof workspace.pillars>).map((p) => (
                <li key={p} className="flex items-center gap-2">
                  <span aria-hidden>{workspace.pillars[p] ? '✓' : '·'}</span>
                  <span className={workspace.pillars[p] ? '' : 'text-muted-foreground'}>
                    {PILLAR_LABELS[p]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Band 6 — Cost (placeholder for v1) */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Cost (this repo, last 30d)</h2>
        <Link href={`/cost?repo=${encodeURIComponent(name)}`} className="text-sm underline">
          Open full cost view →
        </Link>
      </section>

      {/* Band 7 — Settings & links */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Settings &amp; links</h2>
        {repo.wired_up ? (
          <div className="flex flex-col gap-6">
            <div className="rounded-md border border-border bg-card p-5">
              <h3 className="mb-1 text-base font-semibold">Scan with PM (deep)</h3>
              <ScanWithPmButton repo={name} workflowPresent={unfinishedWorkInstalled} />
            </div>
            <div className="rounded-md border border-border bg-card p-5">
              <h3 className="mb-1 text-base font-semibold">Cleanup scan</h3>
              <ScanCleanupButton repo={name} workflowPresent={cleanupInstalled} />
            </div>
            {scheduleSnapshot ? (
              <div className="rounded-md border border-border bg-card p-5">
                <h3 className="mb-1 text-base font-semibold">Bug-scout schedule</h3>
                <BugScoutScheduleForm
                  repo={name}
                  current={scheduleSnapshot.preset}
                  currentCron={scheduleSnapshot.cron}
                />
              </div>
            ) : null}
            <div className="rounded-md border border-border bg-card p-5">
              <h3 className="mb-1 text-base font-semibold">Files</h3>
              <ul className="text-sm">
                <li>
                  <a className="underline" href={`${repo.html_url}/blob/${repo.default_branch}/.dev-agent.yml`} target="_blank" rel="noreferrer noopener">
                    .dev-agent.yml
                  </a>
                </li>
                <li>
                  <a className="underline" href={`${repo.html_url}/blob/${repo.default_branch}/.dev-agent/pm.md`} target="_blank" rel="noreferrer noopener">
                    .dev-agent/pm.md
                  </a>
                </li>
                <li>
                  <a className="underline" href={`${repo.html_url}/blob/${repo.default_branch}/.dev-agent/SESSION_LOG.md`} target="_blank" rel="noreferrer noopener">
                    SESSION_LOG.md
                  </a>
                </li>
              </ul>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Repo is not wired up yet.</p>
        )}
      </section>
    </div>
  );
}
