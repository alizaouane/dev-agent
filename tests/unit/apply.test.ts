import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applySearchReplace, sha256OfContent } from '../../lib/apply';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return rel;
}

describe('applySearchReplace', () => {
  it('applies a clean TS edit and reports the new SHA', () => {
    const orig = 'export const x = 1;\nexport const y = 2;\n';
    const file = write('a.ts', orig);
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: 'export const x = 1;', replace: 'export const x = 99;' },
      { repoRoot: dir },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const written = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(written).toBe('export const x = 99;\nexport const y = 2;\n');
      expect(r.new_sha).toBe(sha256OfContent(written));
    }
  });

  it('rejects hash-mismatch when the file changed under the agent', () => {
    const orig = 'one;\n';
    const file = write('a.ts', orig);
    // Simulate someone (or another phase) editing the file after the agent observed it.
    fs.writeFileSync(path.join(dir, file), 'two;\n', 'utf8');
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: 'two;', replace: 'three;' },
      { repoRoot: dir },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('hash-mismatch');
      expect(r.details).toMatch(/SHA-256 changed/);
    }
  });

  it('rejects when the search text is missing', () => {
    const orig = 'one;\n';
    const file = write('a.ts', orig);
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: 'missing;', replace: 'x;' },
      { repoRoot: dir },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('search-not-found');
  });

  it('rejects when the search text is ambiguous (multiple matches)', () => {
    const orig = 'const x = 1;\nconst x = 2;\n';
    const file = write('a.ts', orig);
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: 'const x', replace: 'const y' },
      { repoRoot: dir },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('search-not-unique');
      expect(r.details).toMatch(/enlarge/);
    }
  });

  it('rejects edits that produce TS syntax errors and does NOT write the file', () => {
    const orig = 'export const x = 1;\n';
    const file = write('a.ts', orig);
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: 'export const x = 1;', replace: 'export const x =;' },
      { repoRoot: dir },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('syntax-error');
    // File must be unchanged.
    expect(fs.readFileSync(path.join(dir, file), 'utf8')).toBe(orig);
  });

  it('validates JSX in .tsx files', () => {
    const orig = 'export const X = () => <div>hello</div>;\n';
    const file = write('a.tsx', orig);
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: '<div>hello</div>', replace: '<div>world</div>' },
      { repoRoot: dir },
    );
    expect(r.ok).toBe(true);
  });

  it('rejects malformed JSX in .tsx files', () => {
    const orig = 'export const X = () => <div>hello</div>;\n';
    const file = write('a.tsx', orig);
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: '<div>hello</div>', replace: '<div>world</div' /* missing > */ },
      { repoRoot: dir },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('syntax-error');
  });

  it('skips AST check for languages we cannot parse yet (.py)', () => {
    // Python AST validation lands in step 3 with multi-language tree-sitter.
    // For v1, .py edits get hash + uniqueness checks but no syntax gate.
    const orig = 'def hello():\n    return 1\n';
    const file = write('a.py', orig);
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: 'return 1', replace: 'return broken syntax(' },
      { repoRoot: dir },
    );
    expect(r.ok).toBe(true); // No AST check for .py in v1
  });

  it('skips AST check for non-code files (.md)', () => {
    const orig = '# Title\n\nSome prose.\n';
    const file = write('a.md', orig);
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: 'Some prose.', replace: 'Different prose.' },
      { repoRoot: dir },
    );
    expect(r.ok).toBe(true);
  });

  it('honors repoRoot so callers can apply edits to a sandbox', () => {
    const orig = 'sandboxed;\n';
    const file = write('nested/a.ts', orig);
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: 'sandboxed;', replace: 'changed;' },
      { repoRoot: dir },
    );
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, file), 'utf8')).toBe('changed;\n');
  });

  it('lets callers disable syntax validation explicitly', () => {
    const orig = 'export const x = 1;\n';
    const file = write('a.ts', orig);
    const r = applySearchReplace(
      { file, sha: sha256OfContent(orig), search: 'export const x = 1;', replace: 'export const x =;' },
      { repoRoot: dir, validateSyntax: false },
    );
    expect(r.ok).toBe(true); // Forced through despite invalid TS
  });
});
