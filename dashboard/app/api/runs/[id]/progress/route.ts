import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getOctokit } from '@/lib/gh';

/**
 * GET /api/runs/{id}/progress?repo=owner/name
 *
 * Returns the live step-by-step progress of a workflow run. Used by
 * the feature page's `<RunProgress>` component to show "we're at step
 * 13/19 — currently on Run Claude Code (live agent)" instead of an
 * opaque "running" badge.
 *
 * Why steps and not log lines: GitHub's job-logs endpoint 404s while
 * a job is still in progress. The jobs/steps endpoint, in contrast,
 * is updated continuously and reflects the workflow's authoritative
 * state machine.
 *
 * Auth: gated by NextAuth. Body shape on success:
 *   { run_id, status, conclusion, jobs: [{ name, status, conclusion,
 *     steps: [{ name, number, status, conclusion }] }] }
 *
 * No GitHub-write perms required — this is a read of public-ish run
 * state. We do still require a session so unauthenticated users
 * can't poll arbitrary runs through the dashboard.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const url = new URL(req.url);
  const repoFull = url.searchParams.get('repo') ?? '';
  if (!repoFull.includes('/')) {
    return NextResponse.json({ error: 'repo must be owner/name' }, { status: 400 });
  }
  const run_id = parseInt(id, 10);
  if (!Number.isFinite(run_id)) {
    return NextResponse.json({ error: 'id must be a number' }, { status: 400 });
  }

  const [owner, repo] = repoFull.split('/');
  const octokit = await getOctokit();

  try {
    const [runResp, jobsResp] = await Promise.all([
      octokit.actions.getWorkflowRun({ owner, repo, run_id }),
      octokit.actions.listJobsForWorkflowRun({ owner, repo, run_id }),
    ]);
    return NextResponse.json({
      run_id,
      status: runResp.data.status,
      conclusion: runResp.data.conclusion,
      html_url: runResp.data.html_url,
      jobs: jobsResp.data.jobs.map((j) => ({
        id: j.id,
        name: j.name,
        status: j.status,
        conclusion: j.conclusion,
        started_at: j.started_at,
        // Steps are continuously updated; trim to the fields we need
        // for the panel's checklist render.
        steps: (j.steps ?? []).map((s) => ({
          number: s.number,
          name: s.name,
          status: s.status,
          conclusion: s.conclusion,
        })),
      })),
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : 'unknown';
    // 404 → run id stale / wrong repo; client treats as "no longer
    // in flight" and hides the panel.
    return NextResponse.json({ error: message }, { status });
  }
}
