import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { VerificationOutcome, PillarStatus } from '../types';
import { parseTelemetry } from '@/lib/telemetry';

const VERDICT_LINE = /^Verdict:\s*(\S+)/im;

function mapVerdict(verdict: string): { status: PillarStatus; summary: string } {
  switch (verdict.toLowerCase()) {
    case 'pass':
      return { status: 'passed', summary: 'Smoke passed' };
    case 'fail':
      return { status: 'failed', summary: 'Smoke failed' };
    case 'ambiguous':
      return { status: 'advisory', summary: 'No probe authored' };
    default:
      return { status: 'advisory', summary: `Verdict: ${verdict}` };
  }
}

export async function extractSmokeOutcome(
  octokit: Octokit,
  repo: string,
  issueNumber: number,
): Promise<VerificationOutcome | null> {
  const [owner, name] = repo.split('/');
  type C = { body?: string | null; html_url: string; created_at?: string };
  const comments = (await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo: name,
    issue_number: issueNumber,
    per_page: 100,
  })) as C[];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body ?? '';
    const t = parseTelemetry(body);
    if (!t || t.phase !== 'tier2-smoke') continue;
    const verdict = body.match(VERDICT_LINE)?.[1] ?? 'unknown';
    const { status, summary } = mapVerdict(verdict);
    return {
      feature_id: issueNumber,
      repo,
      pillar: 'smoke_p7',
      status,
      summary,
      details_url: comments[i].html_url,
      ran_at: comments[i].created_at ?? new Date().toISOString(),
      cost_usd: t.cost_usd, // forward from parseTelemetry — feeds VerificationRollup.total_cost_usd
    };
  }
  return null;
}
