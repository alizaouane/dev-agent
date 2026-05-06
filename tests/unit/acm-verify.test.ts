import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tokenizeCmd, checkLocks, checkSpecHash, envBool } from '../../lib/cli/acm-verify';
import { computeSha256, type ACMManifest } from '../../lib/acm';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-verify-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function buildManifest(testFiles: Record<string, string>, specContent: string): ACMManifest {
  const criteria = Object.entries(testFiles).map(([rel, content], i) => ({
    id: `AC-${i + 1}`,
    text: `criterion ${i + 1}`,
    raw: `- [ ] criterion ${i + 1}`,
    checked: false,
    test_file: rel,
    test_name: `AC-${i + 1}`,
    test_sha256: computeSha256(content),
  }));
  return {
    spec_path: 'docs/specs/demo.md',
    spec_sha256: computeSha256(specContent),
    generated_at: '2026-05-06T12:00:00.000Z',
    criteria,
  };
}

describe('tokenizeCmd', () => {
  it('splits a simple command into program + args', () => {
    expect(tokenizeCmd('npm test --')).toEqual({ program: 'npm', args: ['test', '--'] });
    expect(tokenizeCmd('pytest')).toEqual({ program: 'pytest', args: [] });
    expect(tokenizeCmd('bun test')).toEqual({ program: 'bun', args: ['test'] });
  });

  it('collapses runs of whitespace', () => {
    expect(tokenizeCmd('npm   test    --')).toEqual({ program: 'npm', args: ['test', '--'] });
  });

  it('rejects empty input', () => {
    expect(() => tokenizeCmd('')).toThrow(/empty/);
    expect(() => tokenizeCmd('   ')).toThrow(/empty/);
  });

  it('rejects shell metacharacters at parse time', () => {
    expect(() => tokenizeCmd('npm test | grep foo')).toThrow(/metacharacter/);
    expect(() => tokenizeCmd('npm test && echo done')).toThrow(/metacharacter/);
    expect(() => tokenizeCmd('npm test; rm -rf /')).toThrow(/metacharacter/);
    expect(() => tokenizeCmd('npm test `whoami`')).toThrow(/metacharacter/);
    expect(() => tokenizeCmd('npm test $HOME')).toThrow(/metacharacter/);
  });
});

describe('envBool', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('returns the default when unset', () => {
    delete process.env.X;
    expect(envBool('X', true)).toBe(true);
    expect(envBool('X', false)).toBe(false);
  });

  it('treats "false", "0", and "" as falsy', () => {
    process.env.X = 'false';
    expect(envBool('X', true)).toBe(false);
    process.env.X = '0';
    expect(envBool('X', true)).toBe(false);
    process.env.X = '';
    expect(envBool('X', true)).toBe(false);
  });

  it('treats anything else as truthy', () => {
    process.env.X = 'true';
    expect(envBool('X', false)).toBe(true);
    process.env.X = 'yes';
    expect(envBool('X', false)).toBe(true);
    process.env.X = '1';
    expect(envBool('X', false)).toBe(true);
  });
});

describe('checkLocks', () => {
  it('returns pass when every test file matches its manifest hash', () => {
    write('tests/acm/a.test.ts', 'expect(false).toBe(true);');
    const manifest = buildManifest({ 'tests/acm/a.test.ts': 'expect(false).toBe(true);' }, 'spec content');
    expect(checkLocks(manifest, dir).verdict).toBe('pass');
  });

  it('detects when a test file has been mutated post-manifest', () => {
    write('tests/acm/a.test.ts', 'expect(true).toBe(true);'); // vacuous — different from manifest
    const manifest = buildManifest({ 'tests/acm/a.test.ts': 'expect(false).toBe(true);' }, 'spec content');
    const r = checkLocks(manifest, dir);
    expect(r.verdict).toBe('fail');
    expect(r.mismatched[0]).toMatch(/a\.test\.ts SHA changed/);
  });

  it('detects when a test file is missing from disk', () => {
    const manifest = buildManifest({ 'tests/acm/a.test.ts': 'never written' }, 'spec content');
    const r = checkLocks(manifest, dir);
    expect(r.verdict).toBe('fail');
    expect(r.mismatched[0]).toMatch(/not found on disk/);
  });

  it('detects when a manifest entry has no test_file or test_sha256', () => {
    const manifest: ACMManifest = {
      spec_path: 'docs/specs/x.md',
      spec_sha256: 'a'.repeat(64),
      generated_at: '2026-05-06',
      criteria: [{ id: 'AC-1', text: 't', raw: '', checked: false }],
    };
    const r = checkLocks(manifest, dir);
    expect(r.verdict).toBe('fail');
    expect(r.mismatched[0]).toMatch(/missing test_file or test_sha256/);
  });
});

describe('checkSpecHash', () => {
  it('returns pass when the spec hash matches', () => {
    const spec = '## Acceptance criteria\n\n- [ ] a';
    write('docs/specs/demo.md', spec);
    const manifest = buildManifest({}, spec);
    const r = checkSpecHash(manifest, dir);
    expect(r.verdict).toBe('pass');
  });

  it('returns fail when the spec has been edited since manifest generation', () => {
    write('docs/specs/demo.md', 'edited spec');
    const manifest = buildManifest({}, 'original spec');
    const r = checkSpecHash(manifest, dir);
    expect(r.verdict).toBe('fail');
    expect(r.expected).not.toBe(r.observed);
  });

  it('returns fail when the spec file is missing', () => {
    const manifest = buildManifest({}, 'will not be written');
    const r = checkSpecHash(manifest, dir);
    expect(r.verdict).toBe('fail');
    expect(r.observed).toBe('<spec-not-found>');
  });
});
