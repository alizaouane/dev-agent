#!/usr/bin/env tsx
/**
 * CLI wrapper around lib/evidence-summary.ts. Reads an extracted
 * verification-bundle directory + writes a JSON summary that
 * phase-swarm-review.yml feeds into each reviewer's prompt.
 *
 * Usage:
 *   evidence-summarize.ts --bundle-dir /tmp/evidence-bundle --output /tmp/evidence-summary.json
 *
 * Exit codes:
 *   0  — summary written. Includes the soft-fail paths: missing bundle
 *        dir AND empty/unpopulated bundle dir both write an "absent"
 *        stub summary (the CLI never hard-fails on bundle issues since
 *        the gate still functions on the PR diff alone — phase-swarm-
 *        review treats absent evidence as a workflow warning, not a
 *        gate failure).
 *   1  — argument error (missing --bundle-dir / --output flags).
 *   2  — unexpected runtime error (exception during summarize / file I/O).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeBundle, EvidenceSummary } from '../evidence-summary';

interface Args {
  bundleDir: string;
  output: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--bundle-dir') {
      args.bundleDir = value;
      i++;
    } else if (flag === '--output') {
      args.output = value;
      i++;
    }
  }
  if (!args.bundleDir || !args.output) {
    console.error('usage: evidence-summarize --bundle-dir <path> --output <path>');
    process.exit(1);
  }
  return args as Args;
}

export function emptySummary(reason: string): EvidenceSummary {
  return {
    meta: { pr_number: null, head_sha: null, generated_at: null },
    scanners: {
      gitleaks: { count: 0, findings: [] },
      semgrep: { high_count: 0, total_count: 0, findings: [] },
      npm_audit: { high_count: 0, total_count: 0, findings: [] },
    },
    ast_diff_excerpt: `(no evidence available — ${reason})`,
  };
}

/**
 * The four files the evidence-collector workflow writes into a bundle. If
 * NONE of these are present in the bundle directory, the dir is effectively
 * empty and we cannot distinguish "scanner ran clean" from "bundle never
 * populated". codex P2 (PR #79 review): in that case, emit the absent stub
 * so reviewers see the missing-evidence marker rather than zero counts that
 * look identical to a clean run.
 */
const BUNDLE_FILES = ['gitleaks.json', 'semgrep.json', 'npm-audit.json', 'ast-diff.txt'];

export function isBundlePopulated(bundleDir: string): boolean {
  return BUNDLE_FILES.some((f) => fs.existsSync(path.join(bundleDir, f)));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const bundleAbs = path.resolve(args.bundleDir);
  const outAbs = path.resolve(args.output);

  let summary: EvidenceSummary;
  if (!fs.existsSync(bundleAbs) || !fs.statSync(bundleAbs).isDirectory()) {
    // Soft-fail path #1: dir doesn't exist (download-artifact failed; the
    // workflow leaves the dir nonexistent on purpose so this branch fires).
    summary = emptySummary(`bundle dir missing at ${bundleAbs}`);
  } else if (!isBundlePopulated(bundleAbs)) {
    // Soft-fail path #2: dir exists but has none of the recognized scanner
    // output files. Defense in depth — even if a future workflow change
    // creates the dir unconditionally again, reviewers still see the
    // explicit missing-evidence marker rather than a misleading zero-counts
    // summary.
    summary = emptySummary(`bundle dir empty (no scanner outputs present at ${bundleAbs})`);
  } else {
    summary = summarizeBundle(bundleAbs);
  }

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(summary, null, 2), 'utf8');
  console.log(
    `evidence-summary: scanners=gitleaks(${summary.scanners.gitleaks.count}), semgrep(${summary.scanners.semgrep.high_count}/${summary.scanners.semgrep.total_count} HIGH), npm-audit(${summary.scanners.npm_audit.high_count}/${summary.scanners.npm_audit.total_count} HIGH)`,
  );
}

// Only run main() when executed as a CLI — importing the module (e.g.
// from tests that exercise isBundlePopulated / emptySummary) must not
// trigger argv parsing + process.exit(1).
const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`evidence-summarize failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
