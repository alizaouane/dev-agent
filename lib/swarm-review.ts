/**
 * Pillar 2 aggregator. Takes the structured outputs of the three swarm
 * reviewers (spec-compliance, regression-guard, security-scout) and
 * combines them into a single verdict per the rules:
 *
 *   - Every HIGH-severity finding must include a non-empty proof_command;
 *     reviewers whose HIGH finding lacks one (or whose proof returns no
 *     match — verifier callback) get effective_verdict = abstain.
 *   - Weighted vote: each reviewer carries a config weight (default 1.0;
 *     security-scout default 1.5). abstain = zero weight.
 *   - ≥ 2-of-3 weighted fail → `swarm-fail`.
 *   - Single weighted fail or any concern → `swarm-concern` (advisory).
 *   - All pass / abstain → `swarm-pass`.
 *
 * Meta-reviewer escalation (per the plan) — when the votes are mixed
 * pass + fail and no clear majority, a single Sonnet call could break
 * the tie. v1 ships without that call (deterministic only); v1.1 wires
 * it via the existing render-and-run.ts pattern.
 *
 * The aggregator is pure logic — no I/O, no model calls. The workflow
 * orchestrates: collects reviewer outputs, optionally runs each finding's
 * proof_command, calls aggregate(), posts the comment_body to the PR,
 * applies the verdict label.
 */

export type ReviewerVerdict = 'pass' | 'fail' | 'concern' | 'abstain';

export interface ReviewerFinding {
  rule: string;
  severity: 'high' | 'medium' | 'low';
  file: string;
  line: number;
  message: string;
  /** rg / ast-grep / grep one-liner that re-verifies the finding from the diff. */
  proof_command?: string;
  /** 0.0-1.0; reviewers may omit. */
  confidence?: number;
  criterion_id?: string;
  /** For security-scout findings, which deterministic scanner produced it. */
  scanner?: string;
}

export interface ReviewerOutput {
  /** Reviewer name (`spec-compliance`, `regression-guard`, `security-scout`). */
  reviewer: string;
  verdict: ReviewerVerdict;
  findings: ReviewerFinding[];
  /** 1-3 line markdown summary the aggregator embeds in its consolidated comment. */
  summary: string;
}

export interface ReviewerEvaluation {
  name: string;
  original_verdict: ReviewerVerdict;
  effective_verdict: ReviewerVerdict;
  weight: number;
  notes: string[];
}

export interface AggregatedVerdict {
  verdict: 'swarm-pass' | 'swarm-concern' | 'swarm-fail';
  reasoning: string;
  reviewers: ReviewerEvaluation[];
  comment_body: string;
}

export interface AggregateOptions {
  /** Per-reviewer weights. Reviewers not in the map default to 1.0. */
  weights?: Record<string, number>;
  /**
   * Optional callback the workflow can supply to actually run a finding's
   * proof_command and return whether it re-verified the claim. When
   * absent, the aggregator only checks `proof_command` is non-empty.
   */
  proofVerifier?: (finding: ReviewerFinding, reviewer: string) => boolean;
}

const DEFAULT_WEIGHTS: Record<string, number> = {
  'spec-compliance': 1.0,
  'regression-guard': 1.0,
  'security-scout': 1.5,
};

const FAIL_THRESHOLD_WEIGHTED = 2.0;

function weightFor(name: string, custom?: Record<string, number>): number {
  if (custom && name in custom) return custom[name];
  if (name in DEFAULT_WEIGHTS) return DEFAULT_WEIGHTS[name];
  return 1.0;
}

/**
 * Inspect a reviewer's findings + verdict and decide an effective verdict
 * after applying the evidence-grounding rule. Notes carry human-readable
 * explanations of any downgrades.
 */
function evaluateReviewer(
  out: ReviewerOutput,
  weight: number,
  proofVerifier?: AggregateOptions['proofVerifier'],
): ReviewerEvaluation {
  const notes: string[] = [];
  let effective = out.verdict;

  // Hard-gate: any HIGH-severity finding without a proof_command makes
  // the entire reviewer abstain (zero weight). The reviewer's verdict
  // can be `fail` and still be valid IFF every HIGH finding it cited is
  // grounded in a runnable proof. Ungrounded HIGH = un-falsifiable claim
  // = aggregator drops it.
  const ungroundedHigh = out.findings.filter(
    (f) => f.severity === 'high' && (!f.proof_command || f.proof_command.trim().length === 0),
  );
  if (ungroundedHigh.length > 0) {
    notes.push(
      `${ungroundedHigh.length} HIGH-severity finding(s) lack proof_command; reviewer abstained.`,
    );
    effective = 'abstain';
    return { name: out.reviewer, original_verdict: out.verdict, effective_verdict: effective, weight: 0, notes };
  }

  // Optional: run each HIGH finding's proof_command via the verifier
  // callback. If a HIGH finding's proof returns false, downgrade THAT
  // finding to concern (rule from the plan), but the reviewer's verdict
  // can still stand if other findings remain valid.
  if (proofVerifier) {
    let downgraded = 0;
    for (const f of out.findings) {
      if (f.severity !== 'high' || !f.proof_command) continue;
      if (!proofVerifier(f, out.reviewer)) {
        f.severity = 'medium'; // mutate in place to record the downgrade
        downgraded++;
      }
    }
    if (downgraded > 0) notes.push(`${downgraded} HIGH finding(s) auto-downgraded — proof_command returned no match.`);
    // After downgrades, if the reviewer's verdict was `fail` but no
    // HIGH findings remain, soften to `concern`.
    const remainingHigh = out.findings.filter((f) => f.severity === 'high').length;
    if (effective === 'fail' && remainingHigh === 0) {
      notes.push('No HIGH findings survived proof verification; verdict softened to concern.');
      effective = 'concern';
    }
  }

  return {
    name: out.reviewer,
    original_verdict: out.verdict,
    effective_verdict: effective,
    weight: effective === 'abstain' ? 0 : weight,
    notes,
  };
}

/**
 * Tally the weighted votes and pick the consolidated verdict.
 *
 * The deterministic rule:
 *   - Sum weights of effective verdicts:
 *       failW    = sum of weights where effective_verdict === 'fail'
 *       concernW = sum where 'concern'
 *       passW    = sum where 'pass'
 *   - failW >= FAIL_THRESHOLD_WEIGHTED → swarm-fail.
 *   - 0 < failW < threshold OR concernW > 0 → swarm-concern.
 *   - failW === 0 AND concernW === 0 → swarm-pass.
 */
function tally(reviewers: ReviewerEvaluation[]): {
  verdict: AggregatedVerdict['verdict'];
  reasoning: string;
} {
  let failW = 0;
  let concernW = 0;
  let passW = 0;
  const breakdown: string[] = [];
  for (const r of reviewers) {
    if (r.effective_verdict === 'fail') failW += r.weight;
    else if (r.effective_verdict === 'concern') concernW += r.weight;
    else if (r.effective_verdict === 'pass') passW += r.weight;
    breakdown.push(`${r.name}=${r.effective_verdict}(w=${r.weight})`);
  }
  const summary = `weighted: fail=${failW.toFixed(1)} concern=${concernW.toFixed(1)} pass=${passW.toFixed(1)} | ${breakdown.join(', ')}`;
  if (failW >= FAIL_THRESHOLD_WEIGHTED) return { verdict: 'swarm-fail', reasoning: summary };
  if (failW > 0 || concernW > 0) return { verdict: 'swarm-concern', reasoning: summary };
  return { verdict: 'swarm-pass', reasoning: summary };
}

function renderCommentBody(
  outputs: ReviewerOutput[],
  evaluations: ReviewerEvaluation[],
  verdict: AggregatedVerdict['verdict'],
  reasoning: string,
): string {
  const headline =
    verdict === 'swarm-pass'
      ? '✅ swarm-review: pass'
      : verdict === 'swarm-fail'
        ? '🛑 swarm-review: fail'
        : '⚠️ swarm-review: concern';
  const lines: string[] = [];
  lines.push(`## ${headline}`);
  lines.push('');
  lines.push(`_${reasoning}_`);
  lines.push('');
  for (const out of outputs) {
    const evalRec = evaluations.find((e) => e.name === out.reviewer);
    const verdictLabel = evalRec?.effective_verdict ?? out.verdict;
    lines.push(`### ${out.reviewer} — \`${verdictLabel}\``);
    lines.push('');
    if (evalRec && evalRec.original_verdict !== evalRec.effective_verdict) {
      lines.push(`> Original: \`${evalRec.original_verdict}\` → effective: \`${evalRec.effective_verdict}\``);
      lines.push('');
    }
    if (evalRec && evalRec.notes.length > 0) {
      for (const n of evalRec.notes) lines.push(`> ${n}`);
      lines.push('');
    }
    lines.push(out.summary || '_(no summary)_');
    if (out.findings.length > 0) {
      lines.push('');
      lines.push('<details><summary>Findings</summary>');
      lines.push('');
      for (const f of out.findings) {
        const proof = f.proof_command ? ` · proof: \`${f.proof_command}\`` : '';
        const scanner = f.scanner ? ` · scanner: \`${f.scanner}\`` : '';
        const conf = typeof f.confidence === 'number' ? ` · confidence: ${f.confidence.toFixed(2)}` : '';
        lines.push(`- **[${f.severity}]** \`${f.rule}\` at \`${f.file}:${f.line}\` — ${f.message}${proof}${scanner}${conf}`);
      }
      lines.push('</details>');
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function aggregateVerdicts(
  outputs: ReviewerOutput[],
  options: AggregateOptions = {},
): AggregatedVerdict {
  if (outputs.length === 0) {
    return {
      verdict: 'swarm-fail',
      reasoning: 'no reviewer outputs supplied',
      reviewers: [],
      comment_body: '## 🛑 swarm-review: fail\n\n_no reviewer outputs supplied._',
    };
  }
  const evaluations = outputs.map((o) =>
    evaluateReviewer(o, weightFor(o.reviewer, options.weights), options.proofVerifier),
  );
  const { verdict, reasoning } = tally(evaluations);
  return {
    verdict,
    reasoning,
    reviewers: evaluations,
    comment_body: renderCommentBody(outputs, evaluations, verdict, reasoning),
  };
}
