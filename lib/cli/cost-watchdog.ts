#!/usr/bin/env tsx
/**
 * Nightly per-repo monthly-budget watchdog (Pillar 10, build step 15).
 *
 * Reads `.dev-agent.yml`'s `cost_caps.monthly_budget_usd` /
 * `cost_caps.alert_threshold_pct`, paginates the repo's issues + telemetry
 * comments for the current month, aggregates spend via the pure helpers in
 * `lib/cost-watchdog.ts`, and upserts a single alert issue per tier-month
 * when spend crosses the warning threshold (default 80%) or exceeds the
 * monthly budget. v1 is alert-only — no mechanical hard-stop.
 *
 * Invoked nightly by `.github/workflows/orch-sweep.yml` (09:00 UTC cron) and
 * runnable locally via `npm run cost-watchdog`.
 *
 * Env:
 *   - GH_TOKEN / GITHUB_TOKEN  (required)
 *   - GITHUB_REPOSITORY        (required, "owner/repo")
 *   - GITHUB_RUN_ID            (optional; falls back to local-<ts>)
 *   - CONFIG_PATH              (optional; defaults to `.dev-agent.yml`)
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Octokit } from '@octokit/rest';
import { parseConfig } from '../parse-config';
import { emit } from '../events';
import {
  aggregateCostFromComments,
  tierFor,
  renderAlertBody,
  dedupeLabels,
  type Tier,
} from '../cost-watchdog';

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function monthLabel(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function findExistingAlertIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  labels: string[],
): Promise<{ number: number } | null> {
  const search = await octokit.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    labels: labels.join(','),
    per_page: 1,
  });
  return search.data[0] ? { number: search.data[0].number } : null;
}

async function upsertAlertIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  args: {
    tier: Exclude<Tier, 'snapshot'>;
    body: string;
    monthLabel: string;
    pctTotal: { pct: number; total: number; budget: number };
  },
): Promise<{ number: number; created: boolean }> {
  const labels = dedupeLabels(args.tier, args.monthLabel);
  const existing = await findExistingAlertIssue(octokit, owner, repo, labels);
  const title =
    args.tier === 'exhausted'
      ? `🚨 dev-agent monthly budget exhausted: $${args.pctTotal.total.toFixed(2)} / $${args.pctTotal.budget.toFixed(2)}`
      : `⚠️ dev-agent monthly budget warning: ${args.pctTotal.pct.toFixed(1)}% of $${args.pctTotal.budget.toFixed(2)}`;

  if (existing) {
    await octokit.issues.update({
      owner,
      repo,
      issue_number: existing.number,
      title,
      body: args.body,
    });
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: existing.number,
      body: `Re-evaluated ${new Date().toISOString()} — MTD now $${args.pctTotal.total.toFixed(2)} (${args.pctTotal.pct.toFixed(1)}%).`,
    });
    return { number: existing.number, created: false };
  }

  const created = await octokit.issues.create({
    owner,
    repo,
    title,
    body: args.body,
    labels,
  });
  return { number: created.data.number, created: true };
}

async function collectIssuesWithComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  monthStart: Date,
) {
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: 'all',
    since: monthStart.toISOString(),
    per_page: 100,
  });
  const realIssues = issues.filter((i) => !i.pull_request);
  return Promise.all(
    realIssues.map(async (issue) => {
      const comments = await octokit.paginate(octokit.issues.listComments, {
        owner,
        repo,
        issue_number: issue.number,
        per_page: 100,
      });
      return {
        number: issue.number,
        title: issue.title,
        comments: comments.map((c) => ({
          body: c.body ?? '',
          created_at: c.created_at,
        })),
      };
    }),
  );
}

async function main(): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? '.dev-agent.yml';
  const defaultsPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'schema',
    'defaults.yml',
  );
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;

  let config;
  try {
    config = await parseConfig({ configPath, defaultsPath });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith('ENOENT: config not found')) {
      emit({
        run_id: runId,
        issue: null,
        phase: 'cost-watchdog',
        event: 'cost.snapshot',
        payload: { budget_unconfigured: true, reason: 'no .dev-agent.yml' },
      });
      return;
    }
    throw e;
  }
  const budget = config.cost_caps?.monthly_budget_usd;
  const threshold = config.cost_caps?.alert_threshold_pct ?? 80;

  if (!budget || budget === 0) {
    emit({
      run_id: runId,
      issue: null,
      phase: 'cost-watchdog',
      event: 'cost.snapshot',
      payload: { budget_unconfigured: true },
    });
    return;
  }

  const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN / GITHUB_TOKEN required');
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY required (owner/repo)');

  const octokit = new Octokit({ auth: ghToken });
  const now = new Date();
  const monthStart = startOfMonthUtc(now);
  const ml = monthLabel(now);

  const issues = await collectIssuesWithComments(octokit, owner, repo, monthStart);
  const breakdown = aggregateCostFromComments(issues, monthStart);
  const pct = (breakdown.total / budget) * 100;

  emit({
    run_id: runId,
    issue: null,
    phase: 'cost-watchdog',
    event: 'cost.snapshot',
    payload: { total: breakdown.total, budget, pct, month: ml },
  });

  const tier = tierFor({ pct, threshold });
  if (tier === 'snapshot') return;

  const body = renderAlertBody({ tier, breakdown, budget, threshold, monthLabel: ml });
  const { number, created } = await upsertAlertIssue(octokit, owner, repo, {
    tier,
    body,
    monthLabel: ml,
    pctTotal: { pct, total: breakdown.total, budget },
  });

  emit({
    run_id: runId,
    issue: number,
    phase: 'cost-watchdog',
    event: 'cost.threshold.crossed',
    payload: {
      tier,
      pct,
      total: breakdown.total,
      budget,
      month: ml,
      issue_created: created,
    },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
