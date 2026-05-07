import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chunkFile } from '../../lib/index/chunker';
import { retrieve, scoreChunk, tokenize } from '../../lib/index/retrieval';
import { findSourceFiles, runQuery } from '../../lib/cli/index-query';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = path.join(tempDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

describe('chunker — TS/JS', () => {
  it('extracts function declarations', () => {
    const src = [
      'export function alpha(x: number): number {',
      '  return x + 1;',
      '}',
      '',
      'function beta() {',
      '  return 2;',
      '}',
    ].join('\n');
    const chunks = chunkFile('a.ts', src);
    expect(chunks.map((c) => c.name).sort()).toEqual(['alpha', 'beta']);
    expect(chunks.every((c) => c.kind === 'function')).toBe(true);
  });

  it('extracts class declarations', () => {
    const src = 'export class Foo {\n  bar() { return 1; }\n}';
    const chunks = chunkFile('a.ts', src);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe('class');
    expect(chunks[0].name).toBe('Foo');
  });

  it('extracts top-level const / type / interface', () => {
    const src = [
      'export const KEY = 42;',
      'export type Result = { ok: boolean };',
      'export interface User { id: string }',
    ].join('\n');
    const chunks = chunkFile('a.ts', src);
    expect(chunks.map((c) => `${c.kind}:${c.name}`).sort()).toEqual([
      'const:KEY',
      'type:Result',
      'type:User',
    ]);
  });

  it('emits a module-prelude chunk for imports / leading lines', () => {
    const src = [
      "import * as fs from 'node:fs';",
      "import { x } from './x';",
      '',
      'export function alpha() { return 1; }',
    ].join('\n');
    const chunks = chunkFile('a.ts', src);
    expect(chunks[0].kind).toBe('module-prelude');
    expect(chunks[0].content).toContain('import');
    expect(chunks[1].kind).toBe('function');
  });

  it('handles JSX in .tsx files', () => {
    const src = "export const Button = () => <button>x</button>;";
    const chunks = chunkFile('a.tsx', src);
    expect(chunks[0].name).toBe('Button');
    expect(chunks[0].kind).toBe('const');
  });

  it('handles `}` inside string literals during brace balancing', () => {
    // The brace-balancer must NOT close `trickster` at line 2's `}` —
    // that bracket is inside a string literal. v1's chunker also
    // surfaces local consts as separate chunks (no containment
    // analysis); both behaviors are intentional.
    const src = [
      'export function trickster() {',
      '  const greeting = "} not a closer";',
      '  return greeting;',
      '}',
    ].join('\n');
    const chunks = chunkFile('a.ts', src);
    const trickster = chunks.find((c) => c.name === 'trickster');
    expect(trickster).toBeDefined();
    // The function chunk must end at line 4 (the real closer), not line 2.
    expect(trickster!.end_line).toBe(4);
  });
});

describe('chunker — Python', () => {
  it('extracts def + class via indentation', () => {
    const src = [
      'def foo():',
      '    return 1',
      '',
      'class Bar:',
      '    def baz(self):',
      '        return 2',
    ].join('\n');
    const chunks = chunkFile('a.py', src);
    expect(chunks.map((c) => c.name).sort()).toContain('foo');
    expect(chunks.map((c) => c.name).sort()).toContain('Bar');
  });

  it('extracts ALL_CAPS constants', () => {
    const src = "MAX_SIZE = 100\nVERSION = '1.0'";
    const chunks = chunkFile('a.py', src);
    expect(chunks.map((c) => c.name).sort()).toEqual(['MAX_SIZE', 'VERSION']);
  });
});

describe('chunker — unsupported languages', () => {
  it('returns a single module-prelude for non-supported extensions', () => {
    const chunks = chunkFile('README.md', '# Title\n\nSome text.\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe('module-prelude');
  });

  it('skips empty files', () => {
    expect(chunkFile('a.ts', '')).toEqual([]);
    expect(chunkFile('a.ts', '   \n  ')).toEqual([]);
  });
});

describe('retrieval — tokenize', () => {
  it('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('Hello World!')).toEqual(['hello', 'world']);
    expect(tokenize('camelCase_with_snake')).toEqual(['camelcase_with_snake']);
  });

  it('drops single-character tokens', () => {
    expect(tokenize('a b c xy')).toEqual(['xy']);
  });
});

describe('retrieval — scoreChunk', () => {
  const fnChunk = {
    file: 'lib/cache.ts',
    start_line: 1,
    end_line: 10,
    kind: 'function' as const,
    name: 'invalidateCache',
    content: 'function invalidateCache(key: string) { return store.delete(key); }',
  };

  it('boosts matches in the chunk name', () => {
    const single = scoreChunk(fnChunk, ['cache']);
    const noMatch = scoreChunk(fnChunk, ['unrelated']);
    expect(single.score).toBeGreaterThan(0);
    expect(noMatch.score).toBe(0);
  });

  it('matches identifier sub-tokens (camelCase split)', () => {
    const r = scoreChunk(fnChunk, ['invalidate']);
    expect(r.score).toBeGreaterThan(0);
    // Should explain the match in `reasons`.
    expect(r.reasons.some((reason) => reason.includes('invalidate'))).toBe(true);
  });

  it('returns 0 for empty queries', () => {
    expect(scoreChunk(fnChunk, []).score).toBe(0);
  });
});

describe('retrieval — retrieve', () => {
  const chunks = [
    {
      file: 'lib/cache.ts',
      start_line: 1,
      end_line: 5,
      kind: 'function' as const,
      name: 'invalidateCache',
      content: 'function invalidateCache() { /* clears the cache */ }',
    },
    {
      file: 'lib/auth.ts',
      start_line: 10,
      end_line: 20,
      kind: 'class' as const,
      name: 'AuthGuard',
      content: 'class AuthGuard { /* nothing about cache */ }',
    },
    {
      file: 'lib/util.ts',
      start_line: 30,
      end_line: 40,
      kind: 'const' as const,
      name: 'CACHE_KEY',
      content: 'const CACHE_KEY = "k";',
    },
  ];

  it('returns top-K sorted by score', () => {
    const results = retrieve('cache', chunks, { topK: 3 });
    expect(results.length).toBeGreaterThan(0);
    // Highest-scoring chunk should be the one named "invalidateCache"
    // or "CACHE_KEY" — both have name-level matches; either is correct.
    expect(['invalidateCache', 'CACHE_KEY']).toContain(results[0].chunk.name);
  });

  it('respects minScore', () => {
    const results = retrieve('xenophobe', chunks, { minScore: 0.05 });
    expect(results).toEqual([]);
  });

  it('returns [] for empty query', () => {
    expect(retrieve('', chunks)).toEqual([]);
  });
});

describe('index-query CLI helpers', () => {
  it('findSourceFiles walks recursively + filters by extension + skips known dirs', () => {
    write('lib/a.ts', 'export const a = 1;');
    write('lib/sub/b.ts', 'export const b = 2;');
    write('lib/c.py', 'X = 3');
    write('lib/d.md', '# skip me');
    write('node_modules/skip.ts', 'export const skip = 1;');
    write('.git/skip.ts', 'export const skip = 1;');
    const found = findSourceFiles(['lib'], ['.ts', '.py'], tempDir);
    expect(found.sort()).toEqual(['lib/a.ts', 'lib/c.py', 'lib/sub/b.ts']);
  });

  it('runQuery surfaces matching chunks across files', () => {
    write('lib/cache.ts', 'export function invalidateCache() { return 1; }');
    write('lib/auth.ts', 'export function login() { return 2; }');
    const result = runQuery(
      { query: 'invalidate', roots: ['lib'], extensions: ['.ts'], topK: 5, minScore: 0.05, explain: false },
      tempDir,
    );
    expect(result.files_scanned).toBe(2);
    expect(result.chunks_indexed).toBeGreaterThanOrEqual(2);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].name).toBe('invalidateCache');
  });
});
