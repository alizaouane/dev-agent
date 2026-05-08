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

  it('handles malformed JSON lines as mismatches (with classifier-unknown)', () => {
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
