#!/usr/bin/env tsx
/**
 * swarm-aggregate — read N reviewer JSON files, run aggregateVerdicts,
 * print structured output.
 *
 * The phase-swarm-review workflow runs the three reviewers (or stub
 * generators in v1) writing their structured JSON to a known directory,
 * then invokes this CLI to combine them into:
 *   - the aggregated verdict (swarm-pass | swarm-concern | swarm-fail)
 *   - the per-reviewer evaluation breakdown
 *   - the markdown comment body to post on the PR
 *
 * Args:
 *   --inputs-dir <dir>    Directory containing one *.json per reviewer.
 *                         Each file must shape-match ReviewerOutput.
 *   --output-json <path>  Where to write the aggregated verdict JSON.
 *   --output-md <path>    Where to write the markdown comment body.
 *
 * Exit code:
 *   0  swarm-pass or swarm-concern (advisory in v1)
 *   1  swarm-fail or invalid input
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateVerdicts, type ReviewerOutput } from '../swarm-review';

interface Args {
  inputsDir: string;
  outputJson: string;
  outputMd: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--inputs-dir') args.inputsDir = argv[++i];
    else if (a === '--output-json') args.outputJson = argv[++i];
    else if (a === '--output-md') args.outputMd = argv[++i];
  }
  for (const k of ['inputsDir', 'outputJson', 'outputMd'] as const) {
    if (!args[k]) throw new Error(`missing required arg: --${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`);
  }
  return args as Args;
}

export function loadReviewerOutputs(inputsDir: string): ReviewerOutput[] {
  if (!existsSync(inputsDir)) {
    throw new Error(`inputs directory not found: ${inputsDir}`);
  }
  const files = readdirSync(inputsDir).filter((f) => f.endsWith('.json')).sort();
  const out: ReviewerOutput[] = [];
  for (const f of files) {
    const path = join(inputsDir, f);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReviewerOutput;
      if (typeof parsed.reviewer !== 'string' || typeof parsed.verdict !== 'string') {
        throw new Error('missing reviewer or verdict field');
      }
      if (!Array.isArray(parsed.findings)) {
        throw new Error('findings must be an array');
      }
      out.push(parsed);
    } catch (e) {
      throw new Error(`failed to parse ${path}: ${(e as Error).message}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outputs = loadReviewerOutputs(args.inputsDir);
  const aggregated = aggregateVerdicts(outputs);

  mkdirSync(dirname(args.outputJson), { recursive: true });
  mkdirSync(dirname(args.outputMd), { recursive: true });
  writeFileSync(args.outputJson, JSON.stringify(aggregated, null, 2) + '\n', 'utf8');
  writeFileSync(args.outputMd, aggregated.comment_body + '\n', 'utf8');

  process.stdout.write(`swarm-aggregate: verdict=${aggregated.verdict} (${outputs.length} reviewers)\n`);
  process.exit(aggregated.verdict === 'swarm-fail' ? 1 : 0);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((err) => {
    process.stderr.write(`swarm-aggregate failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
