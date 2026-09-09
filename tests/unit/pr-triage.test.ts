import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeChecks, toPullRequestState } from '../../lib/cli/pr-triage';
import {
  AUTOPILOT_MARKER,
  priorSignatures,
  renderWakeComment,
  renderWedgedComment,
  shouldWake,
  triagePullRequest,
} from '../../lib/pr-blockers';

describe('normalizeChecks', () => {
  it('reads a finished CheckRun from its conclusion', () => {
    expect(normalizeChecks([{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }])).toEqual([
      { name: 'test', conclusion: 'FAILURE' },
    ]);
  });

  it('reports a running CheckRun as unfinished, not as passed', () => {
    // A CheckRun carries no conclusion until it completes. Reading the absent
    // field as "nothing wrong" is how a red PR looks green mid-run.
    expect(normalizeChecks([{ name: 'test', status: 'IN_PROGRESS', conclusion: null }])).toEqual([
      { name: 'test', conclusion: null },
    ]);
  });

  it('reads a StatusContext from its state, which has no conclusion field', () => {
    // The rollup mixes two shapes. A StatusContext never has `conclusion`, so
    // a normalizer that only looked there would silently drop every commit
    // status — including a failing one.
    expect(normalizeChecks([{ context: 'vercel', state: 'failure' }])).toEqual([
      { name: 'vercel', conclusion: 'FAILURE' },
    ]);
  });

  it('names an unnamed check rather than emitting undefined', () => {
    expect(normalizeChecks([{ state: 'success' }])[0].name).toBe('unnamed check');
  });

  it('treats a missing rollup as no checks', () => {
    expect(normalizeChecks(null)).toEqual([]);
    expect(normalizeChecks(undefined)).toEqual([]);
  });
});

describe('toPullRequestState', () => {
  const raw = {
    number: 7,
    headRefName: 'dev-agent/spec-thing',
    headRefOid: 'head1234',
    isDraft: false,
    reviewDecision: null,
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviews: [
      { author: { login: 'coderabbitai[bot]' }, state: 'COMMENTED', commit: { oid: 'older' } },
      { author: { login: 'alizaouane' }, state: 'APPROVED', commit: { oid: 'older' } },
    ],
  };

  it('strips the [bot] suffix so bot detection matches the login', () => {
    // gh returns `coderabbitai[bot]`; the bot list holds `coderabbitai`. Miss
    // this and every bot reads as a human, and no review is ever stale.
    const state = toPullRequestState(raw, 0);
    expect(state.reviews[0]).toMatchObject({ author: 'coderabbitai', isBot: true });
    expect(state.reviews[1]).toMatchObject({ author: 'alizaouane', isBot: false });
  });

  it('feeds a state the triage flags as a stale bot review', () => {
    expect(triagePullRequest(toPullRequestState(raw, 0)).blockers.map((b) => b.kind)).toEqual([
      'stale-bot-review',
    ]);
  });

  it('carries the thread count straight through', () => {
    expect(toPullRequestState(raw, 4).unresolvedThreadCount).toBe(4);
  });

  it('carries label names, which the autopilot:off switch depends on', () => {
    const withLabels = { ...raw, labels: [{ name: 'autopilot:off' }, {}] };
    expect(toPullRequestState(withLabels, 0).labels).toEqual(['autopilot:off']);
  });

  it('treats a PR with no labels as unlabelled rather than undefined', () => {
    expect(toPullRequestState({ ...raw, labels: null }, 0).labels).toEqual([]);
  });
});

describe('countUnresolvedThreads query', () => {
  const source = readFileSync(resolve(__dirname, '../../lib/cli/pr-triage.ts'), 'utf8');

  it('names its cursor variable endCursor, the only name --paginate advances', () => {
    // gh injects the next page's cursor into a variable named exactly
    // `endCursor`. Called anything else, page two is never fetched and gh
    // errors on the undefined variable — aborting the sweep for every PR.
    expect(source).toMatch(/\$endCursor:String/);
    expect(source).toMatch(/after:\$endCursor/);
    expect(source).not.toMatch(/after:\$cursor\b/);
  });
});

describe('pr-autopilot.yml', () => {
  const raw = readFileSync(
    resolve(__dirname, '../../.github/workflows/pr-autopilot.yml'),
    'utf8',
  );

  it('runs on a schedule, so it does not need a session open', () => {
    // The whole point: the same rules ran as a laptop Stop hook, which only
    // fired while a session was live and the machine awake.
    expect(raw).toMatch(/^on:/m);
    expect(raw).toMatch(/schedule:/);
    expect(raw).toMatch(/cron:/);
  });

  it('does not let two sweeps race each other into double comments', () => {
    expect(raw).toMatch(/concurrency:/);
    expect(raw).toMatch(/group: pr-autopilot-/);
  });

  it('asks for no more permission than it uses', () => {
    // The sweep reads state and writes one comment. Pushing is the fixer's
    // job, under the fixer's own permissions.
    expect(raw).toMatch(/contents: read/);
    expect(raw).toMatch(/pull-requests: write/);
    expect(raw).not.toMatch(/contents: write/);
  });

  it('honours a per-PR kill switch', () => {
    expect(raw).toMatch(/autopilot:off/);
  });

  it('makes no model call of its own', () => {
    // The sweep is gh reads plus one comment. A second fixer here would be a
    // second way to spend past the budget cap that phase-pr-review enforces.
    expect(raw).not.toMatch(/ANTHROPIC_API_KEY|claude-code-action/);
  });

  it('supports a dry run, and passes it to the CLI that decides', () => {
    // The dry run has to be honoured where the posting happens, not by
    // skipping a job — a guard in the wrong place is how a "safe" flag ends
    // up posting anyway.
    expect(raw).toMatch(/dry_run:/);
    expect(raw).toMatch(/DRY_RUN: \$\{\{ inputs\.dry_run \}\}/);
  });

  it('passes untrusted-ish input through env, never into a run block', () => {
    // pr_number is a dispatch input. Interpolating it directly into `run:`
    // is the standard Actions injection shape.
    const uses = raw
      .split('\n')
      .filter((l) => l.includes('inputs.pr_number'))
      .map((l) => l.trim());
    // Exactly one use, and it is the env binding — not a `run:` interpolation.
    expect(uses).toEqual(['PR_NUMBER: ${{ inputs.pr_number }}']);
  });

  it('runs the triage CLI rather than reimplementing the rules in bash', () => {
    expect(raw).toMatch(/lib\/cli\/pr-triage\.ts/);
  });
});

describe('shouldWake', () => {
  it('wakes on a blocker set it has not seen', () => {
    expect(shouldWake('failing-check', [])).toMatchObject({ wake: true, reason: 'new-blockers' });
  });

  it('wakes again on an unchanged set, because one missed run must not strand a PR', () => {
    expect(shouldWake('failing-check', ['failing-check'])).toMatchObject({
      wake: true,
      repeats: 1,
      reason: 'unchanged-blockers',
    });
  });

  it('stands down once the same set has survived enough attempts', () => {
    const priors = ['failing-check', 'failing-check', 'failing-check', 'failing-check'];
    expect(shouldWake('failing-check', priors)).toMatchObject({ wake: false, reason: 'wedged' });
  });

  it('resets the count when the blockers change, so progress is not punished', () => {
    const priors = ['failing-check', 'failing-check', 'failing-check', 'failing-check'];
    expect(shouldWake('unresolved-threads', priors)).toMatchObject({
      wake: true,
      repeats: 0,
    });
  });

  it('counts only the trailing run of identical signatures', () => {
    const priors = ['a', 'a', 'a', 'b', 'a'];
    expect(shouldWake('a', priors).repeats).toBe(1);
  });
});

describe('priorSignatures', () => {
  it('reads back only its own comments', () => {
    const bodies = [
      'a human said something',
      `${AUTOPILOT_MARKER}\n<!-- signature:failing-check -->\n@claude fix it`,
      'coderabbit walkthrough',
    ];
    expect(priorSignatures(bodies)).toEqual(['failing-check']);
  });

  it('ignores an autopilot comment with no signature rather than counting a blank', () => {
    expect(priorSignatures([`${AUTOPILOT_MARKER}\nno signature here`])).toEqual([]);
  });
});

describe('renderWakeComment', () => {
  const triage = triagePullRequest({
    number: 5,
    headRefName: 'dev-agent/spec-thing',
    labels: [],
    headOid: 'head1234',
    isDraft: false,
    reviewDecision: null,
    checks: [{ name: 'test', conclusion: 'FAILURE' }],
    reviews: [],
    unresolvedThreadCount: 2,
  });

  it('mentions @claude, which is the trigger phase-pr-review listens for', () => {
    expect(renderWakeComment(triage, shouldWake(triage.signature, []))).toContain('@claude');
  });

  it('embeds a signature the next sweep can read back', () => {
    const body = renderWakeComment(triage, shouldWake(triage.signature, []));
    expect(priorSignatures([body])).toEqual([triage.signature]);
  });

  it('lists every blocker, so the thread says why it woke', () => {
    const body = renderWakeComment(triage, shouldWake(triage.signature, []));
    expect(body).toContain('failing check');
    expect(body).toContain('2 unresolved review thread(s)');
  });

  it('says which attempt this is once it is retrying', () => {
    const body = renderWakeComment(triage, shouldWake(triage.signature, [triage.signature]));
    expect(body).toContain('Attempt 2');
    expect(body).toContain('autopilot:off');
  });
});

describe('renderWedgedComment', () => {
  const triage = triagePullRequest({
    number: 5,
    headRefName: 'feat/dev-agent-issue-5',
    labels: [],
    headOid: 'head1234',
    isDraft: false,
    reviewDecision: 'CHANGES_REQUESTED',
    checks: [],
    reviews: [],
    unresolvedThreadCount: 0,
  });

  it('says out loud that it has stopped, rather than going quiet', () => {
    // A PR the autopilot silently abandoned looks exactly like one it is still
    // working — the situation this whole mechanism exists to prevent.
    const body = renderWedgedComment(triage, { wake: false, repeats: 4, reason: 'wedged' });
    expect(body).toContain('standing down');
    expect(body).toContain('woken the fixer 4 times');
    expect(body).toContain('<!-- wedged -->');
  });

  it('does not mention @claude, which would re-trigger the fixer it just stopped', () => {
    const body = renderWedgedComment(triage, { wake: false, repeats: 4, reason: 'wedged' });
    expect(body).not.toMatch(/^@claude/m);
  });
});
