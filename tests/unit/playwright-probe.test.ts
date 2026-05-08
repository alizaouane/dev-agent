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

    describe('codex P1 — skipped specs are advisory, not failures', () => {
      it('returns ambiguous when ALL specs are skipped (test.skip() — non-UI spec path)', () => {
        // The exact case codex flagged: the documented "no UI selectors"
        // path tells the agent to write `probe.spec.ts` with a single
        // `test.skip()` call. Playwright reports that as
        // status=skipped, which the previous code mapped to fail —
        // exiting non-zero and blocking promotion for non-UI specs that
        // were supposed to be advisory-only. Lock in the ambiguous verdict.
        writeFileSync(
          reportPath,
          JSON.stringify({
            suites: [
              {
                specs: [
                  { title: 'no-ui-selectors', tests: [{ results: [{ status: 'skipped' }] }] },
                ],
              },
            ],
          }),
          'utf8',
        );
        const v = buildVerdict(baseArgs, reportPath);
        expect(v.verdict).toBe('ambiguous');
        expect(v.results).toHaveLength(1);
        expect(v.results[0].status).toBe('skip');
        expect(v.meta.skipped_count).toBe(1);
        expect(v.meta.failed_count).toBe(0);
        expect(v.summary).toMatch(/all 1 probe spec\(s\) were skipped/);
      });

      it('returns pass for a mix of pass + skip (skips are advisory, not failures)', () => {
        // Partial coverage: agent skipped some criteria as non-UI but
        // wrote real assertions for the rest. As long as no failures,
        // verdict stays pass. Skipped count surfaces in meta + summary
        // so operators see the partial coverage.
        writeFileSync(
          reportPath,
          JSON.stringify({
            suites: [
              {
                specs: [
                  { title: 'login-button', tests: [{ results: [{ status: 'passed' }] }] },
                  { title: 'no-ui-criterion', tests: [{ results: [{ status: 'skipped' }] }] },
                  { title: 'profile-loads', tests: [{ results: [{ status: 'passed' }] }] },
                ],
              },
            ],
          }),
          'utf8',
        );
        const v = buildVerdict(baseArgs, reportPath);
        expect(v.verdict).toBe('pass');
        expect(v.meta.skipped_count).toBe(1);
        expect(v.meta.failed_count).toBe(0);
        expect(v.summary).toMatch(/2 probe assertion\(s\) green/);
        expect(v.summary).toMatch(/1 skipped — advisory/);
      });

      it('still returns fail when any spec failed, even if others were skipped', () => {
        // Mixed fail + skip → fail (a real failure isn't softened by
        // adjacent skips; the gate must catch it). Lock in.
        writeFileSync(
          reportPath,
          JSON.stringify({
            suites: [
              {
                specs: [
                  { title: 'login-button', tests: [{ results: [{ status: 'failed', errors: [{ message: 'broken' }] }] }] },
                  { title: 'no-ui-criterion', tests: [{ results: [{ status: 'skipped' }] }] },
                ],
              },
            ],
          }),
          'utf8',
        );
        const v = buildVerdict(baseArgs, reportPath);
        expect(v.verdict).toBe('fail');
        expect(v.meta.failed_count).toBe(1);
        expect(v.meta.skipped_count).toBe(1);
      });

      it("treats Playwright's 'timedOut' and 'interrupted' as failures (not skips)", () => {
        // Playwright's full status set: passed | failed | timedOut |
        // skipped | interrupted. The fix maps timedOut + interrupted
        // explicitly to fail (was previously caught by the catch-all
        // "anything not passed" branch — same outcome, but lock the
        // explicit handling so a future refactor can't accidentally
        // bucket them with skipped).
        writeFileSync(
          reportPath,
          JSON.stringify({
            suites: [
              {
                specs: [
                  { title: 'slow-test', tests: [{ results: [{ status: 'timedOut', errors: [{ message: 'over budget' }] }] }] },
                  { title: 'cancelled-test', tests: [{ results: [{ status: 'interrupted' }] }] },
                ],
              },
            ],
          }),
          'utf8',
        );
        const v = buildVerdict(baseArgs, reportPath);
        expect(v.verdict).toBe('fail');
        expect(v.results.every((r) => r.status === 'fail')).toBe(true);
        expect(v.meta.failed_count).toBe(2);
        expect(v.meta.skipped_count).toBe(0);
      });

      it('writeAmbiguousVerdict includes skipped_count in meta for shape stability', () => {
        // Reviewer / workflow code reads meta.skipped_count
        // unconditionally; a missing field would crash the workflow's
        // jq extraction. Defensive shape lock.
        const v = writeAmbiguousVerdict(baseArgs, 'no probe');
        expect(v.meta).toHaveProperty('skipped_count', 0);
      });
    });
  });
});
