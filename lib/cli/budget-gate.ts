#!/usr/bin/env tsx
/**
 * Pre-flight monthly-budget gate (§22.1).
 *
 * The nightly watchdog (`cost-watchdog.ts`) reports spend that has ALREADY
 * happened — by the time it files an issue the money is gone. That is
 * monitoring. This is the control half: phase workflows call it before doing
 * any model work, and it refuses to let the run start when the month's budget
 * is spent, or when this phase's projected cost would cross it.
 *
 * Reuses the watchdog's own spend collection so both halves agree on the
 * number, including its rule that only `github-actions[bot]` telemetry counts.
 *
 * Exit codes:
 *   0 — proceed (within budget, no budget configured, or operator override)
 *   1 — refuse; the calling workflow must not run the phase
 *   2 — could not determine spend. Fails CLOSED when a budget is configured:
 *       an unknown spend is not evidence of headroom.
 *
 * Env:
 *   GH_TOKEN / GITHUB_TOKEN  (required when a budget is configured)
 *   GITHUB_REPOSITORY        (required, "owner/repo")
 *   CONFIG_PATH              (optional; defaults to `.dev-agent.yml`)
 *   PHASE                    (optional; keys into cost_caps for projected cost)
 *   BUDGET_OVERRIDE          ("true" to proceed past the cap, recorded in output)
 *   GITHUB_OUTPUT            (optional; receives allow/reason/spent/budget)
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
import { Octokit } from '@octokit/rest';
import { parseConfig } from '../parse-config';
import { aggregateCostFromComments, budgetGateDecision } from '../cost-watchdog';
import { collectIssuesWithComments, startOfMonthUtc } from './cost-watchdog';

/**
 * Publish the decision to the workflow, both as step outputs and as a log line.
 *
 * @param out - Fields the calling workflow can branch on.
 */
function report(out: Record<string, string | number | boolean>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) {
    for (const [k, v] of Object.entries(out)) appendFileSync(file, `${k}=${v}\n`);
  }
}

/**
 * Read month-to-date spend, apply the gate, and exit with the verdict.
 *
 * @returns Nothing; the process exit code carries the decision.
 */
async function main(): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? '.dev-agent.yml';
  const defaultsPath = resolve(
    dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'defaults.yml',
  );
  const phase = process.env.PHASE ?? '';
  const override = process.env.BUDGET_OVERRIDE === 'true';

  let config: Awaited<ReturnType<typeof parseConfig>> | undefined;
  try {
    config = await parseConfig({ configPath, defaultsPath });
  } catch {
    // No config is not a budget breach; it is a repo that has not opted in.
    console.log('No .dev-agent.yml — budget gate inactive.');
    report({ allow: true, reason: 'no-budget-configured' });
    return;
  }

  const budgetUsd = config.cost_caps?.monthly_budget_usd ?? 0;
  const phaseCostUsd =
    phase && typeof (config.cost_caps as Record<string, unknown>)?.[phase] === 'object'
      ? ((config.cost_caps as Record<string, { dollars?: number }>)[phase]?.dollars ?? 0)
      : 0;

  if (!budgetUsd) {
    const d = budgetGateDecision({ spentUsd: 0, budgetUsd: 0 });
    console.log(d.message);
    report({ allow: true, reason: d.reason });
    return;
  }

  const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  if (!ghToken || !owner || !repo) {
    // A budget IS configured but spend cannot be read. Failing open here would
    // make the gate disappear exactly when it is misconfigured.
    console.error(
      '::error::Budget gate cannot read spend (missing GH_TOKEN or GITHUB_REPOSITORY) ' +
      'while a monthly budget is configured. Refusing to start rather than assuming headroom.',
    );
    report({ allow: false, reason: 'spend-unknown' });
    process.exit(2);
  }

  let spentUsd: number;
  try {
    const octokit = new Octokit({ auth: ghToken });
    const monthStart = startOfMonthUtc(new Date());
    const issues = await collectIssuesWithComments(octokit, owner, repo, monthStart);
    spentUsd = aggregateCostFromComments(issues, monthStart).total;
  } catch (e) {
    console.error(
      `::error::Budget gate could not determine month-to-date spend (${
        e instanceof Error ? e.message : String(e)
      }). Refusing to start rather than assuming headroom.`,
    );
    report({ allow: false, reason: 'spend-unknown' });
    process.exit(2);
  }

  const decision = budgetGateDecision({ spentUsd, budgetUsd, phaseCostUsd, override });
  report({
    allow: decision.allow,
    reason: decision.reason,
    spent_usd: decision.spentUsd.toFixed(2),
    budget_usd: decision.budgetUsd.toFixed(2),
    pct: decision.pct.toFixed(1),
  });

  if (!decision.allow) {
    console.error(`::error::${decision.message}`);
    process.exit(1);
  }
  console.log(decision.message);
}

main().catch((e) => {
  console.error(`::error::Budget gate failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
