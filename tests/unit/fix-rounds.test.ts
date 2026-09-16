import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  DEFAULT_MAX_FIX_ROUNDS,
  FIXER_COMMIT_AUTHOR,
  FIX_CAP_MARKER,
  alreadyAnnouncedFixCap,
  countFixRounds,
  fixRoundDecision,
  renderFixCapComment,
  resolveMaxFixRounds,
} from '../../lib/fix-rounds';
import { devAgentConfigSchema } from '../../lib/schema';

describe('countFixRounds', () => {
  it('counts only commits the fixer authored', () => {
    // Implement-phase commits are authored by dev-agent[bot] and a person's by
    // their own name; neither is a review-fix round. Counting them would stand
    // the fixer down on a PR it has never touched.
    expect(
      countFixRounds([FIXER_COMMIT_AUTHOR, 'dev-agent[bot]', 'Ali', FIXER_COMMIT_AUTHOR]),
    ).toBe(2);
  });

  it('is zero on a PR the fixer has not pushed to', () => {
    expect(countFixRounds(['dev-agent[bot]'])).toBe(0);
    expect(countFixRounds([])).toBe(0);
  });

  it('does not match a name that merely contains the fixer name', () => {
    expect(countFixRounds(['not-claude[bot]', 'claude[bot] impersonator'])).toBe(0);
  });
});

describe('fixRoundDecision', () => {
  it('allows a round while under the cap', () => {
    expect(fixRoundDecision({ rounds: 2, maxRounds: 3 })).toEqual({
      allow: true,
      rounds: 2,
      maxRounds: 3,
      reason: 'under-cap',
    });
  });

  it('refuses once the cap is reached, not one round later', () => {
    // Off-by-one guard: with a cap of 3, three fixer pushes are allowed and the
    // fourth run must not start. `>` instead of `>=` would permit a fourth.
    expect(fixRoundDecision({ rounds: 3, maxRounds: 3 }).allow).toBe(false);
    expect(fixRoundDecision({ rounds: 3, maxRounds: 3 }).reason).toBe('cap-reached');
    expect(fixRoundDecision({ rounds: 7, maxRounds: 3 }).allow).toBe(false);
  });

  it('defaults to a cap of 3', () => {
    expect(DEFAULT_MAX_FIX_ROUNDS).toBe(3);
  });
});

describe('resolveMaxFixRounds', () => {
  it('reads pr_review.max_fix_rounds from the config', () => {
    expect(resolveMaxFixRounds({ pr_review: { max_fix_rounds: 5 } })).toBe(5);
  });

  it('falls back to the default when the section is absent', () => {
    expect(resolveMaxFixRounds({})).toBe(DEFAULT_MAX_FIX_ROUNDS);
    expect(resolveMaxFixRounds(undefined)).toBe(DEFAULT_MAX_FIX_ROUNDS);
  });
});

describe('renderFixCapComment', () => {
  const body = renderFixCapComment({ prNumber: 42, rounds: 3, maxRounds: 3 });

  it('carries the marker so the cap is announced once', () => {
    expect(body).toContain(FIX_CAP_MARKER);
  });

  it('never mentions the fixer, which would wake it again', () => {
    // The consumer wrapper lets github-actions[bot] wake the fixer with an
    // `@claude` mention. A cap notice that contained one would restart the loop
    // it is announcing the end of.
    expect(body).not.toMatch(/@claude/i);
  });

  it('tells a human to take over and says how to raise the cap', () => {
    expect(body).toMatch(/human/i);
    expect(body).toContain('pr_review.max_fix_rounds');
    expect(body).toContain('3');
  });
});

describe('alreadyAnnouncedFixCap', () => {
  it('recognises its own announcement', () => {
    expect(
      alreadyAnnouncedFixCap([{ author: 'github-actions', body: `x ${FIX_CAP_MARKER}` }]),
    ).toBe(true);
  });

  it('ignores a pasted marker from anyone else', () => {
    // A forged marker would otherwise silence the fixer on a PR permanently.
    expect(
      alreadyAnnouncedFixCap([{ author: 'someone', body: FIX_CAP_MARKER }]),
    ).toBe(false);
  });
});

describe('config schema', () => {
  it('ships pr_review.max_fix_rounds = 3 in defaults.yml', () => {
    const defaults = yaml.load(
      readFileSync(resolve(__dirname, '../../schema/defaults.yml'), 'utf8'),
    ) as { pr_review?: { max_fix_rounds?: number } };
    expect(defaults.pr_review?.max_fix_rounds).toBe(DEFAULT_MAX_FIX_ROUNDS);
  });

  it('rejects a cap below 1, which would silently disable the fixer', () => {
    const defaults = yaml.load(
      readFileSync(resolve(__dirname, '../../schema/defaults.yml'), 'utf8'),
    ) as Record<string, unknown>;
    const bad = { ...defaults, pr_review: { max_fix_rounds: 0 } };
    expect(devAgentConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('documents the key in the JSON schema', () => {
    const schema = yaml.load(
      readFileSync(resolve(__dirname, '../../schema/dev-agent.schema.yml'), 'utf8'),
    ) as { properties: Record<string, { properties?: Record<string, unknown> }> };
    expect(schema.properties.pr_review?.properties).toHaveProperty('max_fix_rounds');
  });
});

describe('phase-pr-review.yml fix-round cap wiring', () => {
  const raw = readFileSync(
    resolve(__dirname, '../../.github/workflows/phase-pr-review.yml'),
    'utf8',
  );
  const parsed = yaml.load(raw) as {
    jobs: Record<string, { steps: Array<{ name?: string; id?: string; if?: string; with?: Record<string, unknown> }> }>;
  };
  const steps = parsed.jobs['pr-review'].steps;
  const idx = (name: string) => steps.findIndex((s) => s.name === name);

  it('runs the cap gate before the agent', () => {
    const gate = idx('Fix-round cap');
    expect(gate).toBeGreaterThan(-1);
    expect(steps[gate].id).toBe('fixcap');
    expect(gate).toBeLessThan(idx('Run Claude Code (live agent)'));
  });

  it('skips the agent when the cap refuses', () => {
    const agent = steps[idx('Run Claude Code (live agent)')];
    expect(agent.if).toContain("steps.fixcap.outputs.allow != 'false'");
  });

  it('serialises fixer runs per PR so parallel triggers cannot both pass the cap', () => {
    // A bot review posts several @claude comments at once. Without a per-PR
    // group, each run reads the same count before any of them has pushed, so
    // all of them pass a cap that only one should.
    const job = (yaml.load(raw) as {
      jobs: Record<string, { concurrency?: { group?: string; 'cancel-in-progress'?: boolean } }>;
    }).jobs['pr-review'];
    expect(job.concurrency?.group).toMatch(/github\.repository/);
    expect(job.concurrency?.group).toMatch(/inputs\.pr_number \|\| github\.event\.issue\.number \|\| github\.event\.pull_request\.number/);
    expect(job.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it('pins the fixer commit author the counter relies on', () => {
    const agent = steps[idx('Run Claude Code (live agent)')];
    expect(agent.with?.bot_name).toBe(FIXER_COMMIT_AUTHOR);
  });
});
