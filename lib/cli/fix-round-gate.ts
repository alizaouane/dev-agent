#!/usr/bin/env tsx
/**
 * fix-round-gate — stop the comment-triggered fixer after N rounds on one PR.
 *
 * Called by `phase-pr-review` before any model call. Counts the fixer's commits
 * on the PR (see lib/fix-rounds.ts), compares them with
 * `pr_review.max_fix_rounds`, and on refusal posts one hand-over comment.
 *
 * Env:
 *   REPO          owner/name (required)
 *   PR_NUMBER     pull request number (required, integer)
 *   CONFIG_PATH   path to .dev-agent.yml (default `.dev-agent.yml`)
 *   GH_TOKEN      passed through to `gh`
 *   GITHUB_OUTPUT receives allow / rounds / max_rounds / reason
 *
 * Exit codes:
 *   0 — decision made; `allow` output carries it (a refusal is not a failure:
 *       the job ends green with the agent skipped)
 *   2 — could not decide (unreadable config, GitHub read failed). Fails closed.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../parse-config';
import {
  alreadyAnnouncedFixCap,
  countFixRounds,
  fixRoundDecision,
  renderFixCapComment,
  resolveMaxFixRounds,
} from '../fix-rounds';
import { postComment, readComments } from './pr-triage';

/**
 * Publish step outputs for the calling workflow.
 *
 * @param out - Output name → value.
 */
function report(out: Record<string, string | number | boolean>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  for (const [k, v] of Object.entries(out)) appendFileSync(file, `${k}=${v}\n`);
}

/**
 * Read the git author name of every commit on a PR, across all pages.
 *
 * @param repo - owner/name.
 * @param number - PR number.
 * @returns Author names, oldest first.
 * @throws When the GitHub read fails.
 */
export function readCommitAuthorNames(repo: string, number: number): string[] {
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
    repository(owner:$owner,name:$name){
      pullRequest(number:$number){
        commits(first:100,after:$endCursor){
          pageInfo{hasNextPage endCursor}
          nodes{ commit{ author{ name } } }
        }
      }
    }
  }`;
  const raw = execFileSync(
    'gh',
    [
      'api', 'graphql', '--paginate',
      '-f', `query=${query}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-F', `number=${number}`,
      '--jq', '.data.repository.pullRequest.commits.nodes[] | (.commit.author.name // "")',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return raw.split('\n').filter((l) => l !== '');
}

/**
 * Resolve the configured cap, failing closed on a config that exists but
 * cannot be read.
 *
 * @param configPath - Path to .dev-agent.yml.
 * @returns The cap to apply.
 * @throws When the config exists but is malformed or invalid.
 */
async function loadMaxRounds(configPath: string): Promise<number> {
  if (!existsSync(configPath)) return resolveMaxFixRounds(undefined);
  const defaultsPath = resolve(
    dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'defaults.yml',
  );
  return resolveMaxFixRounds(await parseConfig({ configPath, defaultsPath }));
}

/**
 * Count, decide, announce once, and publish the verdict.
 *
 * @returns Nothing; outputs and exit code carry the result.
 */
async function main(): Promise<void> {
  const repo = process.env.REPO ?? '';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('REPO required, as owner/name');
  const prNumber = Number(process.env.PR_NUMBER);
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error(`PR_NUMBER must be a positive integer, got: ${process.env.PR_NUMBER}`);
  }
  const configPath = process.env.CONFIG_PATH || '.dev-agent.yml';

  const maxRounds = await loadMaxRounds(configPath);
  const rounds = countFixRounds(readCommitAuthorNames(repo, prNumber));
  const decision = fixRoundDecision({ rounds, maxRounds });
  report({ allow: decision.allow, rounds, max_rounds: maxRounds, reason: decision.reason });

  if (decision.allow) {
    console.log(`Fix rounds on #${prNumber}: ${rounds}/${maxRounds} — proceeding.`);
    return;
  }
  console.log(`::notice::Fix-round cap reached on #${prNumber} (${rounds}/${maxRounds}); fixer skipped.`);
  if (!alreadyAnnouncedFixCap(readComments(repo, prNumber))) {
    postComment(repo, prNumber, renderFixCapComment({ prNumber, rounds, maxRounds }));
  }
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  main().catch((err) => {
    console.error(`::error::Fix-round gate failed: ${err instanceof Error ? err.message : String(err)}`);
    report({ allow: false, reason: 'gate-error' });
    process.exit(2);
  });
}
