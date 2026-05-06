import { getOctokit } from '@/lib/gh';
import { FeatureDetail } from '@/components/feature-detail';
import { FeatureTimeline } from '@/components/feature-timeline';
import { ActiveRunsPanel } from '@/components/active-runs-panel';
import { FailedRunsPanel } from '@/components/failed-runs-panel';
import { FeaturePRPanel } from '@/components/feature-pr-panel';
import { RedispatchButtons } from '@/components/redispatch-buttons';
import { parseTelemetry } from '@/lib/telemetry';
import {
  aggregateTimeline,
  type IssueCommentRow,
} from '@/lib/feature-timeline';
import { fetchActiveRunsForIssue } from '@/lib/active-runs';
import { fetchRecentFailuresForIssue } from '@/lib/run-failures';
import { fetchFeaturePR } from '@/lib/feature-pr';

// Auth-bearing dynamic page; ISR doesn't apply, but we want a brief
// server-side cache so a manual refresh during a long agent run
// doesn't hammer GitHub's API. 15s feels live without burning rate.
export const revalidate = 15;

type SearchParams = Promise<{ repo?: string }>;

export default async function FeaturePage(props: {
  params: Promise<{ issue: string }>;
  searchParams: SearchParams;
}) {
  const { issue } = await props.params;
  const { repo } = await props.searchParams;
  if (!repo) throw new Error('repo query param required');
  const [owner, name] = repo.split('/');
  const issue_number = parseInt(issue, 10);
  const octokit = await getOctokit();

  const [
    { data: issueData },
    commentsResp,
    sessionLog,
    activeRuns,
    failedRuns,
    featurePR,
  ] = await Promise.all([
    octokit.issues.get({ owner, repo: name, issue_number }),
    octokit.issues.listComments({ owner, repo: name, issue_number, per_page: 100 }),
    fetchSessionLog(octokit, owner, name),
    fetchActiveRunsForIssue(octokit, owner, name, issue_number),
    fetchRecentFailuresForIssue(octokit, owner, name, issue_number),
    fetchFeaturePR(octokit, owner, name, issue_number),
  ]);
  const stateLabel =
    (issueData.labels.map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean) as string[]).find((l) =>
      l.startsWith('state:'),
    ) ?? 'state:unknown';

  // Octokit v22 returns `{ data: T[] }` — we destructured only the issue
  // fetch above; `commentsResp` keeps its envelope so we can normalize.
  const commentRows: IssueCommentRow[] = (commentsResp.data ?? []).map((c) => ({
    id: c.id,
    body: c.body ?? null,
    user: c.user
      ? { login: c.user.login ?? null, type: (c.user as { type?: string }).type ?? null }
      : null,
    created_at: c.created_at,
    html_url: c.html_url,
  }));

  const telemetry = commentRows
    .map((c) => parseTelemetry(c.body ?? ''))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  // PR URL: prefer the FeaturePRPanel's resolved data (richer); fall
  // back to the comments-scrape so the existing FeatureDetail "PR"
  // link still works on issues where pulls.list missed.
  const prUrl =
    featurePR?.html_url ??
    (() => {
      const m = commentRows.map((c) => c.body?.match(/PR:\s*#(\d+)/)).find((x) => x);
      return m ? `https://github.com/${owner}/${name}/pull/${m[1]}` : null;
    })();

  const events = aggregateTimeline({
    issue: {
      number: issue_number,
      title: issueData.title,
      body: issueData.body ?? null,
      html_url: issueData.html_url,
      created_at: issueData.created_at,
    },
    comments: commentRows,
    sessionLog,
  });

  return (
    <div className="flex flex-col gap-4">
      <FeatureDetail
        repo={`${owner}/${name}`}
        issue={{
          number: issue_number,
          title: issueData.title,
          body: issueData.body ?? '',
          html_url: issueData.html_url,
          state: stateLabel,
        }}
        telemetry={telemetry}
        prUrl={prUrl}
      />
      <ActiveRunsPanel runs={activeRuns} repo={`${owner}/${name}`} />
      <FailedRunsPanel runs={failedRuns} />
      <FeaturePRPanel pr={featurePR} repo={`${owner}/${name}`} />
      <RedispatchButtons
        repo={`${owner}/${name}`}
        issue={issue_number}
        hasActiveRun={activeRuns.length > 0}
      />
      <FeatureTimeline events={events} />
    </div>
  );
}

/**
 * Fetch `SESSION_LOG.md` from the repo root. Returns null on 404 or
 * any other failure — the timeline degrades gracefully without it.
 */
async function fetchSessionLog(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    // Use the repo's default branch by letting Octokit pick it (omit `ref`).
    const resp = await octokit.repos.getContent({ owner, repo, path: 'SESSION_LOG.md' });
    const data = resp.data as { type?: string; content?: string; encoding?: string };
    if (data.type !== 'file' || !data.content || data.encoding !== 'base64') return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}
