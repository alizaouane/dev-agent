#!/usr/bin/env tsx
/**
 * acm-verify — verify an ACM manifest against the working tree.
 *
 * Two modes (set via env MODE):
 *
 *   MODE=acm-red    Run after phase-acm finishes test generation. Every
 *                   test file referenced by the manifest must FAIL when run
 *                   individually — proves each stub asserts a behavior the
 *                   current `main` does NOT yet have.
 *
 *   MODE=acm-green  Run at the end of phase-implement, before opening the
 *                   PR. Every test must PASS, every test file's SHA-256
 *                   must match the manifest (anti-cheating SHA lock), and
 *                   the spec's SHA-256 must match (drift check).
 *
 * Optional gates (default ON for acm-green; disable via env=false):
 *   CHECK_LOCKS           SHA-256 of each test file must match manifest
 *   CHECK_SPEC_HASH       SHA-256 of spec must match manifest
 *   CHECK_MUTATION_KILLS  Per-test mutation kill ≥ 1 — DEFERRED to v1.1
 *                         when Stryker / mutmut wiring lands. v1 emits
 *                         { mutation_kills: "skipped" } in the JSON output.
 *
 * Required env:
 *   MANIFEST_PATH         Path to .dev-agent/acm-manifest.json
 *   TEST_CMD              Consumer's test command, space-tokenized:
 *                         "npm test --" → ['npm', 'test', '--']
 *                         "pytest" → ['pytest']
 *                         The test file path is appended as a final arg.
 *                         No shell interpolation; consumers needing pipes
 *                         or expansion should wrap in a script and point
 *                         TEST_CMD at it.
 *
 * Output: structured JSON to stdout describing every check's outcome.
 * Exit code: 0 on pass, 1 on any failure.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSha256, type ACMManifest } from '../acm';

type Verdict = 'pass' | 'fail' | 'skipped';

interface TestResult {
  criterion_id: string;
  test_file: string;
  result: Verdict;
  details?: string;
}

interface VerifyResult {
  mode: 'acm-red' | 'acm-green';
  verdict: Verdict;
  tests: TestResult[];
  locks: { verdict: Verdict; mismatched: string[] };
  spec_hash: { verdict: Verdict; expected: string; observed: string };
  mutation_kills: { verdict: Verdict; details: string };
}

export function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  return v.toLowerCase() !== 'false' && v !== '0' && v !== '';
}

function readManifest(path: string): ACMManifest {
  if (!existsSync(path)) {
    throw new Error(`manifest not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as ACMManifest;
}

/**
 * Tokenize a TEST_CMD string into program + args.
 *
 * Whitespace-separated, no shell interpolation. This deliberately rejects
 * pipes / redirects / backticks — consumers who need those should wrap in
 * a script and point TEST_CMD at the script path. The simpler tokenizer
 * eliminates the command-injection vector that arises if you naively
 * `${cmd} ${userControlledPath}`.
 */
export function tokenizeCmd(cmd: string): { program: string; args: string[] } {
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error('TEST_CMD is empty');
  for (const t of tokens) {
    // Reject the obvious shell-meta characters at parse time so subtle
    // misuse fails loudly rather than silently mis-tokenizing.
    if (/[|;&`$()<>]/.test(t)) {
      throw new Error(`TEST_CMD contains shell metacharacter "${t}" — wrap your command in a script and point TEST_CMD at the script`);
    }
  }
  return { program: tokens[0], args: tokens.slice(1) };
}

/** Run the consumer's test command scoped to a single test file. Returns true if the test passes. */
function runTest(cmd: string, testFile: string): { passed: boolean; output: string } {
  const { program, args } = tokenizeCmd(cmd);
  try {
    const stdout = execFileSync(program, [...args, testFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { passed: true, output: stdout };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    const out = (err.stdout ?? '').toString() + (err.stderr ?? '').toString();
    return { passed: false, output: out };
  }
}

export function checkLocks(manifest: ACMManifest, repoRoot: string): { verdict: Verdict; mismatched: string[] } {
  const mismatched: string[] = [];
  for (const c of manifest.criteria) {
    if (!c.test_file || !c.test_sha256) {
      mismatched.push(`${c.id}: manifest entry missing test_file or test_sha256`);
      continue;
    }
    const fullPath = resolve(repoRoot, c.test_file);
    if (!existsSync(fullPath)) {
      mismatched.push(`${c.id}: test file ${c.test_file} not found on disk`);
      continue;
    }
    const observed = computeSha256(readFileSync(fullPath, 'utf8'));
    if (observed !== c.test_sha256) {
      mismatched.push(`${c.id}: ${c.test_file} SHA changed (expected ${c.test_sha256.slice(0, 12)}…, got ${observed.slice(0, 12)}…)`);
    }
  }
  return { verdict: mismatched.length === 0 ? 'pass' : 'fail', mismatched };
}

export function checkSpecHash(manifest: ACMManifest, repoRoot: string): { verdict: Verdict; expected: string; observed: string } {
  const fullPath = resolve(repoRoot, manifest.spec_path);
  if (!existsSync(fullPath)) {
    return { verdict: 'fail', expected: manifest.spec_sha256, observed: '<spec-not-found>' };
  }
  const observed = computeSha256(readFileSync(fullPath, 'utf8'));
  return {
    verdict: observed === manifest.spec_sha256 ? 'pass' : 'fail',
    expected: manifest.spec_sha256,
    observed,
  };
}

async function main(): Promise<void> {
  const mode = (process.env.MODE ?? '').toLowerCase();
  if (mode !== 'acm-red' && mode !== 'acm-green') {
    throw new Error('MODE must be acm-red or acm-green');
  }
  const manifestPath = process.env.MANIFEST_PATH ?? '.dev-agent/acm-manifest.json';
  const testCmd = process.env.TEST_CMD;
  if (!testCmd) throw new Error('TEST_CMD required');
  const repoRoot = process.env.REPO_ROOT ?? process.cwd();
  const checkLocksEnabled = envBool('CHECK_LOCKS', mode === 'acm-green');
  const checkSpecHashEnabled = envBool('CHECK_SPEC_HASH', mode === 'acm-green');
  const checkMutationKillsEnabled = envBool('CHECK_MUTATION_KILLS', false); // v1.1

  const manifest = readManifest(resolve(repoRoot, manifestPath));

  const tests: TestResult[] = [];
  for (const c of manifest.criteria) {
    if (!c.test_file) {
      tests.push({ criterion_id: c.id, test_file: '<missing>', result: 'fail', details: 'manifest entry has no test_file' });
      continue;
    }
    const { passed, output } = runTest(testCmd, c.test_file);
    const expected = mode === 'acm-red' ? false : true;
    tests.push({
      criterion_id: c.id,
      test_file: c.test_file,
      result: passed === expected ? 'pass' : 'fail',
      details:
        passed === expected
          ? undefined
          : `expected ${expected ? 'green' : 'red'}, got ${passed ? 'green' : 'red'}\n${output.slice(-2000)}`,
    });
  }

  const locks = checkLocksEnabled
    ? checkLocks(manifest, repoRoot)
    : { verdict: 'skipped' as Verdict, mismatched: [] };

  const spec_hash = checkSpecHashEnabled
    ? checkSpecHash(manifest, repoRoot)
    : { verdict: 'skipped' as Verdict, expected: manifest.spec_sha256, observed: '<skipped>' };

  const mutation_kills = checkMutationKillsEnabled
    ? { verdict: 'skipped' as Verdict, details: 'Stryker / mutmut wiring deferred to v1.1' }
    : { verdict: 'skipped' as Verdict, details: 'CHECK_MUTATION_KILLS=false (v1 default)' };

  const anyFail = tests.some((t) => t.result === 'fail') || locks.verdict === 'fail' || spec_hash.verdict === 'fail';
  const result: VerifyResult = {
    mode: mode as 'acm-red' | 'acm-green',
    verdict: anyFail ? 'fail' : 'pass',
    tests,
    locks,
    spec_hash,
    mutation_kills,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

// Run main() only when this file is the entry point (i.e. invoked via tsx).
// Importing it from a test or another module must not auto-run main(), which
// would crash on missing env vars at import time.
const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((err) => {
    process.stderr.write(`acm-verify failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
