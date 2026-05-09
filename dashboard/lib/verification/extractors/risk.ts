import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { VerificationOutcome, PillarStatus } from '../types';
import { parseTelemetry } from '@/lib/telemetry';

const VERDICT_LINE = /^Verdict:\s*(\S+)/im;
const MISMATCH_COUNT = /Mismatches[^:]*:\s*(\d+)/i;

function mapVerdict(verdict: string, body: string): { status: PillarStatus; summary: string } {
  switch (verdict.toLowerCase()) {
    case 'clean':
      return { status: 'passed', summary: 'No risk-rating mismatches' };
    case 'mismatches': {
      const n = parseInt(body.match(MISMATCH_COUNT)?.[1] ?? '0', 10);
      return {
        status: 'advisory',
        summary: `${n} mismatch${n === 1 ? '' : 'es'} flagged`,
      };
    }
    case 'absent':
      return { status: 'not_run', summary: 'No bash-log to audit' };
    default:
      return { status: 'advisory', summary: `Verdict: ${verdict}` };
  }
}

export async function extractRiskOutcome(
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
    if (!t || t.phase !== 'risk-audit') continue;
    const verdict = body.match(VERDICT_LINE)?.[1] ?? 'unknown';
    const { status, summary } = mapVerdict(verdict, body);
    return {
      feature_id: issueNumber,
      repo,
      pillar: 'risk_p5',
      status,
      summary,
      details_url: comments[i].html_url,
      ran_at: comments[i].created_at ?? new Date().toISOString(),
      cost_usd: t.cost_usd, // forward from parseTelemetry — feeds VerificationRollup.total_cost_usd
    };
  }
  return null;
}
