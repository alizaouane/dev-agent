/**
 * Apply discipline (Pillar 4): no whole-file rewrites. The agent emits
 * search/replace blocks anchored on SHA-pinned file hashes; this module
 * applies them deterministically with AST validation, and fails closed on:
 *
 *   - hash-mismatch     — file changed since the agent observed it (race)
 *   - search-not-found  — search text isn't in the file (stale or wrong)
 *   - search-not-unique — search text appears more than once (ambiguous)
 *   - syntax-error      — result fails to parse (TS/JS for v1)
 *
 * v1 validates TypeScript / TSX / JavaScript / JSX via the typescript
 * package's parser (already a devDep — no new bundle weight). Other
 * languages (.py, .rb, .go) skip the AST check until step 3's codebase
 * index pulls in multi-language tree-sitter; the deterministic checks
 * (hash + uniqueness) still apply.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

export interface SearchReplaceBlock {
  /** Path relative to the repo root. */
  file: string;
  /** SHA-256 of the file's UTF-8 bytes the agent saw at edit time. */
  sha: string;
  /** Verbatim text to find. Must be unique in the file. */
  search: string;
  /** Replacement text. */
  replace: string;
}

export type ApplyFailureReason =
  | 'hash-mismatch'
  | 'search-not-found'
  | 'search-not-unique'
  | 'syntax-error';

export type ApplyResult =
  | { ok: true; file: string; new_sha: string }
  | { ok: false; file: string; reason: ApplyFailureReason; details: string };

const TYPESCRIPT_EXT = new Set(['.ts', '.tsx', '.cts', '.mts']);
const JAVASCRIPT_EXT = new Set(['.js', '.jsx', '.cjs', '.mjs']);
export const VALIDATABLE_EXT = new Set([...TYPESCRIPT_EXT, ...JAVASCRIPT_EXT]);
const JSX_EXT = new Set(['.tsx', '.jsx']);

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface ApplyOptions {
  /** Repo root. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Override AST check toggling — defaults to enabled. */
  validateSyntax?: boolean;
}

export function applySearchReplace(block: SearchReplaceBlock, opts: ApplyOptions = {}): ApplyResult {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const fullPath = path.resolve(repoRoot, block.file);

  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch (e) {
    return {
      ok: false,
      file: block.file,
      reason: 'hash-mismatch',
      details: `cannot read file: ${(e as Error).message}`,
    };
  }

  const observed = sha256(content);
  if (observed !== block.sha) {
    return {
      ok: false,
      file: block.file,
      reason: 'hash-mismatch',
      details: `file SHA-256 changed since edit was authored (expected ${block.sha.slice(0, 12)}…, got ${observed.slice(0, 12)}…) — re-Read the file and retry`,
    };
  }

  const firstIdx = content.indexOf(block.search);
  if (firstIdx === -1) {
    return {
      ok: false,
      file: block.file,
      reason: 'search-not-found',
      details: `search text (${block.search.length} chars) not found in file — re-Read and retry`,
    };
  }
  const lastIdx = content.lastIndexOf(block.search);
  if (lastIdx !== firstIdx) {
    return {
      ok: false,
      file: block.file,
      reason: 'search-not-unique',
      details: `search text occurs at offsets ${firstIdx} and ${lastIdx} — enlarge the search window with surrounding context`,
    };
  }

  const newContent =
    content.slice(0, firstIdx) + block.replace + content.slice(firstIdx + block.search.length);

  const validate = opts.validateSyntax ?? true;
  if (validate) {
    const ext = path.extname(block.file).toLowerCase();
    if (VALIDATABLE_EXT.has(ext)) {
      const v = validateTsSyntax(newContent, ext);
      if (!v.ok) {
        return {
          ok: false,
          file: block.file,
          reason: 'syntax-error',
          details: v.error,
        };
      }
    }
  }

  fs.writeFileSync(fullPath, newContent, 'utf8');
  return { ok: true, file: block.file, new_sha: sha256(newContent) };
}

export interface SyntaxValidation {
  ok: boolean;
  error: string;
}

/**
 * Run the TypeScript parser over the post-edit content; report only syntactic
 * errors. Semantic errors (type mismatches, missing imports) are out of scope
 * for the apply gate — the consumer's typecheck step catches those.
 *
 * For .jsx / .tsx files we use ScriptKind.TSX (the parser handles JSX in both
 * — it's the angle-bracket-type-assertion ambiguity that requires the
 * distinction).
 *
 * Exported for use by `lib/cli/apply-audit.ts` (Pillar 4 advisory): the
 * post-run audit reuses this validator to syntax-check every file in the
 * agent's commit, catching whole-file rewrites that compile but emit broken
 * TypeScript before they reach the typecheck step.
 */
export function validateTsSyntax(content: string, ext: string): SyntaxValidation {
  const scriptKind = JSX_EXT.has(ext)
    ? ts.ScriptKind.TSX
    : JAVASCRIPT_EXT.has(ext)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    `__validate__${ext}`,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind,
  );

  // The parser exposes syntactic errors via `parseDiagnostics` — internal
  // but stable across TS 4–5. Public APIs (getPreEmitDiagnostics) need a
  // Program, which is overkill for one-file syntactic validation.
  const parseDiagnostics =
    (sourceFile as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ??
    [];
  if (parseDiagnostics.length === 0) return { ok: true, error: '' };

  const first = parseDiagnostics[0];
  const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
  const pos = first.start ?? 0;
  const line = ts.getLineAndCharacterOfPosition(sourceFile, pos).line + 1;
  return { ok: false, error: `syntax error at line ${line}: ${message}` };
}

/** Hash a string (utility export — same hash function the apply uses internally). */
export function sha256OfContent(content: string): string {
  return sha256(content);
}
