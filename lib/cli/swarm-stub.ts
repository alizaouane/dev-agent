#!/usr/bin/env tsx
/**
 * swarm-stub — emit 3 fake reviewer JSONs for stub-mode of phase-swarm-review.
 *
 * Deterministic. Used by phase-swarm-review.yml when invocation_mode='stub'
 * to verify the state-machine wiring + comment posting + label flipping
 * without spending tokens on the live reviewer agents. Live mode (real
 * claude-code-action invocations using prompts/swarm-*.md) lands in
 * step 12b.
 *
 * The three stubbed reviewers all emit verdict=pass with empty findings
 * so the aggregator returns swarm-pass — exactly what you want for a
 * smoke test of the wiring. Negative-path stub (--mode=fail) emits
 * one reviewer with verdict=fail + a HIGH finding so you can verify
 * the failure-comment + label-flip path works end-to-end.
 *
 * Args:
 *   --output-dir <dir>      Where to write spec-compliance.json,
 *                           regression-guard.json, security-scout.json.
 *   --mode <pass|fail>      Default: pass. fail emits one fail.
 *   --pr-number <num>       Echoed into stub findings for traceability.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewerOutput } from '../swarm-review';

interface Args {
  outputDir: string;
  mode: 'pass' | 'fail';
  prNumber: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { mode: 'pass' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output-dir') args.outputDir = argv[++i];
    else if (a === '--mode') {
      const m = argv[++i];
      if (m !== 'pass' && m !== 'fail') throw new Error('--mode must be pass or fail');
      args.mode = m;
    } else if (a === '--pr-number') args.prNumber = argv[++i];
  }
  if (!args.outputDir) throw new Error('missing required arg: --output-dir');
  if (!args.prNumber) throw new Error('missing required arg: --pr-number');
  return args as Args;
}

export function buildStubOutputs(mode: 'pass' | 'fail', prNumber: string): Record<string, ReviewerOutput> {
  const all: Record<string, ReviewerOutput> = {
    'spec-compliance': {
      reviewer: 'spec-compliance',
      verdict: 'pass',
      findings: [],
      summary: `Stub-mode pass — every ACM test reported green and the diff covers each criterion's surface (PR #${prNumber}).`,
    },
    'regression-guard': {
      reviewer: 'regression-guard',
      verdict: 'pass',
      findings: [],
      summary: `Stub-mode pass — no new test failures, no skip introductions, coverage non-decreasing on touched files (PR #${prNumber}).`,
    },
    'security-scout': {
      reviewer: 'security-scout',
      verdict: 'pass',
      findings: [],
      summary: `Stub-mode pass — gitleaks/Semgrep/npm-audit all green; no scout-LLM patterns flagged (PR #${prNumber}).`,
    },
  };
  if (mode === 'fail') {
    // Inject a single grounded HIGH finding on spec-compliance so the
    // aggregator surfaces a real swarm-fail through the test pathway.
    all['spec-compliance'] = {
      reviewer: 'spec-compliance',
      verdict: 'fail',
      findings: [
        {
          rule: 'criterion-skipped',
          severity: 'high',
          file: 'tests/acm/stub.test.ts',
          line: 1,
          message: 'AC-99 referenced in spec but no manifest entry',
          proof_command: "rg -n 'AC-99' .dev-agent/acm-manifest.json",
          confidence: 0.95,
        },
      ],
      summary: `Stub-mode fail — synthesized to exercise the failure-comment + label-flip path (PR #${prNumber}).`,
    };
    // And one for security-scout so the weighted sum (1.0 + 1.5) ≥ 2.0
    // → swarm-fail (matches the live-path's "≥ 2-of-3 weighted fail" rule).
    all['security-scout'] = {
      reviewer: 'security-scout',
      verdict: 'fail',
      findings: [
        {
          rule: 'gitleaks-secret',
          severity: 'high',
          file: 'config/example.env',
          line: 1,
          message: 'AWS access key in plaintext',
          proof_command: "rg -n 'AWS_ACCESS_KEY' config/example.env",
          scanner: 'gitleaks',
          confidence: 1.0,
        },
      ],
      summary: `Stub-mode fail — synthesized secret finding to round out the negative-path verification (PR #${prNumber}).`,
    };
  }
  return all;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outputs = buildStubOutputs(args.mode, args.prNumber);
  mkdirSync(args.outputDir, { recursive: true });
  for (const [name, out] of Object.entries(outputs)) {
    writeFileSync(join(args.outputDir, `${name}.json`), JSON.stringify(out, null, 2) + '\n', 'utf8');
  }
  process.stdout.write(`swarm-stub: wrote ${Object.keys(outputs).length} reviewer stubs to ${args.outputDir} (mode=${args.mode})\n`);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((err) => {
    process.stderr.write(`swarm-stub failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
