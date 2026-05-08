import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summarizeBundle, CAP_PER_SCANNER, AST_DIFF_EXCERPT_BYTES } from '../../lib/evidence-summary';

/**
 * v1.6 (PR follow-up to #77): the swarm reviewers go from "PR diff only" to
 * "PR diff + evidence summary". The summarizer normalizes the
 * evidence-collector outputs into a stable, capped JSON shape so reviewer
 * prompts can't blow context. These tests lock the shape in — reviewer
 * prompt templates depend on the exact field names.
 */
describe('lib/evidence-summary', () => {
  let bundleDir: string;

  beforeEach(() => {
    bundleDir = mkdtempSync(join(tmpdir(), 'evidence-summary-'));
  });

  afterEach(() => {
    rmSync(bundleDir, { recursive: true, force: true });
  });

  function writeBundle(files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
      const p = join(bundleDir, name);
      mkdirSync(join(bundleDir, '.'), { recursive: true });
      writeFileSync(p, content, 'utf8');
    }
  }

  it('returns the stable shape even when the bundle is empty', () => {
    const summary = summarizeBundle(bundleDir);
    expect(summary.meta).toEqual({ pr_number: null, head_sha: null, generated_at: null });
    expect(summary.scanners.gitleaks).toEqual({ count: 0, findings: [] });
    expect(summary.scanners.semgrep).toEqual({ high_count: 0, total_count: 0, findings: [] });
    expect(summary.scanners.npm_audit).toEqual({ high_count: 0, total_count: 0, findings: [] });
    expect(summary.ast_diff_excerpt).toBe('');
  });

  it('extracts gitleaks findings from a flat-array shape', () => {
    writeBundle({
      'gitleaks.json': JSON.stringify([
        {
          File: 'src/config.ts',
          StartLine: 42,
          RuleID: 'aws-access-token',
          Match: 'AKIA' + 'EXAMPLEKEY',
        },
        {
          File: 'src/db.ts',
          StartLine: 17,
          RuleID: 'generic-api-key',
          Match: 'sk_live_abc',
        },
      ]),
    });
    const summary = summarizeBundle(bundleDir);
    expect(summary.scanners.gitleaks.count).toBe(2);
    expect(summary.scanners.gitleaks.findings).toHaveLength(2);
    expect(summary.scanners.gitleaks.findings[0]).toMatchObject({
      file: 'src/config.ts',
      line: 42,
      rule: 'aws-access-token',
    });
    // redacted_match is capped at 200 chars (the field is meant for context,
    // not for round-tripping the full secret value).
    expect(summary.scanners.gitleaks.findings[0].redacted_match.length).toBeLessThanOrEqual(200);
  });

  it('extracts gitleaks findings from a { findings: [...] } shape', () => {
    writeBundle({
      'gitleaks.json': JSON.stringify({
        findings: [{ file: 'a.ts', line: 1, rule: 'r', match: 'm' }],
      }),
    });
    const summary = summarizeBundle(bundleDir);
    expect(summary.scanners.gitleaks.count).toBe(1);
    expect(summary.scanners.gitleaks.findings[0]).toMatchObject({ file: 'a.ts', line: 1, rule: 'r' });
  });

  it('caps gitleaks findings at CAP_PER_SCANNER and reports truncation', () => {
    const items = Array.from({ length: CAP_PER_SCANNER + 5 }, (_, i) => ({
      File: `f${i}.ts`,
      StartLine: i,
      RuleID: 'r',
      Match: 'x',
    }));
    writeBundle({ 'gitleaks.json': JSON.stringify(items) });
    const summary = summarizeBundle(bundleDir);
    expect(summary.scanners.gitleaks.count).toBe(CAP_PER_SCANNER + 5);
    expect(summary.scanners.gitleaks.findings).toHaveLength(CAP_PER_SCANNER);
    expect(summary.scanners.gitleaks.truncated_to).toBe(CAP_PER_SCANNER);
  });

  it('summarizes Semgrep with a high_count + sorts ERROR findings to the top', () => {
    writeBundle({
      'semgrep.json': JSON.stringify({
        results: [
          { check_id: 'low-rule', extra: { severity: 'INFO', message: 'low' }, path: 'a.ts', start: { line: 1 } },
          { check_id: 'high-rule', extra: { severity: 'ERROR', message: 'high!' }, path: 'b.ts', start: { line: 2 } },
          { check_id: 'med-rule', extra: { severity: 'WARNING', message: 'med' }, path: 'c.ts', start: { line: 3 } },
        ],
      }),
    });
    const summary = summarizeBundle(bundleDir);
    expect(summary.scanners.semgrep.total_count).toBe(3);
    expect(summary.scanners.semgrep.high_count).toBe(1);
    // ERROR (high) must sort before WARNING/INFO so the cap can't drop it.
    expect(summary.scanners.semgrep.findings[0].severity).toBe('ERROR');
    expect(summary.scanners.semgrep.findings[0].rule).toBe('high-rule');
  });

  it('summarizes npm-audit + counts high+critical as high_count', () => {
    writeBundle({
      'npm-audit.json': JSON.stringify({
        vulnerabilities: {
          'lodash': { severity: 'high', title: 'CVE-2025-x', range: '<4.17.21' },
          'left-pad': { severity: 'critical', title: 'oh no', range: '*' },
          'xyz': { severity: 'low', title: 'minor', range: '<1' },
        },
      }),
    });
    const summary = summarizeBundle(bundleDir);
    expect(summary.scanners.npm_audit.total_count).toBe(3);
    expect(summary.scanners.npm_audit.high_count).toBe(2);
    // critical should sort first (rank > high).
    expect(summary.scanners.npm_audit.findings[0].severity).toBe('critical');
  });

  it('caps the ast-diff excerpt at AST_DIFF_EXCERPT_BYTES', () => {
    const big = 'x'.repeat(AST_DIFF_EXCERPT_BYTES * 3);
    writeBundle({ 'ast-diff.txt': big });
    const summary = summarizeBundle(bundleDir);
    expect(summary.ast_diff_excerpt.length).toBe(AST_DIFF_EXCERPT_BYTES);
  });

  it('passes meta.json fields through verbatim', () => {
    writeBundle({
      'meta.json': JSON.stringify({
        pr_number: 42,
        base_ref: 'main',
        base_sha: 'aaaa',
        head_ref: 'feat/foo',
        head_sha: 'bbbb',
        generated_at: '2026-05-08T10:00:00Z',
      }),
    });
    const summary = summarizeBundle(bundleDir);
    expect(summary.meta.pr_number).toBe(42);
    expect(summary.meta.head_sha).toBe('bbbb');
    expect(summary.meta.generated_at).toBe('2026-05-08T10:00:00Z');
  });

  it('tolerates malformed scanner JSON (returns zero findings, not a throw)', () => {
    writeBundle({
      'gitleaks.json': '{ this is not valid json',
      'semgrep.json': '{ "results": "not-an-array" }',
      'npm-audit.json': 'null',
    });
    const summary = summarizeBundle(bundleDir);
    expect(summary.scanners.gitleaks.count).toBe(0);
    expect(summary.scanners.semgrep.total_count).toBe(0);
    expect(summary.scanners.npm_audit.total_count).toBe(0);
  });
});
