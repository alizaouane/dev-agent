import { getOctokit } from '@/lib/gh';
import { FeatureDetail } from '@/components/feature-detail';
import { FeatureTimeline } from '@/components/feature-timeline';
import { parseTelemetry } from '@/lib/telemetry';
import {
  aggregateTimeline,
  type IssueCommentRow,
} from '@/lib/feature-timeline';

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

  const [{ data: issueData }, commentsResp, sessionLog] = await Promise.all([
    octokit.issues.get({ owner, repo: name, issue_number }),
    octokit.issues.listComments({ owner, repo: name, issue_number, per_page: 100 }),
    fetchSessionLog(octokit, owner, name),
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

  // Best-effort PR link extraction from comments.
  const prMatch = commentRows
    .map((c) => c.body?.match(/PR:\s*#(\d+)/))
    .find((m) => m);
  const prUrl = prMatch ? `https://github.com/${owner}/${name}/pull/${prMatch[1]}` : null;

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
