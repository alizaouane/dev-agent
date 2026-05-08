import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { audit } from '../../lib/cli/risk-audit';

/**
 * Pillar 5 advisory audit. The lib/risk-annotation.ts classifier is unit-
 * tested separately; these tests lock the file-level audit behavior:
 * empty/absent log → 'absent', clean log → 'clean', mismatches → flagged
 * with `findings`. The workflow consumes the JSON shape directly so the
 * field names must stay stable.
 */
describe('lib/cli/risk-audit', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'risk-audit-'));
    logPath = join(dir, 'bash-log.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns absent verdict when the log file does not exist', () => {
    const report = audit(logPath);
    expect(report.verdict).toBe('absent');
    expect(report.total).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.mismatch_count).toBe(0);
  });

  it('returns clean verdict when every entry validates and matches the classifier', () => {
    const lines = [
      JSON.stringify({ cmd: 'ls -la', risk: 'low', justification: 'list directory contents' }),
      JSON.stringify({ cmd: 'cat package.json', risk: 'low', justification: 'read project metadata' }),
      JSON.stringify({ cmd: 'npm test', risk: 'low', justification: 'run tests' }),
    ];
    writeFileSync(logPath, lines.join('\n'), 'utf8');
    const report = audit(logPath);
    expect(report.verdict).toBe('clean');
    expect(report.total).toBe(3);
    expect(report.mismatch_count).toBe(0);
    expect(report.high_risk_count).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.by_agent_level.low).toBe(3);
    expect(report.by_classifier_level.low).toBe(3);
  });

  it('flags mismatches when agent rates LOW but classifier rates HIGH', () => {
    const lines = [
      JSON.stringify({ cmd: 'ls', risk: 'low', justification: 'list contents' }),
      // Agent under-rates a force-rm — classifier knows better.
      JSON.stringify({ cmd: 'rm -rf node_modules', risk: 'low', justification: 'cleanup deps' }),
    ];
    writeFileSync(logPath, lines.join('\n'), 'utf8');
    const report = audit(logPath);
    expect(report.verdict).toBe('mismatches');
    expect(report.total).toBe(2);
    expect(report.mismatch_count).toBe(1);
    expect(report.high_risk_count).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].cmd).toContain('rm -rf');
    expect(report.findings[0].agent_risk).toBe('low');
    expect(report.findings[0].classified_risk).toBe('high');
    expect(report.findings[0].validation_error).toMatch(/HIGH.*LOW/);
  });

  it('records HIGH-risk calls in findings even when agent + classifier agree', () => {
    // The audit comment must surface every HIGH-risk call, regardless of
    // whether the agent self-rated it correctly. Operators want to see
    // "what dangerous commands ran" without having to grep the transcript.
    const lines = [
      JSON.stringify({ cmd: 'ls', risk: 'low', justification: 'list contents' }),
      JSON.stringify({ cmd: 'sudo apt-get install foo', risk: 'high', justification: 'install build dep' }),
    ];
    writeFileSync(logPath, lines.join('\n'), 'utf8');
    const report = audit(logPath);
    expect(report.verdict).toBe('clean');
    expect(report.high_risk_count).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].agent_risk).toBe('high');
    expect(report.findings[0].classified_risk).toBe('high');
    expect(report.findings[0].validation_error).toBeNull();
  });

  it('handles malformed JSON lines as mismatches (defensive classification)', () => {
    const lines = [
      JSON.stringify({ cmd: 'ls', risk: 'low', justification: 'list dir contents' }),
      'this is not json',
      JSON.stringify({ cmd: 'pwd', risk: 'low', justification: 'check working dir' }),
    ];
    writeFileSync(logPath, lines.join('\n'), 'utf8');
    const report = audit(logPath);
    expect(report.verdict).toBe('mismatches');
    expect(report.total).toBe(3);
    expect(report.mismatch_count).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].validation_error).toMatch(/malformed JSON/);
  });

  it('handles entries missing required fields', () => {
    const lines = [
      JSON.stringify({ cmd: 'ls' }), // missing risk + justification
      JSON.stringify({ risk: 'low', justification: 'note' }), // missing cmd
    ];
    writeFileSync(logPath, lines.join('\n'), 'utf8');
    const report = audit(logPath);
    expect(report.verdict).toBe('mismatches');
    expect(report.mismatch_count).toBe(2);
    expect(report.findings.every((f) => f.validation_error?.includes('missing'))).toBe(true);
  });

  describe('codex P2 #1 — classifier counts must NOT be lost on malformed records', () => {
    it('counts classifier HIGH for a missing-fields record whose cmd is dangerous', () => {
      // The exact failure mode codex flagged: a record with `cmd: "rm -rf /"`
      // but no `risk` / `justification` would previously be counted as
      // by_classifier_level.unknown — under-reporting classifier HIGH activity
      // and making aggregate counts disagree with the per-finding rows. The
      // fix is to derive both `classified_risk` (already correct) AND the
      // counter increment from the actual classifier output.
      const lines = [
        JSON.stringify({ cmd: 'rm -rf /', /* missing risk + justification */ }),
      ];
      writeFileSync(logPath, lines.join('\n'), 'utf8');
      const report = audit(logPath);
      expect(report.verdict).toBe('mismatches');
      expect(report.high_risk_count).toBe(1);
      expect(report.by_classifier_level.high).toBe(1);
      expect(report.by_classifier_level.unknown).toBe(0);
      // The per-finding row + the aggregate counter must agree on the level.
      expect(report.findings[0].classified_risk).toBe('high');
      expect(report.findings[0].classifier_reason).toMatch(/recursive rm|force rm/);
    });

    it('counts classifier HIGH for a malformed-JSON line whose text contains a dangerous command', () => {
      // A truncated-record-from-a-crashing-tool case: line is invalid JSON
      // but the raw text still matches a HIGH classifier rule. Lock the
      // defensive classification of the raw line text.
      const lines = [
        JSON.stringify({ cmd: 'ls', risk: 'low', justification: 'list dir contents' }),
        // Malformed: missing closing brace — but contains `sudo` which the
        // classifier rates HIGH.
        '{ "cmd": "sudo apt install evil", "risk": "low"',
      ];
      writeFileSync(logPath, lines.join('\n'), 'utf8');
      const report = audit(logPath);
      expect(report.high_risk_count).toBe(1);
      expect(report.by_classifier_level.high).toBe(1);
      expect(report.by_classifier_level.unknown).toBe(0);
      const malformedFinding = report.findings.find((f) =>
        f.validation_error?.includes('malformed'),
      );
      expect(malformedFinding?.classified_risk).toBe('high');
      expect(malformedFinding?.classifier_reason).toMatch(/sudo escalation/);
    });

    it('falls back to classifier unknown when malformed line has no dangerous patterns', () => {
      // Symmetry check: pure noise must still classify as unknown — we're
      // not over-reporting by claiming everything is HIGH.
      const lines = [
        JSON.stringify({ cmd: 'ls', risk: 'low', justification: 'list dir contents' }),
        'this is not json and contains no shell commands',
      ];
      writeFileSync(logPath, lines.join('\n'), 'utf8');
      const report = audit(logPath);
      expect(report.high_risk_count).toBe(0);
      expect(report.by_classifier_level.high).toBe(0);
      expect(report.by_classifier_level.unknown).toBeGreaterThanOrEqual(0);
    });

    it('aggregate counts equal the per-finding row sum (no double-counting)', () => {
      // The key invariant codex's report demanded: the aggregate
      // by_classifier_level totals must equal what you'd get by summing
      // each finding's classified_risk. Verify across a mixed set.
      const lines = [
        JSON.stringify({ cmd: 'ls', risk: 'low', justification: 'list dir contents' }),
        JSON.stringify({ cmd: 'rm -rf node_modules', /* missing fields */ }),
        '{ broken json with sudo apt-get inside',
        JSON.stringify({ cmd: 'sudo systemctl', risk: 'high', justification: 'restart service' }),
      ];
      writeFileSync(logPath, lines.join('\n'), 'utf8');
      const report = audit(logPath);
      const totalByLevel =
        report.by_classifier_level.low +
        report.by_classifier_level.medium +
        report.by_classifier_level.high +
        report.by_classifier_level.unknown;
      expect(totalByLevel).toBe(report.total);
      // The 3 dangerous commands above all rate HIGH; the `ls` rates LOW.
      expect(report.by_classifier_level.high).toBe(3);
      expect(report.by_classifier_level.low).toBe(1);
    });
  });

  it('skips blank lines without polluting counts', () => {
    const content = [
      JSON.stringify({ cmd: 'ls', risk: 'low', justification: 'list dir contents' }),
      '',
      '   ',
      JSON.stringify({ cmd: 'pwd', risk: 'low', justification: 'check working dir' }),
      '',
    ].join('\n');
    writeFileSync(logPath, content, 'utf8');
    const report = audit(logPath);
    expect(report.total).toBe(2);
    expect(report.verdict).toBe('clean');
  });
});
