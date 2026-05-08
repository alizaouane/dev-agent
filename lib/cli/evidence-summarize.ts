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
 *   0  — summary written
 *   1  — argument error
 *   2  — bundle directory does not exist (writes an "absent" stub summary
 *        and exits 0 — phase-swarm-review treats absent evidence as a
 *        warning, not a hard failure, since the gate still functions on
 *        the PR diff alone)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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

function emptySummary(reason: string): EvidenceSummary {
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const bundleAbs = path.resolve(args.bundleDir);
  const outAbs = path.resolve(args.output);

  let summary: EvidenceSummary;
  if (!fs.existsSync(bundleAbs) || !fs.statSync(bundleAbs).isDirectory()) {
    // Soft-fail path: emit an absent-summary stub so the reviewer prompt
    // still has a deterministic shape to render. Workflow-level decisions
    // about whether to proceed without evidence stay in the workflow.
    summary = emptySummary(`bundle dir missing at ${bundleAbs}`);
  } else {
    summary = summarizeBundle(bundleAbs);
  }

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(summary, null, 2), 'utf8');
  console.log(
    `evidence-summary: scanners=gitleaks(${summary.scanners.gitleaks.count}), semgrep(${summary.scanners.semgrep.high_count}/${summary.scanners.semgrep.total_count} HIGH), npm-audit(${summary.scanners.npm_audit.high_count}/${summary.scanners.npm_audit.total_count} HIGH)`,
  );
}

main();
