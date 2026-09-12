import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OVERRIDE_LABEL,
  SPEC_APPROVAL_SCHEMA_VERSION,
  approvalPathForSpec,
  dispatchGateDecision,
  hashSpecAndPlan,
  parseSpecApproval,
  resolveRefusal,
  type SpecApproval,
} from '../../lib/spec-approval';

const SPEC = 'docs/superpowers/specs/2026-09-09-thing-design.md';
const PLAN = 'docs/superpowers/plans/2026-09-09-thing.md';
const SPEC_TEXT = '# Thing\n\nAC-1: it works.\n';
const PLAN_TEXT = '# Plan\n\nTask 1 (AC: 1)\n';

/** Build a valid approval record, overridable field by field. */
function approval(over: Partial<SpecApproval> = {}): SpecApproval {
  return {
    schema_version: SPEC_APPROVAL_SCHEMA_VERSION,
    spec_path: SPEC,
    plan_path: PLAN,
    spec_sha256: hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT),
    review_verdict: 'ok',
    review_rounds: 2,
    approved_by: 'ali@example.com',
    approved_at: '2026-09-09T10:00:00.000Z',
    ...over,
  };
}

/** Run the gate against a serialized approval and the canonical documents. */
function gate(over: Partial<SpecApproval> | null, opts: Partial<Parameters<typeof dispatchGateDecision>[0]> = {}) {
  return dispatchGateDecision({
    approvalRaw: over === null ? null : JSON.stringify(approval(over)),
    currentSpecHash: hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT),
    specPath: SPEC,
    planPath: PLAN,
    ...opts,
  });
}

describe('approvalPathForSpec', () => {
  it('puts the approval next to the spec', () => {
    expect(approvalPathForSpec(SPEC)).toBe(
      'docs/superpowers/specs/2026-09-09-thing-design.approval.json',
    );
  });

  it('rejects a path that is not markdown', () => {
    expect(() => approvalPathForSpec('docs/spec.txt')).toThrow(/must end in .md/);
  });

  it('gives two specs in one repo two distinct approvals', () => {
    expect(approvalPathForSpec('docs/a.md')).not.toBe(approvalPathForSpec('docs/b.md'));
  });
});

describe('hashSpecAndPlan', () => {
  it('changes when the spec changes', () => {
    expect(hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT)).not.toBe(
      hashSpecAndPlan(SPEC_TEXT + 'AC-2: also this.\n', PLAN_TEXT),
    );
  });

  it('changes when only the plan changes', () => {
    expect(hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT)).not.toBe(
      hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT + 'Task 2\n'),
    );
  });

  it('does not confuse a boundary shift between the two documents', () => {
    // Without a separator, 'ab' + 'c' and 'a' + 'bc' would hash alike.
    expect(hashSpecAndPlan('ab', 'c')).not.toBe(hashSpecAndPlan('a', 'bc'));
  });

  it('accepts a null plan', () => {
    expect(hashSpecAndPlan(SPEC_TEXT, null)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseSpecApproval', () => {
  it('accepts a well-formed record', () => {
    const r = parseSpecApproval(JSON.stringify(approval()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.approval.review_rounds).toBe(2);
  });

  it('accepts a null plan_path', () => {
    const r = parseSpecApproval(JSON.stringify(approval({ plan_path: null })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.approval.plan_path).toBeNull();
  });

  it.each([
    ['not JSON at all', 'this is not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"approved"'],
  ])('rejects %s', (_label, raw) => {
    expect(parseSpecApproval(raw).ok).toBe(false);
  });

  it.each([
    ['spec_path', { spec_path: '' }],
    ['approved_by', { approved_by: '   ' }],
    ['plan_path', { plan_path: '' }],
  ])('rejects a blank %s', (_field, over) => {
    expect(parseSpecApproval(JSON.stringify(approval(over as Partial<SpecApproval>))).ok).toBe(false);
  });

  it('rejects a digest that is not 64 hex characters', () => {
    expect(parseSpecApproval(JSON.stringify(approval({ spec_sha256: 'abc123' }))).ok).toBe(false);
  });

  it('rejects an uppercase digest, so comparison stays case-exact', () => {
    const upper = hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT).toUpperCase();
    expect(parseSpecApproval(JSON.stringify(approval({ spec_sha256: upper }))).ok).toBe(false);
  });

  it('rejects an unknown verdict', () => {
    const raw = JSON.stringify({ ...approval(), review_verdict: 'approved' });
    expect(parseSpecApproval(raw).ok).toBe(false);
  });

  it('rejects zero or fractional review rounds', () => {
    expect(parseSpecApproval(JSON.stringify(approval({ review_rounds: 0 }))).ok).toBe(false);
    expect(parseSpecApproval(JSON.stringify(approval({ review_rounds: 1.5 }))).ok).toBe(false);
  });
});

describe('dispatchGateDecision', () => {
  it('allows a current, clean, hash-matched approval', () => {
    const d = gate({});
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('ok');
    expect(d.message).toContain('ali@example.com');
    expect(d.message).toContain('2 round(s)');
  });

  it('refuses when no approval exists, and names the path to write', () => {
    const d = gate(null);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('missing');
    expect(d.message).toContain('2026-09-09-thing-design.approval.json');
  });

  it('refuses an approval it cannot parse rather than assuming intent', () => {
    const d = dispatchGateDecision({
      approvalRaw: '{ truncated',
      currentSpecHash: hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT),
      specPath: SPEC,
      planPath: PLAN,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('malformed');
  });

  it('refuses a schema version it does not understand', () => {
    const d = gate({ schema_version: SPEC_APPROVAL_SCHEMA_VERSION + 1 });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('schema-too-new');
  });

  it.each([['blocker'], ['concerns']] as const)(
    'refuses an approval recorded against a %s review',
    (verdict) => {
      const d = gate({ review_verdict: verdict });
      expect(d.allow).toBe(false);
      expect(d.reason).toBe('unclean-verdict');
    },
  );

  it('refuses once the spec is edited after approval', () => {
    const d = dispatchGateDecision({
      approvalRaw: JSON.stringify(approval()),
      currentSpecHash: hashSpecAndPlan(SPEC_TEXT + '\nAC-2: sneaked in.\n', PLAN_TEXT),
      specPath: SPEC,
      planPath: PLAN,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('spec-changed');
  });

  it('refuses once only the plan is edited after approval', () => {
    const d = dispatchGateDecision({
      approvalRaw: JSON.stringify(approval()),
      currentSpecHash: hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT + '\nTask 9: rewrite everything.\n'),
      specPath: SPEC,
      planPath: PLAN,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('spec-changed');
  });

  it('refuses an approval harvested from a different feature', () => {
    const d = gate({ spec_path: 'docs/superpowers/specs/2026-01-01-other-design.md' });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('path-mismatch');
  });

  it('refuses when the issue names a plan the approval does not cover', () => {
    const d = dispatchGateDecision({
      approvalRaw: JSON.stringify(approval({ plan_path: null })),
      currentSpecHash: hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT),
      specPath: SPEC,
      planPath: PLAN,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('path-mismatch');
    expect(d.message).toContain('(no plan)');
  });

  it('allows a plan-less quick-dev spec whose approval also has no plan', () => {
    const d = dispatchGateDecision({
      approvalRaw: JSON.stringify(
        approval({ plan_path: null, spec_sha256: hashSpecAndPlan(SPEC_TEXT, null), review_rounds: 1 }),
      ),
      currentSpecHash: hashSpecAndPlan(SPEC_TEXT, null),
      specPath: SPEC,
      planPath: null,
    });
    expect(d.allow).toBe(true);
  });

  it('does not let a hash-matched concerns approval through the mechanical gate', () => {
    // The review-and-correct loop that produces a clean verdict lives in a
    // skill, which is prose. Accepting `concerns` here would leave the only
    // enforcement of that loop in a document an agent can read past.
    const d = gate({ review_verdict: 'concerns' });
    expect(d.allow).toBe(false);
    expect(d.message).toContain('clean');
  });

  it('lets the override label through, but states what it overrode', () => {
    const d = gate(null, { overrideRequested: true });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('override');
    expect(d.message).toContain(OVERRIDE_LABEL);
    expect(d.message).toContain('no approval recorded');
  });

  it('does not relabel a genuine approval as an override', () => {
    const d = gate({}, { overrideRequested: true });
    expect(d.reason).toBe('ok');
  });
});

describe('resolveRefusal', () => {
  it('passes a refusal through untouched without the label', () => {
    expect(resolveRefusal('missing', 'nothing here')).toEqual({
      allow: false,
      reason: 'missing',
      message: 'nothing here',
    });
  });

  it('converts any refusal into a stated override', () => {
    const d = resolveRefusal('spec-changed', 'the text moved', true);
    expect(d.allow).toBe(true);
    expect(d.message).toContain('the text moved');
  });
});

describe('dashboard mirror', () => {
  it('is byte-identical to the engine copy', () => {
    // The dashboard deploys with rootDirectory=dashboard/, which excludes the
    // engine's lib/. The copy is what ships; this test is what keeps a fix to
    // one of them from silently missing the other.
    const root = resolve(__dirname, '../..');
    expect(readFileSync(resolve(root, 'dashboard/lib/spec-approval.ts'), 'utf8')).toBe(
      readFileSync(resolve(root, 'lib/spec-approval.ts'), 'utf8'),
    );
  });
});

describe('rollout compatibility', () => {
  it('keeps the spec schema version at 1', () => {
    // Bumping it makes every newly written approval refuse as schema-too-new
    // on any dashboard deployed before the engine rolls out.
    expect(SPEC_APPROVAL_SCHEMA_VERSION).toBe(1);
  });

  it('still reads an approval written before the kind field existed', () => {
    // Every approval already committed in consumer repos predates the `kind`
    // field, so a parser that starts requiring it would refuse records that
    // are still perfectly valid. This guard catches that regression.
    const legacy = JSON.stringify({
      schema_version: 1,
      spec_path: 'docs/superpowers/specs/2026-05-01-foo-design.md',
      plan_path: null,
      spec_sha256: 'd'.repeat(64),
      review_verdict: 'ok',
      review_rounds: 1,
      approved_by: 'ali@example.com',
      approved_at: '2026-05-01T00:00:00.000Z',
    });
    expect(parseSpecApproval(legacy).ok).toBe(true);
  });
});
