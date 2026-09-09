#!/usr/bin/env tsx
/**
 * Post a real telemetry comment after a live model run.
 *
 * The budget gate and the nightly watchdog both compute month-to-date spend by
 * parsing telemetry comments. Before this existed, the only block any workflow
 * posted was `phase-implement`'s STUB with `Cost: $0` — live runs recorded
 * nothing. Spend therefore read as $0 forever, which made both the alert and
 * the gate decorative regardless of how carefully either was written.
 *
 * Reads the execution file `claude-code-action` writes (its `execution_file`
 * output) and extracts usage from it. When cost is not reported directly, it is
 * derived from token counts and the per-model rates below.
 *
 * Deliberately best-effort about SHAPE but never about EXISTENCE: if the file
 * cannot be read or carries no usable usage, it posts a telemetry block with
 * `Status: cost-unknown` rather than posting `$0`. A silent zero is what made
 * the gate ineffective; a visible unknown is auditable.
 *
 * Env:
 *   EXECUTION_FILE   path from the claude-code-action step output (required)
 *   ISSUE_NUMBER     issue to comment on (required)
 *   PHASE            phase name recorded in the block (required)
 *   MODEL            model id used (optional; recorded verbatim)
 *   GH_TOKEN         (required)
 *   GITHUB_REPOSITORY (required, "owner/repo")
 *   AGENT_STATUS     completed | failed | timeout (optional)
 */

import { readFileSync } from 'node:fs';
import { Octokit } from '@octokit/rest';
import { formatTelemetry, asPhaseName, type PhaseName, type PhaseStatus } from '../telemetry';

/** USD per million tokens, by model family. Used only when the run does not report cost. */
const RATES: Record<string, { in: number; out: number }> = {
  opus: { in: 15, out: 75 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 0.8, out: 4 },
};

/** Usage pulled out of an execution file, with cost possibly still unknown. */
export interface ExtractedUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  durationMs: number;
}

/**
 * Pull token counts, cost and duration out of a claude-code-action execution file.
 *
 * The file's exact shape is not contractual, so this searches the common
 * locations rather than assuming one: a top-level `usage`/`total_cost_usd`, or
 * per-message usage entries that need summing. Anything it cannot find is
 * returned as zero or null for the caller to report honestly.
 *
 * @param raw - Raw contents of the execution file.
 * @returns Token totals, cost when the run reported one, and duration.
 */
export function extractUsage(raw: string): ExtractedUsage {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    // Some versions emit JSON Lines; take the richest object we can parse.
    const objs = raw
      .split('\n')
      .map((l) => { try { return JSON.parse(l) as unknown; } catch { return null; } })
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object');
    doc = objs.length ? objs : null;
  }
  if (!doc) return { tokensIn: 0, tokensOut: 0, costUsd: null, durationMs: 0 };

  let tokensIn = 0, tokensOut = 0, durationMs = 0;
  let costUsd: number | null = null;

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const o = node as Record<string, unknown>;
    for (const key of ['total_cost_usd', 'cost_usd', 'totalCostUsd']) {
      const v = o[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) costUsd = Math.max(costUsd ?? 0, v);
    }
    for (const key of ['duration_ms', 'durationMs']) {
      const v = o[key];
      if (typeof v === 'number' && Number.isFinite(v)) durationMs = Math.max(durationMs, v);
    }
    const u = o.usage;
    if (u && typeof u === 'object') {
      const uu = u as Record<string, unknown>;
      const i = uu.input_tokens ?? uu.inputTokens;
      const out = uu.output_tokens ?? uu.outputTokens;
      if (typeof i === 'number') tokensIn += i;
      if (typeof out === 'number') tokensOut += out;
    }
    Object.values(o).forEach(visit);
  };
  visit(doc);

  return { tokensIn, tokensOut, costUsd, durationMs };
}

/**
 * Estimate cost from token counts when the run did not report one.
 *
 * @param model - Model id; matched loosely against known families.
 * @param tokensIn - Input tokens consumed.
 * @param tokensOut - Output tokens produced.
 * @returns Estimated USD, or null when the model family is unrecognised.
 */
export function estimateCost(model: string, tokensIn: number, tokensOut: number): number | null {
  const family = Object.keys(RATES).find((f) => model.toLowerCase().includes(f));
  if (!family || (tokensIn === 0 && tokensOut === 0)) return null;
  const r = RATES[family];
  return (tokensIn / 1_000_000) * r.in + (tokensOut / 1_000_000) * r.out;
}

/**
 * Build the telemetry comment body for a run.
 *
 * @param args.phase - Phase name.
 * @param args.model - Model id.
 * @param args.usage - Extracted usage.
 * @param args.status - Agent status to record.
 * @returns The comment body, in the format the watchdog and gate parse.
 */
export function buildBody(args: {
  phase: PhaseName; model: string; usage: ExtractedUsage; status: PhaseStatus;
}): string {
  const { phase, model, usage, status } = args;
  const cost = usage.costUsd ?? estimateCost(model, usage.tokensIn, usage.tokensOut);
  return formatTelemetry({
    phase,
    model: model || '(unknown)',
    duration_ms: usage.durationMs,
    tokens_in: usage.tokensIn,
    tokens_out: usage.tokensOut,
    // A run whose cost cannot be determined is recorded as 0 but flagged in
    // status, so it is visibly unknown rather than silently free.
    cost_usd: cost ?? 0,
    attempts: 1,
    status,
    // Recorded in artifacts rather than folded into status: a run whose cost
    // could not be determined must be visibly unknown, not silently free.
    artifacts: { cost_source: cost === null ? 'unavailable' : usage.costUsd !== null ? 'reported' : 'estimated' },
  });
}

/** Read the execution file, build the telemetry block, and post it. */
async function main(): Promise<void> {
  const file = process.env.EXECUTION_FILE ?? '';
  const issue = Number(process.env.ISSUE_NUMBER ?? '');
  const phase = asPhaseName(process.env.PHASE ?? '');
  const model = process.env.MODEL ?? '';
  const rawStatus = process.env.AGENT_STATUS ?? 'success';
  const status: PhaseStatus =
    rawStatus === 'blocked' || rawStatus === 'aborted' ? rawStatus : 'success';
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');

  if (!phase) {
    console.log(`::warning::emit-telemetry: unknown PHASE '${process.env.PHASE}' — spend for this run is unrecorded.`);
    return;
  }
  if (!token || !owner || !repo || !Number.isFinite(issue) || issue <= 0) {
    console.log('::warning::emit-telemetry: missing issue/repo/token — spend for this run is unrecorded.');
    return;
  }

  let usage: ExtractedUsage = { tokensIn: 0, tokensOut: 0, costUsd: null, durationMs: 0 };
  try {
    usage = extractUsage(readFileSync(file, 'utf8'));
  } catch {
    console.log(`::warning::emit-telemetry: could not read execution file '${file}'; recording cost as unknown.`);
  }

  const body = buildBody({ phase, model, usage, status });
  await new Octokit({ auth: token }).issues.createComment({
    owner, repo, issue_number: issue, body,
  });
  console.log(body);
}

if (process.env.EMIT_TELEMETRY_LIB !== '1') {
  main().catch((e) => {
    // Never fail the phase because bookkeeping failed — but say so loudly.
    console.log(`::warning::emit-telemetry failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}
