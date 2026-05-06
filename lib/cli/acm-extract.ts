#!/usr/bin/env tsx
/**
 * acm-extract — read a spec, extract acceptance criteria, lint them.
 *
 * Pure deterministic: no model calls. The phase-acm workflow uses this as
 * the first step before invoking the test-stub generator. If extraction
 * returns no criteria, or if the linter emits any `error`-level finding,
 * the workflow stops with a structured comment and labels the issue
 * `state:blocked` — saving the cost of a Sonnet call on a spec that
 * cannot be testably bound.
 *
 * Required env:
 *   SPEC_PATH       Path to the spec markdown file.
 *
 * Output: JSON to stdout with the extracted criteria + lint findings.
 * Exit code: 0 if criteria > 0 and zero lint errors; 1 otherwise.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  extractAcceptanceCriteria,
  lintCriteria,
  computeSha256,
  type AcceptanceCriterion,
  type LintFinding,
} from '../acm';

export interface ExtractResult {
  spec_path: string;
  spec_sha256: string;
  criteria: AcceptanceCriterion[];
  lint: LintFinding[];
  ok: boolean;
  reason?: 'missing-section' | 'lint-errors';
}

export function runExtract(specPath: string): ExtractResult {
  if (!existsSync(specPath)) {
    throw new Error(`spec not found: ${specPath}`);
  }
  const spec = readFileSync(specPath, 'utf8');
  const criteria = extractAcceptanceCriteria(spec);
  const lint = lintCriteria(criteria);
  const errors = lint.filter((x) => x.level === 'error');
  let reason: ExtractResult['reason'];
  let ok = true;
  if (criteria.length === 0) {
    ok = false;
    reason = 'missing-section';
  } else if (errors.length > 0) {
    ok = false;
    reason = 'lint-errors';
  }
  return {
    spec_path: specPath,
    spec_sha256: computeSha256(spec),
    criteria,
    lint,
    ok,
    reason,
  };
}

async function main(): Promise<void> {
  const specPath = process.env.SPEC_PATH;
  if (!specPath) throw new Error('SPEC_PATH required');
  const r = runExtract(specPath);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.ok ? 0 : 1);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((err) => {
    process.stderr.write(`acm-extract failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
