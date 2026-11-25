/**
 * collectIssuesWithComments is where BOTH the budget gate and the nightly
 * watchdog read month-to-date spend from (lib/cli/budget-gate.ts,
 * lib/cli/cost-watchdog.ts). These tests run it against a fake Octokit and
 * feed its output through the real aggregator, so they check the total the
 * gate compares with the cap.
 *
 * Breakers (each turns a test here red, recorded 2026-11-23):
 *   - restore `items.filter((i) => !i.pull_request)` -> "counts telemetry the
 *     PR fixer posts on a pull request" fails (total 3, not 5; the other two
 *     tests, which also read PR spend, fail with it).
 *   - drop the `seen` de-duplication -> "counts an item listed twice once"
 *     fails (total 10, not 5).
 *   - drop the TELEMETRY_AUTHOR filter -> "ignores telemetry-shaped comments
 *     by anyone else" fails (total 105, not 5).
 */
import { describe, it, expect } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { collectIssuesWithComments, TELEMETRY_AUTHOR } from '../../lib/telemetry-source';
import { aggregateCostFromComments } from '../../lib/cost-watchdog';

const tg = (phase: string, cost: number) =>
  `🤖 Phase: ${phase}\nModel: claude-sonnet-4-6\nTokens: 100 in / 50 out\nCost: $${cost.toFixed(2)}\nStatus: completed`;

type Item = { number: number; title: string; pull_request?: { url: string } };
type Comment = { body: string; created_at: string; user: { login: string } | null };

/**
 * A fake Octokit whose `paginate` answers the two calls the function makes.
 *
 * @param items - What `issues.listForRepo` returns (issues and PRs mixed).
 * @param comments - Comments per issue/PR number.
 * @returns An object typed as Octokit for the function under test.
 */
function fakeOctokit(items: Item[], comments: Record<number, Comment[]>): Octokit {
  const listForRepo = () => undefined;
  const listComments = () => undefined;
  return {
    issues: { listForRepo, listComments },
    paginate: async (fn: unknown, params: { issue_number?: number }) => {
      if (fn === listForRepo) return items;
      if (fn === listComments) return comments[params.issue_number ?? -1] ?? [];
      throw new Error('unexpected paginate call');
    },
  } as unknown as Octokit;
}

const monthStart = new Date('2026-11-01T00:00:00Z');
const at = '2026-11-10T10:00:00Z';
const bot = { login: TELEMETRY_AUTHOR };

/**
 * Month-to-date total the budget gate would see for this fake repository.
 *
 * @param octokit - The fake client.
 * @returns The aggregated spend in dollars.
 */
async function total(octokit: Octokit): Promise<number> {
  const rows = await collectIssuesWithComments(octokit, 'o', 'r', monthStart);
  return aggregateCostFromComments(rows, monthStart).total;
}

describe('collectIssuesWithComments', () => {
  const issue: Item = { number: 1, title: 'feature' };
  const pr: Item = { number: 2, title: 'feat: implement issue #1', pull_request: { url: 'x' } };
  const comments: Record<number, Comment[]> = {
    1: [{ body: tg('phase-implement', 3), created_at: at, user: bot }],
    2: [{ body: tg('phase-implement', 2), created_at: at, user: bot }],
  };

  it('counts telemetry the PR fixer posts on a pull request', async () => {
    expect(await total(fakeOctokit([issue, pr], comments))).toBeCloseTo(5, 2);
  });

  it('counts an item listed twice once', async () => {
    expect(await total(fakeOctokit([issue, pr, issue, pr], comments))).toBeCloseTo(5, 2);
  });

  it('ignores telemetry-shaped comments by anyone else', async () => {
    const forged: Record<number, Comment[]> = {
      1: comments[1],
      2: [...comments[2], { body: tg('phase-implement', 100), created_at: at, user: { login: 'someone' } }],
    };
    expect(await total(fakeOctokit([issue, pr], forged))).toBeCloseTo(5, 2);
  });
});
