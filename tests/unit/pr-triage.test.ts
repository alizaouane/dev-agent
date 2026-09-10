import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeChecks, toPullRequestState } from '../../lib/cli/pr-triage';
import {
  AUTOPILOT_MARKER,
  READY_MARKER,
  alreadyAnnouncedReady,
  isReadyToMerge,
  triagePullRequest as triage,
  priorSignatures,
  renderReadyComment,
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

describe('the open-PR query', () => {
  const source = readFileSync(resolve(__dirname, '../../lib/cli/pr-triage.ts'), 'utf8');

  /** The GraphQL query text itself, without the surrounding prose. */
  const query = source.slice(
    source.indexOf('query($owner:String!,$name:String!,$endCursor:String){\n    repository'),
    source.indexOf("--jq', '.data.repository.pullRequests.nodes[]'"),
  );

  it('never asks for fields the triage does not read', () => {
    // `gh pr list --json statusCheckRollup` expands to a fixed fragment that
    // also pulls the check suite's workflow run — a field nothing here reads,
    // and one the workflow token cannot see without `actions: read`. The whole
    // query then fails and every PR goes untriaged. Two live sweeps were lost
    // to that, each time by granting one more permission to satisfy a field we
    // did not want. Asserted against the query text, not the file, so the
    // explanation above does not trip it.
    expect(query.length).toBeGreaterThan(100);
    expect(query).not.toMatch(/checkSuite/);
    expect(query).not.toMatch(/workflowRun/);
    expect(source).not.toMatch(/--json'[^\n]*statusCheckRollup/);
  });

  it('asks every bounded connection whether there is another page', () => {
    // Without this the sweep cannot tell a short list from a truncated one,
    // and truncation reads as "nothing wrong" — the failure this whole
    // mechanism keeps producing.
    expect([...query.matchAll(/pageInfo\{hasNextPage\}/g)]).toHaveLength(3);
  });

  it('asks only for the check fields the triage reads', () => {
    expect(source).toMatch(/\.\.\. on CheckRun\{name status conclusion\}/);
    expect(source).toMatch(/\.\.\. on StatusContext\{context state\}/);
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

  it('has no two cron entries that fire at the same minute', () => {
    // `*/20` and `0 * * * *` both fire on the hour. GitHub starts two identical
    // sweeps; the concurrency group serialises rather than drops one, so the
    // second re-reads the same signature and counts a repeat — burning a
    // stand-down attempt without an attempt having happened.
    const crons = [...raw.matchAll(/cron: '([^']+)'/g)].map((m) => m[1]);
    expect(crons.length).toBeGreaterThan(1);
    const minutesOf = (c: string) => {
      const f = c.split(' ')[0];
      if (f === '*') return new Set(Array.from({ length: 60 }, (_, i) => i));
      if (f.startsWith('*/')) {
        const step = Number(f.slice(2));
        return new Set(Array.from({ length: Math.ceil(60 / step) }, (_, i) => i * step));
      }
      return new Set(f.split(',').map(Number));
    };
    const [a, b] = crons.map(minutesOf);
    expect([...a].filter((m) => b.has(m))).toEqual([]);
  });

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

  it('asks for no more permission than it uses, and no less', () => {
    // The sweep reads state and writes one comment. Pushing is the fixer's
    // job, under the fixer's own permissions.
    expect(raw).toMatch(/contents: read/);
    expect(raw).toMatch(/pull-requests: write/);
    expect(raw).not.toMatch(/contents: write/);
  });

  it('can read checks and statuses, which statusCheckRollup needs', () => {
    // Least privilege was one permission short. Without these, `gh pr list`
    // fails outright with "Resource not accessible by integration" — it does
    // not degrade to seeing no checks, it errors, so nothing gets triaged at
    // all. Found by running the sweep against a real repo rather than
    // assuming it worked.
    expect(raw).toMatch(/checks: read/);
    expect(raw).toMatch(/statuses: read/);
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
  const BOT = 'github-actions';

  it('reads back only its own comments', () => {
    expect(
      priorSignatures([
        { author: 'alizaouane', body: 'a human said something' },
        { author: BOT, body: `${AUTOPILOT_MARKER}\n<!-- signature:failing-check -->\nfix it` },
        { author: 'coderabbitai', body: 'walkthrough' },
      ]),
    ).toEqual(['failing-check']);
  });

  it('ignores a forged marker from someone else, which could silence it forever', () => {
    // Anyone who can comment could otherwise paste the marker until the
    // stand-down cap is reached and the autopilot never wakes on that PR
    // again — the one outcome the whole mechanism exists to prevent.
    const forged = Array.from({ length: 20 }, () => ({
      author: 'drive-by',
      body: `${AUTOPILOT_MARKER}\n<!-- signature:failing-check -->`,
    }));
    expect(priorSignatures(forged)).toEqual([]);
  });

  it('accepts the [bot]-suffixed spelling of its own login', () => {
    expect(
      priorSignatures([
        { author: 'github-actions[bot]', body: `${AUTOPILOT_MARKER}\n<!-- signature:x -->` },
      ]),
    ).toEqual(['x']);
  });

  it('ignores an autopilot comment with no signature rather than counting a blank', () => {
    expect(priorSignatures([{ author: BOT, body: `${AUTOPILOT_MARKER}\nno signature` }])).toEqual([]);
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
    expect(priorSignatures([{ author: 'github-actions[bot]', body }])).toEqual([triage.signature]);
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

  it('never contains the fixer mention, which would start the run it is ending', () => {
    // The trigger matches that substring ANYWHERE in a comment body, and the
    // fixer's author exclusion covers claude[bot], not the workflow identity.
    // A stand-down notice naming the mention would wake the fixer.
    const body = renderWedgedComment(triage, { wake: false, repeats: 4, reason: 'wedged' });
    expect(body).not.toContain('@claude');
  });
});

describe('consumer workflow wrappers', () => {
  const tplDir = resolve(__dirname, '../../examples/web-app-template/.github/workflows');

  it.each(['dev-agent-pr-review.yml', 'dev-agent-pr-autopilot.yml'])(
    '%s references a reusable workflow that exists in this repo',
    (file) => {
      // Catches a typo'd path. It does NOT prove the file exists on the `v1`
      // tag — `v1` is a moving tag re-pointed at main on release, and this
      // repo has previously shipped consumer wrappers pointing at a `v1` that
      // did not yet carry them, breaking every wired repo until someone
      // remembered to move it. Moving `v1` is a release step, not a PR step.
      const raw = readFileSync(resolve(tplDir, file), 'utf8');
      const refs = [...raw.matchAll(/uses: alizaouane\/dev-agent\/(\.github\/workflows\/[\w.-]+)@/g)];
      expect(refs.length).toBeGreaterThan(0);
      for (const [, path] of refs) {
        expect(existsSync(resolve(__dirname, '../..', path))).toBe(true);
      }
    },
  );

  it('authorizes the actor before the fixer spends a model call', () => {
    // Mentioning the fixer starts a run that edits and pushes a branch. Any
    // passer-by able to comment must not be able to trigger that.
    const raw = readFileSync(resolve(tplDir, 'dev-agent-pr-review.yml'), 'utf8');
    expect(raw).toMatch(/author_association/);
    expect(raw).toMatch(/OWNER","MEMBER","COLLABORATOR/);
  });
});

describe('ready-to-merge announcement', () => {
  const clean = {
    number: 42,
    headRefName: 'feat/dev-agent-issue-42',
    labels: [],
    headOid: 'abc1234def',
    isDraft: false,
    reviewDecision: 'APPROVED',
    checks: [{ name: 'test', conclusion: 'SUCCESS' }],
    reviews: [],
    unresolvedThreadCount: 0,
  };

  it('says the PR is ready and names it', () => {
    // The autopilot was built so the operator stops checking PRs by hand. One
    // that reports only problems still makes them check, so silence has to
    // mean "not finished" rather than "finished".
    const body = renderReadyComment(clean);
    expect(body).toContain('#42 is ready to merge');
    expect(body).toContain('abc1234d');
  });

  it('does not mention the fixer, which would wake it on a finished PR', () => {
    expect(renderReadyComment(clean)).not.toContain('@claude');
  });

  it('is recognised as its own announcement afterwards', () => {
    const body = renderReadyComment(clean);
    expect(alreadyAnnouncedReady([{ author: 'github-actions[bot]', body }])).toBe(true);
  });

  it('announces once, so a clean PR is not commented on every twenty minutes', () => {
    const body = renderReadyComment(clean);
    expect(alreadyAnnouncedReady([{ author: 'github-actions', body }])).toBe(true);
  });

  it('ignores a forged marker, which would suppress the real announcement', () => {
    // Same reasoning as the signature check: anyone can paste the marker, and
    // a forged one would turn the signal off exactly when it matters.
    expect(alreadyAnnouncedReady([{ author: 'drive-by', body: READY_MARKER }])).toBe(false);
  });

  it('treats an unannounced clean PR as needing the announcement', () => {
    expect(alreadyAnnouncedReady([{ author: 'github-actions', body: 'unrelated' }])).toBe(false);
  });
});

describe('isReadyToMerge', () => {
  /** Triage a PR with the given overrides. */
  const t = (over: Record<string, unknown> = {}) =>
    triage({
      number: 1,
      headRefName: 'feat/dev-agent-issue-1',
      labels: [],
      headOid: 'abc1234def',
      isDraft: false,
      reviewDecision: 'APPROVED',
      checks: [{ name: 'test', conclusion: 'SUCCESS' }],
      reviews: [],
      unresolvedThreadCount: 0,
      ...over,
    } as never);

  it('is true for an examined PR with passing checks and no blockers', () => {
    expect(isReadyToMerge(t(), 1)).toBe(true);
  });

  it('is false for a draft, however clean it looks', () => {
    // A draft is never examined, so its empty blocker list means "not looked
    // at". Announcing it ready would be announcing a PR with red CI as done.
    const d = t({ isDraft: true, checks: [{ name: 'test', conclusion: 'FAILURE' }] });
    expect(d.blockers).toEqual([]);
    expect(d.skipped).toBe(true);
    expect(isReadyToMerge(d, 1)).toBe(false);
  });

  it('is false for a PR the operator opted out of', () => {
    // Someone labelled it to take it out of the autopilot's hands. Commenting
    // and labelling it anyway is the opposite of honouring that.
    const off = t({ labels: ['autopilot:off'], checks: [{ name: 'x', conclusion: 'FAILURE' }] });
    expect(off.skipped).toBe(true);
    expect(isReadyToMerge(off, 1)).toBe(false);
  });

  it('is false when no check has reported at all', () => {
    // Zero checks produces no failing-check blocker either. "Every check
    // passed" over zero checks is false, and branch protection would hold the
    // merge regardless.
    expect(isReadyToMerge(t({ checks: [] }), 0)).toBe(false);
  });

  it('is false while a blocker remains', () => {
    expect(isReadyToMerge(t({ unresolvedThreadCount: 2 }), 1)).toBe(false);
  });

  it('is false while GitHub still requires a review', () => {
    expect(isReadyToMerge(t({ reviewDecision: 'REVIEW_REQUIRED' }), 1)).toBe(false);
  });

  it('is false when the PR was only partly read', () => {
    // A failing check on page two would otherwise be announced as ready.
    expect(isReadyToMerge(t({ truncated: true }), 1)).toBe(false);
  });
});

describe('pr-autopilot label reconciliation', () => {
  const source = readFileSync(resolve(__dirname, '../../lib/cli/pr-triage.ts'), 'utf8');

  it('reconciles the label every sweep, not only when announcing', () => {
    // Coupling the label to the one-time announcement left two holes: a failed
    // write was never retried, and a PR that picked up a blocker after being
    // announced kept a label that was no longer true.
    expect(source).toMatch(/ready !== labelled/);
    expect(source).toMatch(/setLabel\(repo, triage\.number, READY_LABEL, ready\)/);
  });

  it('can remove the label, not only add it', () => {
    expect(source).toMatch(/--remove-label/);
  });
});
