import { describe, it, expect } from 'vitest';
import {
  aggregateVerdicts,
  type ReviewerOutput,
  type ReviewerFinding,
} from '../../lib/swarm-review';

function reviewer(
  name: string,
  verdict: 'pass' | 'fail' | 'concern' | 'abstain',
  findings: ReviewerFinding[] = [],
  summary = 'ok',
): ReviewerOutput {
  return { reviewer: name, verdict, findings, summary };
}

function highFinding(overrides: Partial<ReviewerFinding> = {}): ReviewerFinding {
  return {
    rule: 'unvalidated-input',
    severity: 'high',
    file: 'src/api/route.ts',
    line: 42,
    message: 'req.body reaches sql without validation',
    proof_command: "rg -n 'req.body' src/api/route.ts",
    ...overrides,
  };
}

describe('aggregateVerdicts — happy paths', () => {
  it('returns swarm-pass when every reviewer passes', () => {
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'pass'),
      reviewer('regression-guard', 'pass'),
      reviewer('security-scout', 'pass'),
    ]);
    expect(r.verdict).toBe('swarm-pass');
    expect(r.reviewers).toHaveLength(3);
    expect(r.reviewers.every((rv) => rv.effective_verdict === 'pass')).toBe(true);
  });

  it('returns swarm-fail when ≥2 reviewers fail (default weights)', () => {
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'fail', [highFinding()]),
      reviewer('regression-guard', 'fail', [highFinding({ rule: 'test-newly-failing' })]),
      reviewer('security-scout', 'pass'),
    ]);
    expect(r.verdict).toBe('swarm-fail');
  });

  it('returns swarm-concern when only one reviewer fails', () => {
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'fail', [highFinding()]),
      reviewer('regression-guard', 'pass'),
      reviewer('security-scout', 'pass'),
    ]);
    expect(r.verdict).toBe('swarm-concern');
  });

  it('returns swarm-fail when security-scout alone fails (its weight ≥ threshold)', () => {
    // security-scout default weight 1.5; FAIL_THRESHOLD_WEIGHTED = 2.0.
    // One security-scout fail alone is 1.5 < 2.0 → concern, not fail.
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'pass'),
      reviewer('regression-guard', 'pass'),
      reviewer('security-scout', 'fail', [highFinding({ scanner: 'gitleaks' })]),
    ]);
    expect(r.verdict).toBe('swarm-concern');
  });

  it('returns swarm-fail when security-scout + one other reviewer fail (1.5 + 1.0 ≥ 2.0)', () => {
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'fail', [highFinding()]),
      reviewer('regression-guard', 'pass'),
      reviewer('security-scout', 'fail', [highFinding({ scanner: 'gitleaks' })]),
    ]);
    expect(r.verdict).toBe('swarm-fail');
  });
});

describe('aggregateVerdicts — evidence grounding', () => {
  it('forces a reviewer to abstain if any HIGH finding lacks proof_command', () => {
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'fail', [highFinding({ proof_command: undefined })]),
      reviewer('regression-guard', 'pass'),
      reviewer('security-scout', 'pass'),
    ]);
    const speccomp = r.reviewers.find((rv) => rv.name === 'spec-compliance')!;
    expect(speccomp.effective_verdict).toBe('abstain');
    expect(speccomp.weight).toBe(0);
    expect(speccomp.notes.join(' ')).toMatch(/lack proof_command/);
    // With spec-compliance abstaining, only the other two count → pass.
    expect(r.verdict).toBe('swarm-pass');
  });

  it('forces abstain even when proof_command is empty whitespace', () => {
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'fail', [highFinding({ proof_command: '   ' })]),
      reviewer('regression-guard', 'pass'),
      reviewer('security-scout', 'pass'),
    ]);
    expect(r.reviewers.find((rv) => rv.name === 'spec-compliance')!.effective_verdict).toBe('abstain');
  });

  it('does NOT abstain a reviewer for ungrounded MEDIUM/LOW findings', () => {
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'concern', [highFinding({ severity: 'medium', proof_command: undefined })]),
      reviewer('regression-guard', 'pass'),
      reviewer('security-scout', 'pass'),
    ]);
    const speccomp = r.reviewers.find((rv) => rv.name === 'spec-compliance')!;
    expect(speccomp.effective_verdict).toBe('concern');
    expect(speccomp.weight).toBeGreaterThan(0);
  });
});

describe('aggregateVerdicts — proof verifier callback', () => {
  it('downgrades HIGH findings whose proof_command returns no match', () => {
    const verdict = aggregateVerdicts(
      [
        reviewer('spec-compliance', 'fail', [
          highFinding({ rule: 'a' }),
          highFinding({ rule: 'b', file: 'src/other.ts' }),
        ]),
        reviewer('regression-guard', 'pass'),
        reviewer('security-scout', 'pass'),
      ],
      {
        // Verifier returns false for rule 'a', true for 'b'.
        proofVerifier: (f) => f.rule !== 'a',
      },
    );
    const speccomp = verdict.reviewers.find((rv) => rv.name === 'spec-compliance')!;
    expect(speccomp.notes.join(' ')).toMatch(/auto-downgraded/);
  });

  it('softens fail to concern when no HIGH findings survive verification', () => {
    const verdict = aggregateVerdicts(
      [
        reviewer('spec-compliance', 'fail', [highFinding(), highFinding({ rule: 'b' })]),
        reviewer('regression-guard', 'pass'),
        reviewer('security-scout', 'pass'),
      ],
      { proofVerifier: () => false },
    );
    const speccomp = verdict.reviewers.find((rv) => rv.name === 'spec-compliance')!;
    expect(speccomp.effective_verdict).toBe('concern');
  });
});

describe('aggregateVerdicts — comment body', () => {
  it('renders a markdown headline matching the verdict', () => {
    const pass = aggregateVerdicts([
      reviewer('spec-compliance', 'pass'),
      reviewer('regression-guard', 'pass'),
      reviewer('security-scout', 'pass'),
    ]);
    expect(pass.comment_body).toMatch(/^## ✅ swarm-review: pass/);

    const concern = aggregateVerdicts([
      reviewer('spec-compliance', 'fail', [highFinding()]),
      reviewer('regression-guard', 'pass'),
      reviewer('security-scout', 'pass'),
    ]);
    expect(concern.comment_body).toMatch(/swarm-review: concern/);

    const fail = aggregateVerdicts([
      reviewer('spec-compliance', 'fail', [highFinding()]),
      reviewer('regression-guard', 'fail', [highFinding({ rule: 'r2' })]),
      reviewer('security-scout', 'pass'),
    ]);
    expect(fail.comment_body).toMatch(/swarm-review: fail/);
  });

  it('inlines per-reviewer summaries + findings', () => {
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'fail', [highFinding({ rule: 'unvalidated-input' })], 'AC-1 bound but not exercised'),
      reviewer('regression-guard', 'pass', [], 'no regressions'),
      reviewer('security-scout', 'pass'),
    ]);
    expect(r.comment_body).toContain('### spec-compliance');
    expect(r.comment_body).toContain('AC-1 bound but not exercised');
    expect(r.comment_body).toContain('unvalidated-input');
  });

  it('shows the verdict-downgrade note when effective != original', () => {
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'fail', [highFinding({ proof_command: undefined })]),
      reviewer('regression-guard', 'pass'),
      reviewer('security-scout', 'pass'),
    ]);
    expect(r.comment_body).toMatch(/Original: `fail` → effective: `abstain`/);
  });
});

describe('aggregateVerdicts — edge cases', () => {
  it('handles zero reviewers safely', () => {
    const r = aggregateVerdicts([]);
    expect(r.verdict).toBe('swarm-fail');
    expect(r.comment_body).toMatch(/no reviewer outputs/);
  });

  it('honors custom weights', () => {
    // Override security-scout to weight 5 — its single fail should
    // dominate even with the other two passing.
    const r = aggregateVerdicts(
      [
        reviewer('spec-compliance', 'pass'),
        reviewer('regression-guard', 'pass'),
        reviewer('security-scout', 'fail', [highFinding({ scanner: 'gitleaks' })]),
      ],
      { weights: { 'security-scout': 5.0 } },
    );
    expect(r.verdict).toBe('swarm-fail');
  });

  it('treats all-abstain as swarm-pass (no signal = no block)', () => {
    const r = aggregateVerdicts([
      reviewer('spec-compliance', 'abstain'),
      reviewer('regression-guard', 'abstain'),
      reviewer('security-scout', 'abstain'),
    ]);
    expect(r.verdict).toBe('swarm-pass');
  });
});
