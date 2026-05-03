import { Octokit } from '@octokit/rest';
import type { Candidate } from './types';

const RELEVANT_LABELS = new Set(['bug', 'triage']);

type IssueShape = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<string | { name: string }>;
};

export async function githubIssuesAdapter(): Promise<Candidate[]> {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repo || !token) return [];
  const [owner, name] = repo.split('/');
  const octokit = new Octokit({ auth: token });
  const issues = (await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
    owner,
    repo: name,
    state: 'open',
    per_page: 100,
  })) as IssueShape[];
  return issues
    .filter((i) =>
      i.labels.some((l) => RELEVANT_LABELS.has(typeof l === 'string' ? l : l.name)),
    )
    .map((i) => ({
      source: 'github_issues' as const,
      title: i.title,
      body: i.body ?? '',
      evidence_url: i.html_url,
      severity_hint: 'medium' as const,
      novelty_score: 0.5,
    }));
}
