import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { VerificationOutcome, PillarStatus } from '../types';
import { parseTelemetry } from '@/lib/telemetry';

// Rich aggregator comment format (success path).
const RICH_HEADING = /^##\s*(?:✅|🛑|⚠️)\s*swarm-review:\s*(pass|fail|concern)/im;
// Telemetry fallback (outage / error path).
const VERDICT_LINE = /^Verdict:\s*(\S+)/im;

type ParsedGateB = { status: PillarStatus; summary: string };

function fromRich(verdict: string): ParsedGateB {
  switch (verdict.toLowerCase()) {
    case 'pass':
      return { status: 'passed', summary: 'All reviewers approved' };
    case 'concern':
      return { status: 'advisory', summary: 'Reviewer concerns raised' };
    case 'fail':
      return { status: 'failed', summary: 'Reviewer failure' };
    default:
      return { status: 'advisory', summary: `Verdict: ${verdict}` };
  }
}

function fromTelemetry(verdict: string): ParsedGateB {
  // The telemetry path is only used for outage/error cases; both are failures.
  return { status: 'failed', summary: `Reviewer ${verdict.toLowerCase()}` };
}

export async function extractGateBOutcome(
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
  // Walk newest-first; first matching comment wins. Either shape qualifies.
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body ?? '';
    const richMatch = body.match(RICH_HEADING);
    if (richMatch) {
      const { status, summary } = fromRich(richMatch[1]);
      return {
        feature_id: issueNumber,
        repo,
        pillar: 'gate_b',
        status,
        summary,
        details_url: comments[i].html_url,
        ran_at: comments[i].created_at ?? new Date().toISOString(),
      };
    }
    const t = parseTelemetry(body);
    if (t && t.phase === 'swarm-review') {
      const verdict = body.match(VERDICT_LINE)?.[1] ?? 'unknown';
      const { status, summary } = fromTelemetry(verdict);
      return {
        feature_id: issueNumber,
        repo,
        pillar: 'gate_b',
        status,
        summary,
        details_url: comments[i].html_url,
        ran_at: comments[i].created_at ?? new Date().toISOString(),
        cost_usd: t.cost_usd, // forward from parseTelemetry (rich-format path has no telemetry block)
      };
    }
  }
  return null;
}
