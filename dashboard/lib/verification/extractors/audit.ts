import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { VerificationOutcome, PillarStatus } from '../types';
import { parseTelemetry } from '@/lib/telemetry';

const VERDICT_LINE = /^Verdict:\s*(\S+)/im;
const SYNTAX_ERROR_COUNT = /Verdict:\s*syntax-errors\s*\((\d+)\s+of/i;

function mapVerdict(verdict: string, body: string): { status: PillarStatus; summary: string } {
  switch (verdict.toLowerCase()) {
    case 'clean':
      return { status: 'passed', summary: 'No syntax issues found' };
    case 'syntax-errors': {
      const n = parseInt(body.match(SYNTAX_ERROR_COUNT)?.[1] ?? '0', 10);
      return {
        status: 'advisory',
        summary: `${n} file${n === 1 ? '' : 's'} with syntax errors`,
      };
    }
    case 'no-files':
      return { status: 'not_run', summary: 'No TS/JS files changed' };
    default:
      return { status: 'advisory', summary: `Verdict: ${verdict}` };
  }
}

export async function extractAuditOutcome(
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
    if (!t || t.phase !== 'apply-audit') continue;
    const verdict = body.match(VERDICT_LINE)?.[1] ?? 'unknown';
    const { status, summary } = mapVerdict(verdict, body);
    return {
      feature_id: issueNumber,
      repo,
      pillar: 'audit_p4',
      status,
      summary,
      details_url: comments[i].html_url,
      ran_at: comments[i].created_at ?? new Date().toISOString(),
    };
  }
  return null;
}
