import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildVerdict, writeAmbiguousVerdict, flattenSpecs } from '../../lib/cli/playwright-probe';

/**
 * Pillar 7 (step 13b). The probe lib produces verdicts that the workflow
 * comments on the issue verbatim. Field names + verdict semantics are
 * locked here — refactor must preserve them.
 *
 * We test the report-parsing path, not the Playwright runner itself
 * (that would require playwright as a devDep + a real browser, which
 * costs CI minutes for no reliability win).
 */
describe('lib/cli/playwright-probe', () => {
  const baseArgs = {
    probeDir: '/tmp/probe',
    stagingUrl: 'https://staging.example.com',
    output: '/tmp/verdict.json',
    reportDir: '/tmp/report',
  };

  describe('flattenSpecs', () => {
    it('walks nested suites + extracts every spec result', () => {
      const report = {
        suites: [
          {
            specs: [
              { title: 'top-spec', tests: [{ results: [{ title: 'top-spec', status: 'passed' }] }] },
            ],
            suites: [
              {
                specs: [
                  { title: 'nested-1', tests: [{ results: [{ title: 'nested-1', status: 'failed' }] }] },
                  { title: 'nested-2', tests: [{ results: [{ title: 'nested-2', status: 'passed' }] }] },
                ],
              },
            ],
          },
        ],
      };
      const flat = flattenSpecs(report);
      expect(flat).toHaveLength(3);
      expect(flat.map((s) => s.title)).toEqual(['top-spec', 'nested-1', 'nested-2']);
    });

    it('returns empty when no suites present', () => {
      expect(flattenSpecs({})).toEqual([]);
      expect(flattenSpecs({ suites: [] })).toEqual([]);
    });
  });

  describe('writeAmbiguousVerdict', () => {
    it('returns probe_present=false + zero spec count', () => {
      const v = writeAmbiguousVerdict(baseArgs, 'no probe.spec.ts');
      expect(v.verdict).toBe('ambiguous');
      expect(v.meta.probe_present).toBe(false);
      expect(v.meta.spec_count).toBe(0);
      expect(v.meta.failed_count).toBe(0);
      expect(v.staging_url).toBe('https://staging.example.com');
      expect(v.summary).toMatch(/ambiguous/);
      expect(v.summary).toMatch(/non-UI spec or selectors not present yet/);
    });

    it("explicitly notes v1's non-blocking behavior so PR authors aren't confused", () => {
      // The summary text shows on the PR comment; if it sounds like a hard
      // fail an operator might think they need to revert. The "does NOT
      // block" language is intentional.
      const v = writeAmbiguousVerdict(baseArgs, 'reason');
      expect(v.summary).toMatch(/does NOT block the PR/);
    });
  });

  describe('buildVerdict', () => {
    let dir: string;
    let reportPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'pw-probe-'));
      reportPath = join(dir, 'playwright-report.json');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns ambiguous when the report file is missing', () => {
      const v = buildVerdict(baseArgs, reportPath);
      expect(v.verdict).toBe('ambiguous');
      expect(v.summary).toMatch(/no JSON report/);
    });

    it('returns ambiguous when the report is malformed JSON', () => {
      writeFileSync(reportPath, '{ this is not json', 'utf8');
      const v = buildVerdict(baseArgs, reportPath);
      expect(v.verdict).toBe('ambiguous');
      expect(v.summary).toMatch(/not valid JSON/);
    });

    it('returns ambiguous when the report has no specs', () => {
      writeFileSync(reportPath, JSON.stringify({ suites: [] }), 'utf8');
      const v = buildVerdict(baseArgs, reportPath);
      expect(v.verdict).toBe('ambiguous');
      expect(v.summary).toMatch(/no specs ran/);
    });

    it('returns pass when every spec passed', () => {
      writeFileSync(
        reportPath,
        JSON.stringify({
          suites: [
            {
              specs: [
                { title: 'login button works', tests: [{ results: [{ status: 'passed' }] }] },
                { title: 'profile loads', tests: [{ results: [{ status: 'passed' }] }] },
              ],
            },
          ],
        }),
        'utf8',
      );
      const v = buildVerdict(baseArgs, reportPath);
      expect(v.verdict).toBe('pass');
      expect(v.results).toHaveLength(2);
      expect(v.results.every((r) => r.status === 'pass')).toBe(true);
      expect(v.meta.failed_count).toBe(0);
      expect(v.summary).toMatch(/all 2 probe assertion/);
    });

    it('returns fail when any spec failed + records error excerpt', () => {
      writeFileSync(
        reportPath,
        JSON.stringify({
          suites: [
            {
              specs: [
                { title: 'login works', tests: [{ results: [{ status: 'passed' }] }] },
                {
                  title: 'profile loads',
                  tests: [
                    {
                      results: [
                        {
                          status: 'failed',
                          errors: [{ message: 'TimeoutError: page.goto exceeded 30s' }],
                          attachments: [{ name: 'screenshot', path: '/tmp/report/screenshot.png' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        'utf8',
      );
      const v = buildVerdict(baseArgs, reportPath);
      expect(v.verdict).toBe('fail');
      expect(v.meta.failed_count).toBe(1);
      const failed = v.results.find((r) => r.status === 'fail');
      expect(failed).toBeDefined();
      expect(failed?.error_excerpt).toMatch(/TimeoutError/);
      expect(failed?.attachments).toContain('/tmp/report/screenshot.png');
      expect(v.summary).toMatch(/Tier-2 smoke FAIL/);
      expect(v.summary).toMatch(/1 of 2/);
    });

    it("uses the LAST result of a spec's retries (Playwright records each retry)", () => {
      // Playwright records each retry as a separate `result` in the array.
      // The probe should treat the LAST entry as authoritative — that's
      // what Playwright itself does for the spec's overall status.
      writeFileSync(
        reportPath,
        JSON.stringify({
          suites: [
            {
              specs: [
                {
                  title: 'flaky-test',
                  tests: [
                    {
                      results: [
                        { status: 'failed', errors: [{ message: 'first try' }] },
                        { status: 'passed' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        'utf8',
      );
      const v = buildVerdict(baseArgs, reportPath);
      expect(v.verdict).toBe('pass');
      expect(v.meta.failed_count).toBe(0);
    });

    it('truncates long error messages so the comment stays readable', () => {
      // Playwright errors can include 5-10KB of stack trace + DOM dump.
      // The verdict.summary embeds the error excerpts via the workflow's
      // gh issue comment; oversize messages produce a wall-of-text PR
      // comment that drowns the actual signal.
      const longErr = 'X'.repeat(5000);
      writeFileSync(
        reportPath,
        JSON.stringify({
          suites: [
            {
              specs: [
                {
                  title: 'big-error',
                  tests: [{ results: [{ status: 'failed', errors: [{ message: longErr }] }] }],
                },
              ],
            },
          ],
        }),
        'utf8',
      );
      const v = buildVerdict(baseArgs, reportPath);
      expect(v.results[0].error_excerpt?.length).toBeLessThanOrEqual(600);
    });
  });
});
