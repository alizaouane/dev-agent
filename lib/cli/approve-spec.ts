#!/usr/bin/env tsx
/**
 * approve-spec — record a human approval of a reviewed spec.
 *
 * Run from the consumer repo at the end of the Claude Code intake session,
 * after the independent review has come back clean and the user has said yes
 * in their own words. It writes the artifact the dashboard's dispatch gate
 * checks before it will start any work: see `lib/spec-approval.ts` for why the
 * artifact is bound to a hash rather than to a label.
 *
 * This is deliberately not something a model decides to run on its own behalf:
 * the skill that calls it must have an explicit approval from the user in the
 * same turn, and `APPROVED_BY` records whose approval it was.
 *
 * Required env:
 *   SPEC_PATH        Repo-relative path to the approved spec (.md).
 *   REVIEW_VERDICT   The verdict being approved: ok | concerns.
 *   REVIEW_ROUNDS    How many review-and-correct rounds it took (integer >= 1).
 *
 * Optional env:
 *   PLAN_PATH        Repo-relative path to the approved plan (.md). Omit only
 *                    on the quick-dev route, which writes no separate plan.
 *                    Omitting it when a plan exists produces an approval the
 *                    gate will reject, because the issue names a plan the
 *                    approval does not cover.
 *   APPROVED_BY      Approver identity. Defaults to `git config user.email`.
 *   REPO_ROOT        Repo root the paths are relative to. Defaults to cwd.
 *
 * Output: the approval JSON to stdout, and the same content written to the
 * spec's sibling `.approval.json` path.
 * Exit code: 0 on success, 2 on any input or filesystem error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SPEC_APPROVAL_SCHEMA_VERSION,
  approvalPathForSpec,
  hashSpecAndPlan,
  type ReviewVerdict,
  type SpecApproval,
} from '../spec-approval';

/** Inputs the approval record is built from, already resolved from env. */
export interface ApproveSpecInput {
  specPath: string;
  planPath: string | null;
  reviewVerdict: ReviewVerdict;
  reviewRounds: number;
  approvedBy: string;
  repoRoot: string;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => Date;
}

/**
 * Build the approval record for a spec and plan that exist on disk.
 *
 * A `blocker` verdict is rejected here rather than at the gate, so a blocked
 * spec cannot even produce an approval artifact to argue about later.
 *
 * @param input - Resolved approval inputs.
 * @returns The approval record and the repo-relative path to write it to.
 * @throws If either document is missing, or the verdict is `blocker`.
 */
export function buildApproval(input: ApproveSpecInput): {
  approval: SpecApproval;
  outPath: string;
} {
  const { specPath, planPath, reviewVerdict, reviewRounds, approvedBy, repoRoot } = input;

  if (reviewVerdict === 'blocker') {
    throw new Error(
      'refusing to record an approval against a blocking review — correct the spec and plan, ' +
        're-run the review, and approve the clean result',
    );
  }
  if (!Number.isInteger(reviewRounds) || reviewRounds < 1) {
    throw new Error(`REVIEW_ROUNDS must be an integer >= 1, got: ${reviewRounds}`);
  }

  const specAbs = resolve(repoRoot, specPath);
  if (!existsSync(specAbs)) throw new Error(`spec not found: ${specPath}`);
  const planAbs = planPath === null ? null : resolve(repoRoot, planPath);
  if (planAbs !== null && !existsSync(planAbs)) {
    throw new Error(`plan not found: ${planPath}`);
  }

  const approval: SpecApproval = {
    schema_version: SPEC_APPROVAL_SCHEMA_VERSION,
    spec_path: specPath,
    plan_path: planPath,
    spec_sha256: hashSpecAndPlan(
      readFileSync(specAbs, 'utf8'),
      planAbs === null ? null : readFileSync(planAbs, 'utf8'),
    ),
    review_verdict: reviewVerdict,
    review_rounds: reviewRounds,
    approved_by: approvedBy,
    approved_at: (input.now ?? (() => new Date()))().toISOString(),
  };

  return { approval, outPath: approvalPathForSpec(specPath) };
}

/**
 * Resolve the approver's identity from the local git config.
 *
 * @param repoRoot - Repo to read the config from.
 * @returns The configured user email, or `unknown` when git has none.
 */
function gitIdentity(repoRoot: string): string {
  try {
    return execFileSync('git', ['config', 'user.email'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * CLI entry point: read env, write the approval artifact, echo it to stdout.
 *
 * @returns Nothing; exits the process on failure.
 */
function main(): void {
  const repoRoot = process.env.REPO_ROOT ?? process.cwd();
  const specPath = process.env.SPEC_PATH;
  const planPath = process.env.PLAN_PATH;
  const verdict = process.env.REVIEW_VERDICT;
  const roundsRaw = process.env.REVIEW_ROUNDS;

  if (!specPath) throw new Error('SPEC_PATH required');
  if (verdict !== 'ok' && verdict !== 'concerns' && verdict !== 'blocker') {
    throw new Error(`REVIEW_VERDICT must be ok | concerns | blocker, got: ${verdict ?? '<unset>'}`);
  }
  if (!roundsRaw || !/^\d+$/.test(roundsRaw)) {
    throw new Error(`REVIEW_ROUNDS must be a positive integer, got: ${roundsRaw ?? '<unset>'}`);
  }

  const { approval, outPath } = buildApproval({
    specPath,
    planPath: planPath?.trim() || null,
    reviewVerdict: verdict,
    reviewRounds: Number(roundsRaw),
    approvedBy: process.env.APPROVED_BY?.trim() || gitIdentity(repoRoot),
    repoRoot,
  });

  const json = JSON.stringify(approval, null, 2) + '\n';
  writeFileSync(resolve(repoRoot, outPath), json, 'utf8');
  process.stdout.write(json);
  process.stderr.write(`approval written to ${outPath}\n`);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `approve-spec failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}
