import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  validateCase,
  findCorpusFiles,
  loadCases,
  summarize,
  parseArgs,
  type EvalCase,
} from '../../lib/cli/eval-run';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeJsonl(rel: string, lines: object[]): string {
  const full = path.join(tempDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return full;
}

const goodCase: EvalCase = {
  id: 'spec-compliance/pass-clean/01',
  reviewer: 'spec-compliance',
  family: 'pass-clean',
  bucket_minutes: 30,
  inputs: { pr_diff: 'diff' },
  expected_verdict: 'pass',
  expected_findings_count: 0,
};

describe('validateCase', () => {
  it('accepts a well-formed case', () => {
    const r = validateCase(goodCase, 'x.jsonl', 1);
    expect(r.case).toBeDefined();
    expect(r.issue).toBeUndefined();
  });

  it.each([
    ['id missing', { ...goodCase, id: undefined }, /id missing/],
    ['id wrong shape', { ...goodCase, id: 'wrong shape' }, /id missing or invalid/],
    ['reviewer invalid', { ...goodCase, reviewer: 'spec-compliance-bogus' }, /reviewer must be one of/],
    ['family too short', { ...goodCase, family: 'ab' }, /family must be a string/],
    ['bucket_minutes invalid', { ...goodCase, bucket_minutes: 99 }, /bucket_minutes must be one of/],
    ['inputs not object', { ...goodCase, inputs: 'not-an-object' }, /inputs must be an object/],
    ['expected_verdict invalid', { ...goodCase, expected_verdict: 'maybe' }, /expected_verdict must be one of/],
    ['expected_findings_count negative', { ...goodCase, expected_findings_count: -1 }, /non-negative/],
  ])('rejects case with %s', (_label, raw, pattern) => {
    const r = validateCase(raw, 'x.jsonl', 1);
    expect(r.case).toBeUndefined();
    expect(r.issue!.reason).toMatch(pattern as RegExp);
  });

  it('rejects non-objects with a clear error', () => {
    expect(validateCase(null, 'x', 1).issue!.reason).toMatch(/not an object/);
    expect(validateCase('string', 'x', 1).issue!.reason).toMatch(/not an object/);
  });

  it('treats expected_findings_count as optional', () => {
    const { expected_findings_count: _, ...rest } = goodCase;
    const r = validateCase(rest, 'x.jsonl', 1);
    expect(r.case).toBeDefined();
  });
});

describe('findCorpusFiles', () => {
  it('returns [] for a missing directory', () => {
    expect(findCorpusFiles(path.join(tempDir, 'absent'))).toEqual([]);
  });

  it('walks subdirectories recursively', () => {
    writeJsonl('a/b/c.jsonl', [goodCase]);
    writeJsonl('d/e.jsonl', [{ ...goodCase, id: 'spec-compliance/pass-clean/02' }]);
    writeJsonl('skip.txt', []); // non-jsonl file ignored
    const found = findCorpusFiles(tempDir);
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('returns sorted paths for stable ordering', () => {
    writeJsonl('z.jsonl', [goodCase]);
    writeJsonl('a.jsonl', [{ ...goodCase, id: 'spec-compliance/pass-clean/02' }]);
    const found = findCorpusFiles(tempDir);
    expect(found[0]).toMatch(/a\.jsonl$/);
    expect(found[1]).toMatch(/z\.jsonl$/);
  });
});

describe('loadCases', () => {
  it('aggregates valid cases from multiple files', () => {
    writeJsonl('a.jsonl', [goodCase, { ...goodCase, id: 'spec-compliance/pass-clean/02' }]);
    writeJsonl('b.jsonl', [{ ...goodCase, id: 'security-scout/fail-secret/01', reviewer: 'security-scout', family: 'fail-secret' }]);
    const r = loadCases(tempDir);
    expect(r.cases).toHaveLength(3);
    expect(r.issues).toEqual([]);
  });

  it('reports schema issues without aborting the whole load', () => {
    writeJsonl('a.jsonl', [
      goodCase,
      { ...goodCase, id: 'wrong shape' },
      { ...goodCase, id: 'spec-compliance/pass-clean/02' },
    ]);
    const r = loadCases(tempDir);
    expect(r.cases).toHaveLength(2);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].reason).toMatch(/id missing or invalid/);
  });

  it('reports JSON parse errors with line numbers', () => {
    fs.mkdirSync(path.join(tempDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'sub/a.jsonl'), `${JSON.stringify(goodCase)}\nnot-json\n`, 'utf8');
    const r = loadCases(tempDir);
    expect(r.cases).toHaveLength(1);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].reason).toMatch(/not valid JSON/);
    expect(r.issues[0].line).toBe(2);
  });

  it('detects duplicate ids across files', () => {
    writeJsonl('a.jsonl', [goodCase]);
    writeJsonl('b.jsonl', [goodCase]); // same id
    const r = loadCases(tempDir);
    expect(r.cases).toHaveLength(1);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].reason).toMatch(/duplicate id/);
  });

  it('skips empty / whitespace-only lines', () => {
    fs.writeFileSync(
      path.join(tempDir, 'a.jsonl'),
      `\n${JSON.stringify(goodCase)}\n\n   \n${JSON.stringify({ ...goodCase, id: 'spec-compliance/pass-clean/02' })}\n`,
      'utf8',
    );
    const r = loadCases(tempDir);
    expect(r.cases).toHaveLength(2);
    expect(r.issues).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts cases by reviewer / bucket / family / expected_verdict', () => {
    const cases: EvalCase[] = [
      goodCase,
      { ...goodCase, id: 'spec-compliance/pass-clean/02', bucket_minutes: 5 },
      { ...goodCase, id: 'security-scout/fail-secret/01', reviewer: 'security-scout', family: 'fail-secret', expected_verdict: 'fail' },
    ];
    const s = summarize(cases);
    expect(s.total).toBe(3);
    expect(s.by_reviewer['spec-compliance']).toBe(2);
    expect(s.by_reviewer['security-scout']).toBe(1);
    expect(s.by_bucket['30']).toBe(2);
    expect(s.by_bucket['5']).toBe(1);
    expect(s.expected_verdicts['pass']).toBe(2);
    expect(s.expected_verdicts['fail']).toBe(1);
  });
});

describe('parseArgs', () => {
  it('defaults to validate mode + standard paths', () => {
    const a = parseArgs([]);
    expect(a.mode).toBe('validate');
    expect(a.corpusDir).toBe('tests/evals/corpus');
  });

  it('parses --mode=stub|live|validate', () => {
    expect(parseArgs(['--mode=stub']).mode).toBe('stub');
    expect(parseArgs(['--mode=live']).mode).toBe('live');
    expect(parseArgs(['--mode=validate']).mode).toBe('validate');
  });

  it('throws on unknown mode', () => {
    expect(() => parseArgs(['--mode=unknown'])).toThrow(/--mode must be/);
  });

  it('honors --corpus-dir + --baselines + --report + --rebaseline', () => {
    const a = parseArgs(['--corpus-dir', 'x/y', '--baselines', 'b.json', '--report', 'r.json', '--rebaseline']);
    expect(a.corpusDir).toBe('x/y');
    expect(a.baselinesPath).toBe('b.json');
    expect(a.reportPath).toBe('r.json');
    expect(a.rebaseline).toBe(true);
  });
});

describe('integration with real corpus', () => {
  it('loads tests/evals/corpus without issues', () => {
    // The shipped seed corpus must always parse — protects against
    // accidental edits that break the schema. Path is relative to repo root.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const r = loadCases(path.join(repoRoot, 'tests/evals/corpus'));
    expect(r.issues).toEqual([]);
    expect(r.cases.length).toBeGreaterThan(0);
    // Sanity: every case has the right reviewer/family directory pairing.
    for (const c of r.cases) {
      expect(c.id.startsWith(`${c.reviewer}/${c.family}/`)).toBe(true);
    }
  });
});
