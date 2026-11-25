import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

/** One workflow step, as far as this check reads it. */
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  'working-directory'?: string;
}

/**
 * List `gh` command lines that cannot tell which repository they act on.
 *
 * `gh` infers the repository from the git remote of the working directory.
 * Before the job has checked out the calling repository at the workspace
 * root — or in a step that runs somewhere else — there is no such remote, and
 * `gh pr view` / `gh issue …` fail on a fresh runner. Such a step must set
 * `GH_REPO` or pass `--repo`. `gh api` carries the repository in its path.
 *
 * @param dir - Directory holding the workflow files.
 * @returns `file :: job :: step :: line` for every offending line.
 */
function ghCallsWithoutRepoContext(dir: string): string[] {
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const wf = yaml.load(readFileSync(resolve(dir, file), 'utf8')) as {
      env?: Record<string, unknown>;
      jobs?: Record<string, { env?: Record<string, unknown>; steps?: Step[] }>;
    };
    for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
      let rootCheckout = false;
      for (const step of job.steps ?? []) {
        const w = step.with ?? {};
        if (step.uses?.startsWith('actions/checkout') && !w.repository && (!w.path || w.path === '.')) {
          rootCheckout = true;
        }
        if (typeof step.run !== 'string') continue;
        if (rootCheckout && !step['working-directory']) continue;
        const env = { ...(wf.env ?? {}), ...(job.env ?? {}), ...(step.env ?? {}) };
        if ('GH_REPO' in env) continue;
        for (const line of step.run.split('\n')) {
          if (/^\s*#/.test(line) || !/(^|[\s$(|;&])gh\s/.test(line)) continue;
          if (/--repo|\s-R\s|\bgh api\b/.test(line)) continue;
          out.push(`${file} :: ${jobName} :: ${step.name ?? '(unnamed)'} :: ${line.trim()}`);
        }
      }
    }
  }
  return out;
}

describe('gh calls know their repository', () => {
  it('every gh call before a checkout sets GH_REPO or passes --repo', () => {
    // Found on phase-pr-review's "Resolve PR head branch": `gh pr view` ran
    // before any checkout with only GH_TOKEN, so the fixer failed on every
    // fresh runner. Breaker: delete `GH_REPO: ${{ github.repository }}` from
    // that step and this lists it.
    expect(ghCallsWithoutRepoContext(resolve(__dirname, '../../.github/workflows'))).toEqual([]);
  });
});
