#!/usr/bin/env tsx
/**
 * orch-unstick — admin command to reset a stuck issue's state labels.
 *
 * Used when an orchestration phase fails mid-flight (workflow timeout,
 * runner crash, kill switch fires) and an issue is left in one of the
 * "in-flight" states (acm-building, implementing, swarm-reviewing,
 * tier2-smoke, staging-deployed, promoting) for longer than the
 * orch-sweep threshold. The cron `orch-sweep.yml` flags such issues
 * with `state:stuck`; an operator runs this CLI to manually reset.
 *
 * The command is deliberately non-automated — moving an issue's state
 * is a privileged operation that should be a human decision. orch-sweep
 * surfaces the candidates; this CLI executes the move.
 *
 * Usage:
 *   ISSUE=42 ORG=alizaouane REPO=dev-agent TARGET_STATE=state:blocked \
 *     JUSTIFICATION='workflow timeout on phase-implement, see run #1234' \
 *     tsx lib/cli/orch-unstick.ts
 *
 * Required env:
 *   ISSUE         Issue number to operate on
 *   ORG           Repo owner
 *   REPO          Repo name
 *   TARGET_STATE  The state label to set (must be a valid STATE_LABEL)
 *   JUSTIFICATION Required free-text reason (≥10 chars) for the audit log
 *
 * Optional env:
 *   GH_TOKEN      Authentication token (default: gh CLI's own auth)
 *   DRY_RUN=true  Print what would happen without making API calls
 *
 * Exit code: 0 on success, 1 on validation failure, 2 on API failure.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATE_LABELS, type StateLabel } from '../orchestrator';

interface Args {
  issue: string;
  org: string;
  repo: string;
  targetState: StateLabel;
  justification: string;
  dryRun: boolean;
}

export class ValidationError extends Error {}

export function readArgs(env: NodeJS.ProcessEnv): Args {
  const issue = env.ISSUE;
  const org = env.ORG;
  const repo = env.REPO;
  const targetState = env.TARGET_STATE;
  const justification = env.JUSTIFICATION;
  const dryRun = env.DRY_RUN === 'true' || env.DRY_RUN === '1';

  if (!issue || !/^\d+$/.test(issue)) throw new ValidationError('ISSUE required (digits only)');
  if (!org || !/^[a-z0-9-]+$/i.test(org)) throw new ValidationError('ORG required (alphanumeric/hyphen)');
  if (!repo || !/^[a-z0-9._-]+$/i.test(repo)) throw new ValidationError('REPO required (alphanumeric/dot/hyphen/underscore)');
  if (!targetState) throw new ValidationError('TARGET_STATE required');
  if (!STATE_LABELS.includes(targetState as StateLabel)) {
    throw new ValidationError(`TARGET_STATE must be one of: ${STATE_LABELS.join(', ')}`);
  }
  if (!justification || justification.trim().length < 10) {
    throw new ValidationError('JUSTIFICATION required (≥10 chars; recorded in the audit comment)');
  }
  return {
    issue,
    org,
    repo,
    targetState: targetState as StateLabel,
    justification: justification.trim(),
    dryRun,
  };
}

/** Returns the existing state labels on the issue (subset of STATE_LABELS). */
export function findExistingStateLabels(labels: string[]): StateLabel[] {
  return labels.filter((l): l is StateLabel => STATE_LABELS.includes(l as StateLabel));
}

interface GhRunner {
  view(args: Args): { labels: string[] };
  removeLabel(args: Args, label: string): void;
  addLabel(args: Args, label: string): void;
  comment(args: Args, body: string): void;
}

const realGh: GhRunner = {
  view: (args) => {
    const out = execFileSync(
      'gh',
      ['issue', 'view', args.issue, '--repo', `${args.org}/${args.repo}`, '--json', 'labels'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out) as { labels: Array<{ name: string }> };
    return { labels: parsed.labels.map((l) => l.name) };
  },
  removeLabel: (args, label) => {
    execFileSync(
      'gh',
      ['issue', 'edit', args.issue, '--repo', `${args.org}/${args.repo}`, '--remove-label', label],
      { encoding: 'utf8' },
    );
  },
  addLabel: (args, label) => {
    execFileSync(
      'gh',
      ['issue', 'edit', args.issue, '--repo', `${args.org}/${args.repo}`, '--add-label', label],
      { encoding: 'utf8' },
    );
  },
  comment: (args, body) => {
    execFileSync(
      'gh',
      ['issue', 'comment', args.issue, '--repo', `${args.org}/${args.repo}`, '--body', body],
      { encoding: 'utf8' },
    );
  },
};

const dryRunGh: GhRunner = {
  view: (args) => {
    process.stdout.write(`DRY-RUN: would view ${args.org}/${args.repo}#${args.issue}\n`);
    return { labels: [] };
  },
  removeLabel: (args, label) => {
    process.stdout.write(`DRY-RUN: would remove label "${label}" from #${args.issue}\n`);
  },
  addLabel: (args, label) => {
    process.stdout.write(`DRY-RUN: would add label "${label}" to #${args.issue}\n`);
  },
  comment: (args, body) => {
    process.stdout.write(`DRY-RUN: would comment on #${args.issue}:\n${body}\n`);
  },
};

export interface UnstickOutcome {
  removed: StateLabel[];
  added: StateLabel;
  comment_posted: boolean;
}

export function performUnstick(args: Args, gh: GhRunner = args.dryRun ? dryRunGh : realGh): UnstickOutcome {
  const view = gh.view(args);
  const existing = findExistingStateLabels(view.labels);

  // Remove every existing state:* label except the target (idempotent).
  const removed: StateLabel[] = [];
  for (const label of existing) {
    if (label === args.targetState) continue;
    gh.removeLabel(args, label);
    removed.push(label);
  }

  if (!existing.includes(args.targetState)) {
    gh.addLabel(args, args.targetState);
  }

  const commentBody = [
    '🛠️ orch-unstick',
    '',
    `**Target state:** \`${args.targetState}\``,
    `**Justification:** ${args.justification}`,
    `**Removed labels:** ${removed.length === 0 ? '(none)' : removed.map((l) => `\`${l}\``).join(', ')}`,
    '',
    'This is a privileged manual reset. Future runs will continue from the new state.',
  ].join('\n');
  gh.comment(args, commentBody);

  return { removed, added: args.targetState, comment_posted: true };
}

async function main(): Promise<void> {
  const args = readArgs(process.env);
  const outcome = performUnstick(args);
  process.stdout.write(
    `orch-unstick: ${args.org}/${args.repo}#${args.issue} → ${outcome.added} (removed: ${outcome.removed.join(', ') || 'none'})\n`,
  );
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((err) => {
    if (err instanceof ValidationError) {
      process.stderr.write(`orch-unstick: invalid args: ${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`orch-unstick failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
