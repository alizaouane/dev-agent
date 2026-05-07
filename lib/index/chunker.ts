/**
 * Pillar 3 — codebase chunker, v1 (text-only).
 *
 * Extracts structural chunks (functions, classes, top-level exports)
 * from source files via regex. The full tree-sitter + AST-aware version
 * lands in v1.1 alongside the embedding + sqlite-vec dependency batch
 * — until then, regex is good enough for ~80% of TS/JS/Python files
 * and is zero-dep / cross-platform / fast.
 *
 * Returns a flat list of `Chunk` records that downstream retrieval can
 * search lexically. Each chunk records its file, line range, kind, name,
 * and content. Chunks are non-overlapping; lines outside any matched
 * structure (imports, top-level statements that aren't `const x = ...`)
 * are emitted as a single `module-prelude` chunk per file so retrieval
 * doesn't lose them.
 */

export interface Chunk {
  /** Path relative to repo root. */
  file: string;
  /** 1-based start line, inclusive. */
  start_line: number;
  /** 1-based end line, inclusive. */
  end_line: number;
  /** Coarse semantic kind. */
  kind: 'function' | 'class' | 'const' | 'type' | 'module-prelude';
  /** Symbol name when extractable; '' for module-prelude. */
  name: string;
  /** Raw content of this chunk (for retrieval + rerank). */
  content: string;
}

interface LanguageRules {
  extensions: string[];
  patterns: Array<{ regex: RegExp; kind: Chunk['kind'] }>;
}

const TS_JS_RULES: LanguageRules = {
  extensions: ['.ts', '.tsx', '.cts', '.mts', '.js', '.jsx', '.cjs', '.mjs'],
  patterns: [
    { regex: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/, kind: 'function' },
    { regex: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, kind: 'class' },
    { regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]/, kind: 'const' },
    { regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, kind: 'type' },
    { regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, kind: 'type' },
  ],
};

const PYTHON_RULES: LanguageRules = {
  extensions: ['.py'],
  patterns: [
    { regex: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: 'function' },
    { regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/, kind: 'class' },
    { regex: /^([A-Z_][A-Z0-9_]*)\s*=/, kind: 'const' },
  ],
};

const ALL_RULES: LanguageRules[] = [TS_JS_RULES, PYTHON_RULES];

function rulesForFile(file: string): LanguageRules | null {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = file.slice(dot).toLowerCase();
  for (const r of ALL_RULES) {
    if (r.extensions.includes(ext)) return r;
  }
  return null;
}

/**
 * Find the line where a balanced-brace block ends for TS/JS, or where
 * indentation returns to ≤ the start indent for Python. Returns the
 * 1-based end line (inclusive).
 */
function findBlockEnd(lines: string[], startIdx: number, isPython: boolean): number {
  if (isPython) return findPythonBlockEnd(lines, startIdx);
  return findBraceBlockEnd(lines, startIdx);
}

function findBraceBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    let j = 0;
    while (j < line.length) {
      const ch = line[j];
      if (ch === '/' && line[j + 1] === '/') break;
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        j++;
        while (j < line.length && line[j] !== quote) {
          if (line[j] === '\\') j += 2;
          else j++;
        }
        j++;
        continue;
      }
      if (ch === '{') {
        depth++;
        started = true;
      } else if (ch === '}') {
        depth--;
        if (started && depth === 0) return i + 1;
      }
      j++;
    }
    if (!started && /[;]\s*$/.test(line)) return i + 1;
  }
  return lines.length;
}

function findPythonBlockEnd(lines: string[], startIdx: number): number {
  const startLine = lines[startIdx];
  const startIndent = startLine.match(/^[ \t]*/)![0].length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.match(/^[ \t]*/)![0].length;
    if (indent <= startIndent) return i;
  }
  return lines.length;
}

export interface ChunkOptions {
  minBytes?: number;
}

/**
 * Chunk a single source file's text. Returns chunks sorted by start_line.
 *
 * Files in unsupported languages return a single `module-prelude` chunk
 * containing the whole file — retrieval can still match it lexically,
 * just without symbol-level granularity.
 */
export function chunkFile(file: string, content: string, opts: ChunkOptions = {}): Chunk[] {
  const minBytes = opts.minBytes ?? 8;
  const lines = content.split('\n');
  const rules = rulesForFile(file);

  if (!rules) {
    if (content.trim().length < minBytes) return [];
    return [
      {
        file,
        start_line: 1,
        end_line: lines.length,
        kind: 'module-prelude',
        name: '',
        content,
      },
    ];
  }

  const isPython = rules === PYTHON_RULES;
  const matches: Array<{ start: number; name: string; kind: Chunk['kind'] }> = [];
  for (let i = 0; i < lines.length; i++) {
    for (const p of rules.patterns) {
      const m = p.regex.exec(lines[i]);
      if (m) {
        matches.push({ start: i, name: m[1], kind: p.kind });
        break;
      }
    }
  }
  matches.sort((a, b) => a.start - b.start);

  // Build chunks left-to-right. When a match falls inside the previous
  // chunk's brace-balanced range, treat it as a nested declaration and
  // skip it — chunks must be non-overlapping. This means inner methods
  // / consts inside a top-level function or class body don't get their
  // own chunk in v1 (the parent's content already includes them).
  // v1.1's tree-sitter pass will surface methods as proper sub-chunks.
  const chunks: Chunk[] = [];
  let lastEnd = 0; // 1-based, exclusive — line just past the last emitted chunk
  for (const m of matches) {
    if (m.start + 1 <= lastEnd) continue; // inside a previously-emitted chunk
    let end = findBlockEnd(lines, m.start, isPython);
    if (end <= m.start) end = m.start + 1;
    const sliced = lines.slice(m.start, end).join('\n');
    if (sliced.length >= minBytes) {
      chunks.push({
        file,
        start_line: m.start + 1,
        end_line: end,
        kind: m.kind,
        name: m.name,
        content: sliced,
      });
      lastEnd = end;
    }
  }

  if (matches.length > 0) {
    const preludeEnd = matches[0].start;
    if (preludeEnd > 0) {
      const preludeContent = lines.slice(0, preludeEnd).join('\n');
      if (preludeContent.trim().length >= minBytes) {
        chunks.unshift({
          file,
          start_line: 1,
          end_line: preludeEnd,
          kind: 'module-prelude',
          name: '',
          content: preludeContent,
        });
      }
    }
  } else {
    if (content.trim().length >= minBytes) {
      chunks.push({
        file,
        start_line: 1,
        end_line: lines.length,
        kind: 'module-prelude',
        name: '',
        content,
      });
    }
  }

  return chunks.sort((a, b) => a.start_line - b.start_line);
}
