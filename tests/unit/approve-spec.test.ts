import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildApproval } from '../../lib/cli/approve-spec';
import { dispatchGateDecision, hashSpecAndPlan } from '../../lib/spec-approval';

const SPEC = 'docs/specs/thing-design.md';
const PLAN = 'docs/plans/thing.md';
const SPEC_TEXT = '# Thing\n\nAC-1: it works.\n';
const PLAN_TEXT = '# Plan\n\nTask 1 (AC: 1)\n';

let repo: string;

/** Write a repo-relative file, creating parent directories as needed. */
function put(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'approve-spec-test-'));
  put(SPEC, SPEC_TEXT);
  put(PLAN, PLAN_TEXT);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Standard inputs for a clean two-round approval. */
function input(over: Partial<Parameters<typeof buildApproval>[0]> = {}) {
  return {
    specPath: SPEC,
    planPath: PLAN as string | null,
    reviewVerdict: 'ok' as const,
    reviewRounds: 2,
    approvedBy: 'ali@example.com',
    repoRoot: repo,
    now: () => new Date('2026-09-09T10:00:00.000Z'),
    ...over,
  };
}

describe('buildApproval', () => {
  it('records the verdict, rounds, approver, and a digest of both documents', () => {
    const { approval, outPath } = buildApproval(input());
    expect(outPath).toBe('docs/specs/thing-design.approval.json');
    expect(approval.review_verdict).toBe('ok');
    expect(approval.review_rounds).toBe(2);
    expect(approval.approved_by).toBe('ali@example.com');
    expect(approval.approved_at).toBe('2026-09-09T10:00:00.000Z');
    expect(approval.spec_sha256).toBe(hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT));
  });

  it('produces a record the gate then accepts', () => {
    const { approval } = buildApproval(input());
    const d = dispatchGateDecision({
      approvalRaw: JSON.stringify(approval),
      currentSpecHash: hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT),
      specPath: SPEC,
      planPath: PLAN,
    });
    expect(d.allow).toBe(true);
  });

  it('refuses to record an approval against a blocking review', () => {
    expect(() => buildApproval(input({ reviewVerdict: 'blocker' }))).toThrow(
      /blocking review/,
    );
  });

  it('refuses a spec that is not on disk, so the digest cannot be of nothing', () => {
    expect(() => buildApproval(input({ specPath: 'docs/specs/absent.md' }))).toThrow(
      /spec not found/,
    );
  });

  it('refuses a plan path that is named but missing', () => {
    expect(() => buildApproval(input({ planPath: 'docs/plans/absent.md' }))).toThrow(
      /plan not found/,
    );
  });

  it('accepts a null plan for the quick-dev route', () => {
    const { approval } = buildApproval(input({ planPath: null, reviewRounds: 1 }));
    expect(approval.plan_path).toBeNull();
    expect(approval.spec_sha256).toBe(hashSpecAndPlan(SPEC_TEXT, null));
  });

  it('rejects a round count that is not a positive integer', () => {
    expect(() => buildApproval(input({ reviewRounds: 0 }))).toThrow(/REVIEW_ROUNDS/);
    expect(() => buildApproval(input({ reviewRounds: 2.5 }))).toThrow(/REVIEW_ROUNDS/);
  });

  it('binds to content, not to the path — same paths, edited text, new digest', () => {
    const before = buildApproval(input()).approval.spec_sha256;
    put(SPEC, SPEC_TEXT + 'AC-2: and this.\n');
    expect(buildApproval(input()).approval.spec_sha256).not.toBe(before);
  });
});
