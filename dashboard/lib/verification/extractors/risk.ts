import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { VerificationOutcome, PillarStatus } from '../types';

const VERDICT_LINE = /^Verdict:\s*(\S+)/im;
const MISMATCH_COUNT = /Mismatches[^:]*:\s*(\d+)/i;
// The risk-audit step in phase-implement anchors its comment with this
// line. It is NOT a full telemetry comment — risk-audit is a deterministic
// CLI with no model/tokens/cost — so detect it directly. (Using
// parseTelemetry here returned null, since that parser requires the LLM
// telemetry fields the risk-audit comment never carries.)
const RISK_PHASE_ANCHOR = /🤖\s*Phase:\s*risk-audit/i;

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
    if (!RISK_PHASE_ANCHOR.test(body)) continue;
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
      // No cost_usd — risk-audit is a deterministic step inside
      // phase-implement; its runtime rolls up under the implement phase.
    };
  }
  return null;
}
