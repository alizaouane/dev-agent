#!/usr/bin/env tsx
/**
 * index-query — chunk the repo and run a keyword retrieval query.
 *
 * v1 has no persistent index — every invocation chunks the configured
 * source roots fresh. The full sqlite-vec + embedding pipeline lands
 * in v1.1; until then this CLI is the agent's "find me code about X"
 * primitive (Pillar 3, text-only).
 *
 * Usage:
 *   QUERY="cache invalidation logic" npx tsx lib/cli/index-query.ts
 *   QUERY="getUser" ROOTS=lib,dashboard/lib npx tsx lib/cli/index-query.ts
 *   QUERY="test runner" TOP_K=5 EXPLAIN=true npx tsx lib/cli/index-query.ts
 *
 * Required env:
 *   QUERY        Free-form query text.
 *
 * Optional env:
 *   ROOTS        Comma-separated source roots (default: lib,dashboard/lib)
 *   EXTENSIONS   Comma-separated file extensions to consider
 *                (default: .ts,.tsx,.js,.jsx,.py)
 *   TOP_K        Max results (default: 10)
 *   MIN_SCORE    Minimum score to include (default: 0.05)
 *   EXPLAIN      When 'true', include per-result reason strings
 *
 * Output: JSON to stdout listing { file, start_line, end_line, name, score, reasons }.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkFile, type Chunk } from '../index/chunker';
import { retrieve, type ScoredChunk } from '../index/retrieval';

interface Args {
  query: string;
  roots: string[];
  extensions: string[];
  topK: number;
  minScore: number;
  explain: boolean;
}

const DEFAULT_ROOTS = ['lib', 'dashboard/lib'];
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py'];

export function readArgs(env: NodeJS.ProcessEnv): Args {
  const query = env.QUERY;
  if (!query || query.trim().length === 0) {
    throw new Error('QUERY required (non-empty)');
  }
  const roots = env.ROOTS ? env.ROOTS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ROOTS;
  const extensions = env.EXTENSIONS
    ? env.EXTENSIONS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_EXTENSIONS;
  const topK = env.TOP_K ? parseInt(env.TOP_K, 10) : 10;
  const minScore = env.MIN_SCORE ? parseFloat(env.MIN_SCORE) : 0.05;
  const explain = env.EXPLAIN === 'true' || env.EXPLAIN === '1';
  if (Number.isNaN(topK) || topK < 1) throw new Error('TOP_K must be a positive integer');
  if (Number.isNaN(minScore) || minScore < 0) throw new Error('MIN_SCORE must be a non-negative number');
  return { query, roots, extensions, topK, minScore, explain };
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.dev-agent-engine',
]);

export function findSourceFiles(roots: string[], extensions: string[], cwd = process.cwd()): string[] {
  const out: string[] = [];
  function walk(rel: string): void {
    const full = join(cwd, rel);
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const childRel = rel ? `${rel}/${entry}` : entry;
      let st;
      try {
        st = statSync(join(cwd, childRel));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(childRel);
      else if (st.isFile()) {
        const dot = entry.lastIndexOf('.');
        if (dot < 0) continue;
        const ext = entry.slice(dot).toLowerCase();
        if (extensions.includes(ext)) out.push(childRel);
      }
    }
  }
  for (const root of roots) walk(root);
  return out.sort();
}

export function chunkRepo(args: Args, cwd = process.cwd()): Chunk[] {
  const files = findSourceFiles(args.roots, args.extensions, cwd);
  const allChunks: Chunk[] = [];
  for (const file of files) {
    const content = readFileSync(join(cwd, file), 'utf8');
    allChunks.push(...chunkFile(file, content));
  }
  return allChunks;
}

export interface QueryResult {
  query: string;
  files_scanned: number;
  chunks_indexed: number;
  results: Array<{
    file: string;
    start_line: number;
    end_line: number;
    kind: Chunk['kind'];
    name: string;
    score: number;
    reasons?: string[];
    preview: string;
  }>;
}

export function runQuery(args: Args, cwd = process.cwd()): QueryResult {
  const chunks = chunkRepo(args, cwd);
  const filesScanned = new Set(chunks.map((c) => c.file)).size;
  const scored = retrieve(args.query, chunks, { topK: args.topK, minScore: args.minScore });
  return {
    query: args.query,
    files_scanned: filesScanned,
    chunks_indexed: chunks.length,
    results: scored.map((s: ScoredChunk) => ({
      file: s.chunk.file,
      start_line: s.chunk.start_line,
      end_line: s.chunk.end_line,
      kind: s.chunk.kind,
      name: s.chunk.name,
      score: Math.round(s.score * 1000) / 1000,
      reasons: args.explain ? s.reasons : undefined,
      preview: s.chunk.content.split('\n').slice(0, 4).join('\n'),
    })),
  };
}

async function main(): Promise<void> {
  const args = readArgs(process.env);
  const result = runQuery(args);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((err) => {
    process.stderr.write(`index-query failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
