import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseLabels, verifyApproval } from '../../lib/cli/verify-approval';
import { buildApproval } from '../../lib/cli/approve-spec';
import { OVERRIDE_LABEL } from '../../lib/spec-approval';

const SPEC = 'docs/superpowers/specs/thing-design.md';
const PLAN = 'docs/superpowers/plans/thing.md';
const APPROVAL = 'docs/superpowers/specs/thing-design.approval.json';
const SPEC_TEXT = '# Thing\n\nAC-1: it works.\n';
const PLAN_TEXT = '# Plan\n\nTask 1 (AC: 1)\n';

let repo: string;

/** Write a repo-relative file, creating parent directories as needed. */
function put(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** Record a real approval for the spec and plan currently on the checkout. */
function approve(planPath: string | null = PLAN): void {
  const { approval, outPath } = buildApproval({
    specPath: SPEC,
    planPath,
    reviewVerdict: 'ok',
    reviewRounds: 1,
    approvedBy: 'ali@example.com',
    repoRoot: repo,
    now: () => new Date('2026-09-09T10:00:00.000Z'),
  });
  put(outPath, JSON.stringify(approval, null, 2));
}

/** Verify with the canonical paths, overridable per test. */
function verify(over: Partial<Parameters<typeof verifyApproval>[0]> = {}) {
  return verifyApproval({
    specPath: SPEC,
    planPath: PLAN,
    labels: [],
    repoRoot: repo,
    ...over,
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'verify-approval-test-'));
  put(SPEC, SPEC_TEXT);
  put(PLAN, PLAN_TEXT);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('parseLabels', () => {
  it('splits on commas and newlines and drops blanks', () => {
    expect(parseLabels('a, b\nc,,\n')).toEqual(['a', 'b', 'c']);
  });

  it('treats an unset value as no labels', () => {
    expect(parseLabels(undefined)).toEqual([]);
    expect(parseLabels('')).toEqual([]);
  });
});

describe('verifyApproval', () => {
  it('allows a checkout whose approval matches the committed text', () => {
    approve();
    const d = verify();
    expect(d.allow).toBe(true);
    expect(d.message).toContain('ali@example.com');
  });

  it('refuses when no approval was ever committed', () => {
    const d = verify();
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('missing');
  });

  it('refuses when the spec was edited after approval', () => {
    approve();
    put(SPEC, SPEC_TEXT + 'AC-2: sneaked in after approval.\n');
    const d = verify();
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('spec-changed');
  });

  it('refuses when the plan was edited after approval', () => {
    approve();
    put(PLAN, PLAN_TEXT + 'Task 9: rewrite everything.\n');
    const d = verify();
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('spec-changed');
  });

  it('refuses the workflow placeholder spec rather than treating it as unchecked', () => {
    // phase-implement writes `<specs_dir>/placeholder-no-spec.md` when it
    // cannot find a spec link. That file has no approval beside it, so it
    // must refuse — a spec nobody wrote is not a spec anybody approved.
    const d = verify({ specPath: 'docs/specs/placeholder-no-spec.md', planPath: null });
    expect(d.allow).toBe(false);
  });

  it('refuses when the resolved spec is not on the checkout at all', () => {
    const d = verify({ specPath: 'docs/superpowers/specs/absent.md', planPath: null });
    expect(d.allow).toBe(false);
    expect(d.message).toContain('not on this checkout');
  });

  it('refuses when the workflow resolved a different spec than the one approved', () => {
    // The failure this step exists for: the dashboard and the workflow derive
    // the spec path with different code. If the workflow lands on another
    // file, that file's own approval is what gets checked — and it has none.
    approve();
    put('docs/superpowers/specs/legacy-design.md', '# Legacy\n');
    const d = verify({ specPath: 'docs/superpowers/specs/legacy-design.md', planPath: null });
    expect(d.allow).toBe(false);
  });

  it('allows a plan-less quick-dev spec approved without a plan', () => {
    approve(null);
    const d = verify({ planPath: null });
    expect(d.allow).toBe(true);
  });

  it('refuses when the workflow found a plan the approval does not cover', () => {
    approve(null);
    const d = verify();
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('path-mismatch');
  });

  it('lets the override label through on any refusal, and says so', () => {
    const d = verify({ labels: [OVERRIDE_LABEL] });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('override');
  });

  it('lets the override label through even when the spec is absent', () => {
    const d = verify({ specPath: 'docs/absent.md', planPath: null, labels: [OVERRIDE_LABEL] });
    expect(d.allow).toBe(true);
  });

  it('ignores unrelated labels', () => {
    approve();
    put(SPEC, SPEC_TEXT + 'edited\n');
    const d = verify({ labels: ['state:spec-ready', 'kind:feature'] });
    expect(d.allow).toBe(false);
  });

  it('rejects a corrupt approval file rather than reading past it', () => {
    put(APPROVAL, '{ truncated');
    const d = verify();
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('malformed');
  });
});
