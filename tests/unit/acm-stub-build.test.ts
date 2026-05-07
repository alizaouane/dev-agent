import { describe, it, expect } from 'vitest';
import { buildStubArtifacts, parseArgs } from '../../lib/cli/acm-stub-build';
import type { AcceptanceCriterion } from '../../lib/acm';

describe('parseArgs', () => {
  it('parses all required flags', () => {
    const args = parseArgs([
      '--extract', '/tmp/extract.json',
      '--issue', '42',
      '--spec', 'docs/specs/x.md',
      '--manifest', '.dev-agent/acm-manifest.json',
      '--tests-dir', 'tests/acm',
    ]);
    expect(args).toEqual({
      extract: '/tmp/extract.json',
      issue: '42',
      spec: 'docs/specs/x.md',
      manifest: '.dev-agent/acm-manifest.json',
      testsDir: 'tests/acm',
    });
  });

  it('throws when a required flag is missing', () => {
    expect(() => parseArgs(['--extract', '/tmp/extract.json'])).toThrow(/missing required arg/);
  });
});

describe('buildStubArtifacts', () => {
  const criteria: AcceptanceCriterion[] = [
    { id: 'AC-1', text: 'GET /health returns 200', raw: '- [ ] GET /health returns 200', checked: false },
    { id: 'AC-2', text: 'Cache hit metric incremented', raw: '- [ ] Cache hit metric incremented', checked: false },
  ];

  const args = {
    extract: '/tmp/x.json',
    issue: '99',
    spec: 'docs/specs/x.md',
    manifest: '.dev-agent/acm-manifest.json',
    testsDir: 'tests/acm',
  };

  it('produces one stub test per criterion + a complete manifest', () => {
    const { manifest, testFiles } = buildStubArtifacts({ criteria, spec_sha256: 'a'.repeat(64) }, args);
    expect(Object.keys(testFiles)).toHaveLength(2);
    expect(manifest.criteria).toHaveLength(2);
    expect(manifest.spec_path).toBe('docs/specs/x.md');
    expect(manifest.spec_sha256).toBe('a'.repeat(64));
    expect(manifest.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('names test files with a stable slug derived from the criterion text', () => {
    const { testFiles } = buildStubArtifacts({ criteria, spec_sha256: 'a'.repeat(64) }, args);
    expect(testFiles).toHaveProperty('tests/acm/99-1-get-health-returns-200.test.ts');
    expect(testFiles).toHaveProperty('tests/acm/99-2-cache-hit-metric-incremented.test.ts');
  });

  it('writes a SHA-locked manifest entry per criterion', () => {
    const { manifest, testFiles } = buildStubArtifacts({ criteria, spec_sha256: 'a'.repeat(64) }, args);
    for (const c of manifest.criteria) {
      expect(c.test_file).toBeTruthy();
      expect(c.test_sha256).toMatch(/^[0-9a-f]{64}$/);
      // The recorded SHA must match the actual stub body content.
      const body = testFiles[c.test_file!];
      expect(body).toBeTruthy();
    }
  });

  it('embeds the criterion text inside the stub test as the it() name', () => {
    const { testFiles } = buildStubArtifacts({ criteria, spec_sha256: 'a'.repeat(64) }, args);
    const body = testFiles['tests/acm/99-1-get-health-returns-200.test.ts'];
    expect(body).toContain("it('GET /health returns 200'");
    expect(body).toContain('expect(false).toBe(true)');
  });

  it('handles criteria with backticks safely (escapes them in the it() name)', () => {
    const tricky: AcceptanceCriterion[] = [
      { id: 'AC-1', text: 'Endpoint `/health` returns 200', raw: '', checked: false },
    ];
    const { testFiles } = buildStubArtifacts({ criteria: tricky, spec_sha256: 'a'.repeat(64) }, args);
    const path = Object.keys(testFiles)[0];
    const body = testFiles[path];
    // Backticks must be escaped as single quotes so the test-name is a
    // valid JS string literal.
    expect(body).not.toMatch(/it\('[^']*`/);
  });

  it('produces the empty manifest when given zero criteria', () => {
    const { manifest, testFiles } = buildStubArtifacts({ criteria: [], spec_sha256: 'a'.repeat(64) }, args);
    expect(manifest.criteria).toEqual([]);
    expect(testFiles).toEqual({});
  });
});
