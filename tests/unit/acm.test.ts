import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  extractAcceptanceCriteria,
  lintCriteria,
  computeSha256,
  computeFileHashes,
  validateManifest,
  type ACMManifest,
  type AcceptanceCriterion,
} from '../../lib/acm';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SPECS_DIR = path.join(REPO_ROOT, 'docs', 'specs');

describe('extractAcceptanceCriteria', () => {
  it('returns [] when the spec lacks an acceptance-criteria section', () => {
    const md = '# Title\n\nProse only, no criteria heading.\n';
    expect(extractAcceptanceCriteria(md)).toEqual([]);
  });

  it('returns [] when the heading exists but has no bullets', () => {
    const md = '## Acceptance criteria\n\n(to be added)\n\n## Next section\n';
    expect(extractAcceptanceCriteria(md)).toEqual([]);
  });

  it('extracts checked + unchecked bullets in spec order', () => {
    const md = [
      '# Some feature',
      '',
      '## Acceptance criteria',
      '',
      '- [x] First criterion is observable and testable',
      '- [ ] Second criterion emits a structured log line',
      '- [ ] Third criterion returns HTTP 200 on /health',
      '',
      '## Out of scope',
      '- [ ] This bullet must NOT be picked up',
    ].join('\n');
    const c = extractAcceptanceCriteria(md);
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ id: 'AC-1', checked: true });
    expect(c[0].text).toMatch(/First criterion/);
    expect(c[1]).toMatchObject({ id: 'AC-2', checked: false });
    expect(c[2]).toMatchObject({ id: 'AC-3', checked: false });
  });

  it('handles `### Acceptance criteria` (h3) and case-insensitive heading', () => {
    const md = '### Acceptance Criteria\n\n- [ ] Returns the right value when given input\n';
    const c = extractAcceptanceCriteria(md);
    expect(c).toHaveLength(1);
  });

  it('extracts criteria from every spec under docs/specs/ that has a section', () => {
    const specs = fs.readdirSync(SPECS_DIR).filter((f) => f.endsWith('.md'));
    expect(specs.length).toBeGreaterThan(0);
    let foundAtLeastOne = false;
    for (const f of specs) {
      const md = fs.readFileSync(path.join(SPECS_DIR, f), 'utf8');
      const c = extractAcceptanceCriteria(md);
      if (c.length > 0) {
        foundAtLeastOne = true;
        // Every criterion must have a non-empty text and a stable AC-N id.
        for (const cr of c) {
          expect(cr.text.length).toBeGreaterThan(0);
          expect(cr.id).toMatch(/^AC-\d+$/);
        }
      }
    }
    expect(foundAtLeastOne).toBe(true);
  });
});

describe('lintCriteria', () => {
  it('flags too-short criteria as error', () => {
    const f = lintCriteria([{ id: 'AC-1', text: 'tests', raw: '- [ ] tests', checked: false }]);
    expect(f.some((x) => x.rule === 'too-short' && x.level === 'error')).toBe(true);
  });

  it('flags vague language without measurable threshold as error', () => {
    const f = lintCriteria([
      { id: 'AC-1', text: 'Make the dashboard better and cleaner please', raw: '', checked: false },
    ]);
    expect(f.some((x) => x.rule === 'vague-no-threshold' && x.level === 'error')).toBe(true);
  });

  it('does NOT flag vague language when paired with a measurable threshold', () => {
    const f = lintCriteria([
      { id: 'AC-1', text: 'Render the dashboard 30% faster than baseline', raw: '', checked: false },
    ]);
    expect(f.some((x) => x.rule === 'vague-no-threshold')).toBe(false);
  });

  it('flags compound criteria (multiple "and") as warning', () => {
    const f = lintCriteria([
      {
        id: 'AC-1',
        text: 'The endpoint returns 200 and emits a metric and writes to the log',
        raw: '',
        checked: false,
      },
    ]);
    expect(f.some((x) => x.rule === 'compound' && x.level === 'warning')).toBe(true);
  });

  it('flags missing observable noun as warning', () => {
    const f = lintCriteria([
      { id: 'AC-1', text: 'The system is correct in all cases under heavy load', raw: '', checked: false },
    ]);
    expect(f.some((x) => x.rule === 'no-observable')).toBe(true);
  });

  it('passes a clean criterion with no findings', () => {
    const f = lintCriteria([
      {
        id: 'AC-1',
        text: 'GET /health returns HTTP status 200 with body {"ok": true}',
        raw: '',
        checked: false,
      },
    ]);
    expect(f).toEqual([]);
  });

  it('runs the linter against every existing spec without crashing', () => {
    // The four currently-shipped specs were authored before the linter existed
    // so they may carry findings — that's expected. We verify only that the
    // linter runs end-to-end on real content without crashing or emitting
    // malformed findings. Forward-looking enforcement (zero errors on new
    // specs) is the job of phase-acm, not of this regression test.
    const specs = fs.readdirSync(SPECS_DIR).filter((f) => f.endsWith('.md'));
    for (const f of specs) {
      const md = fs.readFileSync(path.join(SPECS_DIR, f), 'utf8');
      const c = extractAcceptanceCriteria(md);
      const findings = lintCriteria(c);
      for (const x of findings) {
        expect(x.id).toMatch(/^AC-\d+$/);
        expect(['error', 'warning']).toContain(x.level);
        expect(x.rule.length).toBeGreaterThan(0);
        expect(x.message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('computeSha256 + computeFileHashes', () => {
  it('produces the same hash for the same input', () => {
    const a = computeSha256('hello world');
    const b = computeSha256('hello world');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different inputs', () => {
    expect(computeSha256('a')).not.toBe(computeSha256('b'));
  });

  it('hashes a map of files independently', () => {
    const hashes = computeFileHashes({ 'a.ts': 'foo', 'b.ts': 'bar' });
    expect(Object.keys(hashes).sort()).toEqual(['a.ts', 'b.ts']);
    expect(hashes['a.ts']).toBe(computeSha256('foo'));
    expect(hashes['b.ts']).toBe(computeSha256('bar'));
  });
});

describe('validateManifest', () => {
  const baseCriteria: AcceptanceCriterion[] = [
    { id: 'AC-1', text: 'returns 200', raw: '- [ ] returns 200', checked: false },
    { id: 'AC-2', text: 'emits log line', raw: '- [ ] emits log line', checked: false },
  ];

  function fullManifest(): ACMManifest {
    return {
      spec_path: 'docs/specs/demo.md',
      spec_sha256: 'a'.repeat(64),
      generated_at: '2026-05-06T12:00:00.000Z',
      criteria: [
        { ...baseCriteria[0], test_file: 'tests/acm/demo-1.test.ts', test_name: 'AC-1', test_sha256: 'b'.repeat(64) },
        { ...baseCriteria[1], test_file: 'tests/acm/demo-2.test.ts', test_name: 'AC-2', test_sha256: 'c'.repeat(64) },
      ],
    };
  }

  it('passes a complete, consistent manifest', () => {
    const r = validateManifest(fullManifest(), baseCriteria);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('errors on missing top-level fields', () => {
    const m = fullManifest();
    m.spec_path = '';
    m.spec_sha256 = '';
    m.generated_at = '';
    const r = validateManifest(m, baseCriteria);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('spec_path'))).toBe(true);
    expect(r.errors.some((e) => e.includes('spec_sha256'))).toBe(true);
    expect(r.errors.some((e) => e.includes('generated_at'))).toBe(true);
  });

  it('errors when a spec criterion has no manifest entry', () => {
    const m = fullManifest();
    m.criteria = m.criteria.filter((c) => c.id !== 'AC-2');
    const r = validateManifest(m, baseCriteria);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('AC-2') && e.includes('missing'))).toBe(true);
  });

  it('errors when a manifest entry lacks test_file or test_sha256', () => {
    const m = fullManifest();
    m.criteria[0].test_file = undefined;
    m.criteria[1].test_sha256 = undefined;
    const r = validateManifest(m, baseCriteria);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('AC-1') && e.includes('test_file'))).toBe(true);
    expect(r.errors.some((e) => e.includes('AC-2') && e.includes('test_sha256'))).toBe(true);
  });

  it('warns about manifest entries the spec no longer carries', () => {
    const m = fullManifest();
    m.criteria.push({
      id: 'AC-3',
      text: 'stale',
      raw: '',
      checked: false,
      test_file: 'x',
      test_sha256: 'y'.repeat(64),
    });
    const r = validateManifest(m, baseCriteria);
    expect(r.ok).toBe(true); // warning, not error
    expect(r.warnings.some((w) => w.includes('AC-3'))).toBe(true);
  });
});
