#!/usr/bin/env tsx
/**
 * Pillar 4 advisory audit: post-hoc TS/JS syntax validation of every file
 * the implement-agent touched. The full Pillar 4 vision (force search/
 * replace blocks anchored to SHA-pinned line ranges) requires a fork of
 * claude-code-action's edit surface; this advisory v1.5 lite catches the
 * specific failure mode Pillar 4 was guarding against — whole-file
 * rewrites that pass the agent's "I edited this" check but emit broken
 * syntax — without changing the agent's tool surface.
 *
 * Behavior:
 *   1. Compute the list of TS/JS files changed in the working tree
 *      relative to a base ref (default: origin/main). Falls back to
 *      `git diff --name-only HEAD~1 HEAD` if the base ref isn't
 *      reachable (post-rebase / shallow-clone runners).
 *   2. For each changed file: read content, run lib/apply.ts's
 *      validateTsSyntax (which uses the TypeScript parser).
 *   3. Emit a structured report:
 *        {
 *          verdict: 'clean' | 'syntax-errors' | 'no-files',
 *          files_checked,
 *          errors: [{ file, error }]
 *        }
 *      plus a markdown report for issue commenting.
 *
 * Advisory: a syntax error in a changed file does NOT exit non-zero. The
 * workflow surfaces it as a PR comment + `apply-audit:syntax-errors`
 * label so operators see it. The consumer's tsc step (which the agent
 * already runs) is the enforcing gate. This audit's value is in
 * surfacing earlier when the agent's edit produced broken TypeScript
 * even before tsc runs against the rest of the codebase.
 *
 * Usage:
 *   apply-audit.ts --base-ref origin/main --output /tmp/apply-audit/report
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateTsSyntax, VALIDATABLE_EXT } from '../apply';

interface Args {
  baseRef: string;
  output: string;
  repoRoot: string;
}

export interface AuditError {
  file: string;
  error: string;
}

export interface AuditReport {
  verdict: 'clean' | 'syntax-errors' | 'no-files';
  files_checked: number;
  base_ref: string;
  errors: AuditError[];
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { baseRef: 'origin/main', repoRoot: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--base-ref') {
      args.baseRef = value;
      i++;
    } else if (flag === '--output') {
      args.output = value;
      i++;
    } else if (flag === '--repo-root') {
      args.repoRoot = value;
      i++;
    }
  }
  if (!args.output) {
    console.error('usage: apply-audit --base-ref <ref> --output <path-prefix> [--repo-root <dir>]');
    process.exit(1);
  }
  return args as Args;
}

function listChangedFiles(repoRoot: string, baseRef: string): { files: string[]; resolved_ref: string } {
  // Try the requested base ref first. If it fails (shallow clone, post-
  // rebase), fall back to HEAD~1 — the latest commit's diff.
  const tryRef = (ref: string) =>
    spawnSync('git', ['diff', '--name-only', `${ref}...HEAD`], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

  const primary = tryRef(baseRef);
  if (primary.status === 0) {
    return {
      files: primary.stdout.split('\n').filter((l) => l.trim().length > 0),
      resolved_ref: baseRef,
    };
  }

  const fallback = tryRef('HEAD~1');
  if (fallback.status === 0) {
    return {
      files: fallback.stdout.split('\n').filter((l) => l.trim().length > 0),
      resolved_ref: 'HEAD~1',
    };
  }

  // No git diff possible (single-commit branch on a fresh shallow clone).
  // Treat as no-files. The audit isn't useful here anyway.
  return { files: [], resolved_ref: 'unavailable' };
}

export function runAudit(args: Args): AuditReport {
  const { files, resolved_ref } = listChangedFiles(args.repoRoot, args.baseRef);
  // Filter to TS/JS files that still exist on disk. The diff includes
  // deletions (a `.ts` file removed in this branch), and we have nothing
  // to validate for those — the diff metadata is enough.
  const validatable = files.filter((f) => {
    if (!VALIDATABLE_EXT.has(path.extname(f).toLowerCase())) return false;
    return fs.existsSync(path.resolve(args.repoRoot, f));
  });

  if (validatable.length === 0) {
    return {
      verdict: 'no-files',
      files_checked: 0,
      base_ref: resolved_ref,
      errors: [],
    };
  }

  const errors: AuditError[] = [];
  for (const file of validatable) {
    const fullPath = path.resolve(args.repoRoot, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const result = validateTsSyntax(content, path.extname(file).toLowerCase());
    if (!result.ok) {
      errors.push({ file, error: result.error.slice(0, 400) });
    }
  }

  return {
    verdict: errors.length > 0 ? 'syntax-errors' : 'clean',
    files_checked: validatable.length,
    base_ref: resolved_ref,
    errors,
  };
}

export function renderMarkdown(report: AuditReport): string {
  if (report.verdict === 'no-files') {
    return [
      '🤖 Phase: apply-audit',
      'Verdict: no-files',
      '',
      `No TypeScript / JavaScript files changed in the diff vs \`${report.base_ref}\`.`,
      '_The audit had nothing to check; this is informational, not a failure._',
    ].join('\n');
  }
  if (report.verdict === 'clean') {
    return [
      '🤖 Phase: apply-audit',
      'Verdict: clean',
      `Files checked: ${report.files_checked} (TS / JS in diff vs \`${report.base_ref}\`)`,
      '',
      '_All TypeScript / JavaScript files parsed cleanly with the TypeScript parser._',
    ].join('\n');
  }

  const rows = report.errors
    .slice(0, 20)
    .map((e) => `- \`${e.file}\` — ${e.error}`)
    .join('\n');
  const extra =
    report.errors.length > 20
      ? `\n\n_…and ${report.errors.length - 20} more errors (see audit JSON in workflow logs)_`
      : '';

  return [
    '🤖 Phase: apply-audit',
    `Verdict: syntax-errors (${report.errors.length} of ${report.files_checked} files)`,
    `Base ref: \`${report.base_ref}\``,
    '',
    'Files with TypeScript parser errors:',
    '',
    rows + extra,
    '',
    '_Advisory in v1: this report does not block the PR. The consumer\'s `tsc` step is the enforcing gate. v1.1 will fail-closed once typical FP rates have been audited._',
  ].join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const report = runAudit(args);
  const outBase = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(`${outBase}.json`, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(`${outBase}.md`, renderMarkdown(report), 'utf8');
  console.log(
    `apply-audit: verdict=${report.verdict} files_checked=${report.files_checked} errors=${report.errors.length} (base=${report.base_ref})`,
  );
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`apply-audit failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
