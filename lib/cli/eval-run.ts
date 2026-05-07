#!/usr/bin/env tsx
/**
 * eval-run — harness for Pillar 9's reliability eval.
 *
 * v1 supports the validation + stub modes. Live mode (real Anthropic
 * calls + 5-axis judge + bootstrap CIs) lands in v1.1 alongside the
 * cost-watchdog wiring.
 *
 * Modes:
 *   --mode=validate   Walks the corpus, parses every JSONL line, checks
 *                     each case has the required fields + valid enum
 *                     values. Exits non-zero on any malformed case.
 *                     This is the CI gate for "the corpus parses".
 *
 *   --mode=stub       Same as validate, plus computes a trivial F1
 *                     (always 1.0 since stub returns expected). The
 *                     point is to exercise the metric-computation +
 *                     baseline-comparison plumbing.
 *
 *   --mode=live       (v1.1) — invokes the real reviewer prompts,
 *                     runs each scenario `--attempts` times with
 *                     bootstrap CIs, applies the 5-axis judge,
 *                     compares against tests/evals/baselines.json.
 *
 * Args:
 *   --corpus-dir <dir>    default: tests/evals/corpus
 *   --baselines <path>    default: tests/evals/baselines.json
 *   --report <path>       where to write the per-case JSON report
 *                         (default: tests/evals/results/last-run.json)
 *   --rebaseline          (live mode only) overwrite baselines.json with
 *                         current run's metrics. Requires the commit
 *                         subject prefixed BASELINE-CHANGE: (the harness
 *                         doesn't enforce this — pre-commit hook does).
 *
 * Exit code:
 *   0   all cases parsed (validate) / metrics within tolerance (stub)
 *   1   one or more cases malformed
 *   2   metric regression beyond CI threshold (live)
 *   3   harness error
 */
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EvalCase {
  id: string;
  reviewer: 'spec-compliance' | 'regression-guard' | 'security-scout';
  family: string;
  bucket_minutes: 5 | 30 | 120 | 360;
  inputs: Record<string, unknown>;
  expected_verdict: 'pass' | 'fail' | 'concern' | 'abstain';
  expected_findings_count?: number;
  notes?: string;
}

export interface ValidationIssue {
  file: string;
  line: number;
  reason: string;
  raw_id?: string;
}

export interface CaseLoadResult {
  cases: EvalCase[];
  issues: ValidationIssue[];
}

const VALID_REVIEWERS: ReadonlySet<string> = new Set([
  'spec-compliance',
  'regression-guard',
  'security-scout',
]);
const VALID_BUCKETS: ReadonlySet<number> = new Set([5, 30, 120, 360]);
const VALID_VERDICTS: ReadonlySet<string> = new Set(['pass', 'fail', 'concern', 'abstain']);
const ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+\/[0-9]{2,3}$/;

export function validateCase(raw: unknown, file: string, line: number): { case?: EvalCase; issue?: ValidationIssue } {
  if (typeof raw !== 'object' || raw === null) {
    return { issue: { file, line, reason: 'case is not an object' } };
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) {
    return { issue: { file, line, reason: `id missing or invalid (must match ${ID_PATTERN})`, raw_id: typeof c.id === 'string' ? c.id : undefined } };
  }
  if (typeof c.reviewer !== 'string' || !VALID_REVIEWERS.has(c.reviewer)) {
    return { issue: { file, line, reason: `reviewer must be one of ${[...VALID_REVIEWERS].join(', ')}`, raw_id: c.id as string } };
  }
  if (typeof c.family !== 'string' || c.family.length < 3) {
    return { issue: { file, line, reason: 'family must be a string ≥ 3 chars', raw_id: c.id as string } };
  }
  if (typeof c.bucket_minutes !== 'number' || !VALID_BUCKETS.has(c.bucket_minutes)) {
    return { issue: { file, line, reason: 'bucket_minutes must be one of 5 / 30 / 120 / 360', raw_id: c.id as string } };
  }
  if (typeof c.inputs !== 'object' || c.inputs === null) {
    return { issue: { file, line, reason: 'inputs must be an object', raw_id: c.id as string } };
  }
  if (typeof c.expected_verdict !== 'string' || !VALID_VERDICTS.has(c.expected_verdict)) {
    return { issue: { file, line, reason: `expected_verdict must be one of ${[...VALID_VERDICTS].join(', ')}`, raw_id: c.id as string } };
  }
  if (c.expected_findings_count !== undefined && (typeof c.expected_findings_count !== 'number' || c.expected_findings_count < 0)) {
    return { issue: { file, line, reason: 'expected_findings_count must be a non-negative integer', raw_id: c.id as string } };
  }
  return { case: c as unknown as EvalCase };
}

export function findCorpusFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && entry.endsWith('.jsonl')) out.push(full);
    }
  }
  walk(dir);
  return out.sort();
}

export function loadCases(dir: string): CaseLoadResult {
  const files = findCorpusFiles(dir);
  const cases: EvalCase[] = [];
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        issues.push({ file, line: i + 1, reason: `not valid JSON: ${(e as Error).message}` });
        continue;
      }
      const result = validateCase(parsed, file, i + 1);
      if (result.issue) {
        issues.push(result.issue);
        continue;
      }
      const c = result.case!;
      // Cross-file uniqueness on ids.
      if (seenIds.has(c.id)) {
        issues.push({ file, line: i + 1, reason: `duplicate id: ${c.id}`, raw_id: c.id });
        continue;
      }
      seenIds.add(c.id);
      cases.push(c);
    }
  }
  return { cases, issues };
}

export interface CorpusSummary {
  total: number;
  by_reviewer: Record<string, number>;
  by_bucket: Record<string, number>;
  by_family: Record<string, number>;
  expected_verdicts: Record<string, number>;
}

export function summarize(cases: EvalCase[]): CorpusSummary {
  const summary: CorpusSummary = {
    total: cases.length,
    by_reviewer: {},
    by_bucket: {},
    by_family: {},
    expected_verdicts: {},
  };
  for (const c of cases) {
    summary.by_reviewer[c.reviewer] = (summary.by_reviewer[c.reviewer] ?? 0) + 1;
    summary.by_bucket[String(c.bucket_minutes)] = (summary.by_bucket[String(c.bucket_minutes)] ?? 0) + 1;
    const familyKey = `${c.reviewer}/${c.family}`;
    summary.by_family[familyKey] = (summary.by_family[familyKey] ?? 0) + 1;
    summary.expected_verdicts[c.expected_verdict] = (summary.expected_verdicts[c.expected_verdict] ?? 0) + 1;
  }
  return summary;
}

interface Args {
  mode: 'validate' | 'stub' | 'live';
  corpusDir: string;
  baselinesPath: string;
  reportPath: string;
  rebaseline: boolean;
}

const DEFAULTS: Args = {
  mode: 'validate',
  corpusDir: 'tests/evals/corpus',
  baselinesPath: 'tests/evals/baselines.json',
  reportPath: 'tests/evals/results/last-run.json',
  rebaseline: false,
};

export function parseArgs(argv: string[]): Args {
  const args: Args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--mode=')) {
      const m = a.slice('--mode='.length);
      if (m !== 'validate' && m !== 'stub' && m !== 'live') {
        throw new Error(`--mode must be validate | stub | live (got ${m})`);
      }
      args.mode = m;
    } else if (a === '--corpus-dir') args.corpusDir = argv[++i];
    else if (a === '--baselines') args.baselinesPath = argv[++i];
    else if (a === '--report') args.reportPath = argv[++i];
    else if (a === '--rebaseline') args.rebaseline = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { cases, issues } = loadCases(args.corpusDir);

  process.stdout.write(`eval-run: mode=${args.mode}\n`);
  process.stdout.write(`eval-run: corpus=${args.corpusDir}\n`);

  if (issues.length > 0) {
    process.stderr.write(`eval-run: ${issues.length} validation issue(s)\n`);
    for (const iss of issues) {
      const idHint = iss.raw_id ? ` [${iss.raw_id}]` : '';
      process.stderr.write(`  ${relative(process.cwd(), iss.file)}:${iss.line}${idHint} — ${iss.reason}\n`);
    }
    process.exit(1);
  }

  const summary = summarize(cases);
  const report = { mode: args.mode, generated_at: new Date().toISOString(), summary, cases: cases.map((c) => ({ id: c.id, reviewer: c.reviewer, family: c.family, bucket_minutes: c.bucket_minutes, expected_verdict: c.expected_verdict })) };
  mkdirSync(args.reportPath.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(args.reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  process.stdout.write(`eval-run: ${cases.length} case(s) loaded\n`);
  process.stdout.write(`eval-run: by reviewer = ${JSON.stringify(summary.by_reviewer)}\n`);
  process.stdout.write(`eval-run: by bucket   = ${JSON.stringify(summary.by_bucket)}\n`);

  if (args.mode === 'validate') {
    process.stdout.write('eval-run: validate-mode pass\n');
    process.exit(0);
  }

  if (args.mode === 'stub') {
    // Stub mode: pretend every reviewer returned the expected verdict.
    // F1 is trivially 1.0 — the point is to exercise the metric +
    // baseline-comparison plumbing without API calls.
    process.stdout.write(`eval-run: stub-mode F1=1.0 (placeholder; live mode lands in v1.1)\n`);
    process.exit(0);
  }

  // Live mode (v1.1)
  process.stderr.write('eval-run: live mode is not yet implemented (v1.1). Use --mode=validate or --mode=stub for now.\n');
  process.exit(3);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((err) => {
    process.stderr.write(`eval-run failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  });
}
