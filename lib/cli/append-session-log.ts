#!/usr/bin/env tsx
/**
 * CLI wrapper that builds a phase entry from env vars + prepends it to
 * SESSION_LOG.md in the current working directory.
 *
 * Used by phase workflows as a final step (with `if: always()`).
 *
 * Required env:
 *   PHASE              - implement | staging-deploy | promote-to-prod | rollback | ...
 *   ISSUE_NUMBER       - integer
 *   OUTCOME            - success | blocked | aborted | rolled_back
 *   NEXT_SESSION_HINT  - one-line handoff
 *
 * Optional env:
 *   TRIGGER, TOKENS_INPUT, TOKENS_OUTPUT, COST_USD, FILES_CHANGED, PR_URL,
 *   DEFERRED (newline-separated bullets).
 *
 * The workflow handles the `git add/commit/push` after this exits — this
 * binary only mutates the file.
 */
import { resolve } from 'node:path';
import { buildPhaseEntry, prependEntry, type PhaseOutcome } from '../session-log';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`append-session-log: missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

function optionalIntEnv(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function optionalFloatEnv(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function main(): void {
  const phase = requireEnv('PHASE');
  const issue = Number(requireEnv('ISSUE_NUMBER'));
  if (!Number.isInteger(issue)) {
    console.error('append-session-log: ISSUE_NUMBER must be an integer');
    process.exit(2);
  }
  const outcome = requireEnv('OUTCOME') as PhaseOutcome;
  const next_session_hint = requireEnv('NEXT_SESSION_HINT');

  const trigger = process.env.TRIGGER || undefined;
  const pr_url = process.env.PR_URL || undefined;
  const deferredRaw = process.env.DEFERRED || '';
  const deferred = deferredRaw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const entry = buildPhaseEntry({
    phase,
    issue,
    outcome,
    trigger,
    tokens: {
      input: optionalIntEnv('TOKENS_INPUT'),
      output: optionalIntEnv('TOKENS_OUTPUT'),
      cost_usd: optionalFloatEnv('COST_USD'),
    },
    files_changed: optionalIntEnv('FILES_CHANGED'),
    pr_url,
    deferred: deferred.length > 0 ? deferred : undefined,
    next_session_hint,
  });

  const filepath = resolve(process.cwd(), 'SESSION_LOG.md');
  const result = prependEntry(filepath, entry);
  if (result.changed) {
    console.log(`Appended ${phase} entry for issue #${issue} to SESSION_LOG.md`);
  } else {
    console.log(`SESSION_LOG.md already has this entry as the latest — no-op.`);
  }
}

main();
