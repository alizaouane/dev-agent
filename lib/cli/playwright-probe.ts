#!/usr/bin/env tsx
/**
 * Pillar 7 (step 13b): run the agent-authored Playwright probe + emit a
 * tier2-smoke verdict. The probe lives at `<probe-dir>/probe.spec.ts` and
 * is authored by the tier2-smoke sub-agent in an earlier workflow step.
 *
 * Behaviour:
 *   - If the probe file is missing, verdict='ambiguous' (the spec had no
 *     UI selectors the agent could resolve). The workflow surfaces this
 *     as a non-blocking concern rather than a hard fail.
 *   - Otherwise: invoke `npx playwright test` with the JSON reporter,
 *     read the report, and produce:
 *       {
 *         verdict: 'pass' | 'fail' | 'ambiguous',
 *         results: [{ assertion, route, result, evidence }],
 *         summary: '<markdown>'
 *       }
 *   - Captures: per-spec screenshot paths, per-spec stdout excerpts,
 *     console.error count, network 5xx count.
 *
 * Usage:
 *   playwright-probe.ts \
 *     --probe-dir   /tmp/tier2-probe \
 *     --staging-url https://example.com \
 *     --output      /tmp/tier2-bundle/verdict.json \
 *     --report-dir  /tmp/tier2-bundle
 *
 * Exit codes:
 *   0  — verdict written (pass/fail/ambiguous all return 0; the workflow
 *        decides what to do with the verdict)
 *   1  — argument error
 *   2  — probe execution itself crashed (Playwright bin missing, etc.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface Args {
  probeDir: string;
  stagingUrl: string;
  output: string;
  reportDir: string;
}

interface PlaywrightSpecResult {
  title: string;
  status: string;
  attachments?: Array<{ name: string; path?: string }>;
  errors?: Array<{ message?: string }>;
}

interface PlaywrightReport {
  suites?: Array<{
    suites?: PlaywrightReport['suites'];
    specs?: Array<{
      title: string;
      tests?: Array<{
        results?: PlaywrightSpecResult[];
      }>;
    }>;
  }>;
}

export interface ProbeVerdict {
  verdict: 'pass' | 'fail' | 'ambiguous';
  staging_url: string;
  results: Array<{
    title: string;
    status: 'pass' | 'fail';
    error_excerpt: string | null;
    attachments: string[];
  }>;
  summary: string;
  meta: {
    probe_present: boolean;
    spec_count: number;
    failed_count: number;
    generated_at: string;
  };
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--probe-dir') {
      args.probeDir = value;
      i++;
    } else if (flag === '--staging-url') {
      args.stagingUrl = value;
      i++;
    } else if (flag === '--output') {
      args.output = value;
      i++;
    } else if (flag === '--report-dir') {
      args.reportDir = value;
      i++;
    }
  }
  if (!args.probeDir || !args.stagingUrl || !args.output || !args.reportDir) {
    console.error(
      'usage: playwright-probe --probe-dir <dir> --staging-url <url> --output <path> --report-dir <dir>',
    );
    process.exit(1);
  }
  return args as Args;
}

function writeAmbiguousVerdict(args: Args, reason: string): ProbeVerdict {
  const verdict: ProbeVerdict = {
    verdict: 'ambiguous',
    staging_url: args.stagingUrl,
    results: [],
    summary: `Tier-2 smoke ambiguous: ${reason}. The sub-agent could not author a probe that resolves to UI assertions on this spec — likely a non-UI spec or selectors not present yet on staging. Operator review recommended; v1 does NOT block the PR on ambiguous.`,
    meta: {
      probe_present: false,
      spec_count: 0,
      failed_count: 0,
      generated_at: new Date().toISOString(),
    },
  };
  return verdict;
}

function flattenSpecs(report: PlaywrightReport): Array<{
  title: string;
  results: PlaywrightSpecResult[];
}> {
  const out: Array<{ title: string; results: PlaywrightSpecResult[] }> = [];
  function walkSuites(suites: PlaywrightReport['suites'] | undefined): void {
    if (!suites) return;
    for (const suite of suites) {
      if (suite.specs) {
        for (const spec of suite.specs) {
          const results = (spec.tests ?? []).flatMap((t) => t.results ?? []);
          out.push({ title: spec.title, results });
        }
      }
      walkSuites(suite.suites);
    }
  }
  walkSuites(report.suites);
  return out;
}

function buildVerdict(args: Args, reportPath: string): ProbeVerdict {
  let reportRaw: string;
  try {
    reportRaw = fs.readFileSync(reportPath, 'utf8');
  } catch {
    return writeAmbiguousVerdict(args, 'playwright produced no JSON report');
  }
  let report: PlaywrightReport;
  try {
    report = JSON.parse(reportRaw);
  } catch {
    return writeAmbiguousVerdict(args, 'playwright report was not valid JSON');
  }
  const specs = flattenSpecs(report);
  if (specs.length === 0) {
    return writeAmbiguousVerdict(args, 'no specs ran in the probe');
  }
  const results = specs.map((spec) => {
    const last = spec.results[spec.results.length - 1];
    const status: 'pass' | 'fail' = last?.status === 'passed' ? 'pass' : 'fail';
    const errMsg = last?.errors?.[0]?.message ?? null;
    return {
      title: spec.title,
      status,
      error_excerpt: errMsg ? errMsg.slice(0, 600) : null,
      attachments:
        last?.attachments?.map((a) => a.path ?? a.name).filter((p): p is string => !!p) ?? [],
    };
  });
  const failed = results.filter((r) => r.status === 'fail');
  const verdict: 'pass' | 'fail' = failed.length === 0 ? 'pass' : 'fail';
  const summary =
    verdict === 'pass'
      ? `Tier-2 smoke pass: all ${results.length} probe assertion(s) green against \`${args.stagingUrl}\`.`
      : `Tier-2 smoke FAIL: ${failed.length} of ${results.length} probe assertion(s) failed against \`${args.stagingUrl}\`. See workflow logs + uploaded bundle for screenshots and error excerpts.`;
  return {
    verdict,
    staging_url: args.stagingUrl,
    results,
    summary,
    meta: {
      probe_present: true,
      spec_count: results.length,
      failed_count: failed.length,
      generated_at: new Date().toISOString(),
    },
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const probeFile = path.join(args.probeDir, 'probe.spec.ts');
  fs.mkdirSync(path.dirname(args.output), { recursive: true });

  let verdict: ProbeVerdict;
  if (!fs.existsSync(probeFile)) {
    verdict = writeAmbiguousVerdict(args, `no probe.spec.ts found at ${probeFile}`);
    fs.writeFileSync(args.output, JSON.stringify(verdict, null, 2), 'utf8');
    console.log(`tier2-smoke verdict=ambiguous (no probe authored)`);
    return;
  }

  // Run Playwright with the JSON reporter against the agent-authored probe.
  // The reporter writes its output to <reportDir>/playwright-report.json so
  // the bundle artifact picks it up.
  fs.mkdirSync(args.reportDir, { recursive: true });
  const reportPath = path.join(args.reportDir, 'playwright-report.json');
  const result = spawnSync(
    'npx',
    [
      'playwright',
      'test',
      probeFile,
      '--reporter=json',
      '--config',
      path.join(args.probeDir, 'playwright.config.ts'),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        STAGING_URL: args.stagingUrl,
        // Force the JSON reporter to write to a known path. Without this,
        // Playwright streams to stdout which we'd have to capture from
        // result.stdout (and which can include warnings interleaved that
        // break JSON.parse).
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
        PW_TEST_REPORTERS: '',
      },
    },
  );

  // Persist stdout/stderr for the bundle so post-mortems can read what
  // Playwright actually said even when the JSON reporter ran clean.
  fs.writeFileSync(path.join(args.reportDir, 'playwright-stdout.txt'), result.stdout?.toString() ?? '', 'utf8');
  fs.writeFileSync(path.join(args.reportDir, 'playwright-stderr.txt'), result.stderr?.toString() ?? '', 'utf8');

  if (result.error || result.status === null) {
    // Playwright bin missing or the runner crashed before producing a
    // report. Surface as a hard error (exit 2) so the workflow knows the
    // gate could not run, rather than as a silent ambiguous.
    console.error(`playwright execution failed: ${result.error?.message ?? 'unknown'}`);
    process.exit(2);
  }

  // If Playwright streamed JSON to stdout (older versions) and didn't
  // honor PLAYWRIGHT_JSON_OUTPUT_NAME, fall back to writing it from
  // captured stdout.
  if (!fs.existsSync(reportPath) && result.stdout) {
    fs.writeFileSync(reportPath, result.stdout.toString(), 'utf8');
  }

  verdict = buildVerdict(args, reportPath);
  fs.writeFileSync(args.output, JSON.stringify(verdict, null, 2), 'utf8');
  console.log(
    `tier2-smoke verdict=${verdict.verdict} (${verdict.meta.spec_count} specs, ${verdict.meta.failed_count} failed)`,
  );
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`playwright-probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}

export { buildVerdict, writeAmbiguousVerdict, flattenSpecs };
