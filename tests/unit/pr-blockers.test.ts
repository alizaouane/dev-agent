import { describe, it, expect } from 'vitest';
import {
  isDevAgentBranch,
  selectActionable,
  staleBotReviews,
  triagePullRequest,
  type PullRequestState,
} from '../../lib/pr-blockers';

const HEAD = 'abc1234def5678';

/** A clean, mergeable dev-agent PR, overridable field by field. */
function pr(over: Partial<PullRequestState> = {}): PullRequestState {
  return {
    number: 1,
    headRefName: 'feat/dev-agent-issue-42',
    labels: [],
    headOid: HEAD,
    isDraft: false,
    reviewDecision: 'APPROVED',
    checks: [{ name: 'test', conclusion: 'SUCCESS' }],
    reviews: [{ author: 'coderabbitai', state: 'COMMENTED', commitOid: HEAD, isBot: true }],
    unresolvedThreadCount: 0,
    ...over,
  };
}

describe('isDevAgentBranch', () => {
  it('accepts the implement branch shape', () => {
    expect(isDevAgentBranch('feat/dev-agent-issue-42')).toBe(true);
  });

  it('accepts the spec doc branch shape, which the old filter rejected', () => {
    // phase-pr-review's regex only matched feat/dev-agent-issue-*, so a doc PR
    // got no automation at all — the gap this triage exists to close.
    expect(isDevAgentBranch('dev-agent/spec-onboarding-wizard')).toBe(true);
  });

  it("refuses branches a human might be working on", () => {
    for (const b of ['main', 'feat/my-own-thing', 'dev-agent/spec-a/b', 'feat/dev-agent-issue-']) {
      expect(isDevAgentBranch(b)).toBe(false);
    }
  });
});

describe('staleBotReviews', () => {
  it('flags a bot whose review sits on an older commit', () => {
    const p = pr({
      reviews: [{ author: 'coderabbitai', state: 'COMMENTED', commitOid: 'older111', isBot: true }],
    });
    expect(staleBotReviews(p)).toEqual(['coderabbitai']);
  });

  it('clears a bot once its newest review lands on HEAD', () => {
    const p = pr({
      reviews: [
        { author: 'coderabbitai', state: 'COMMENTED', commitOid: 'older111', isBot: true },
        { author: 'coderabbitai', state: 'COMMENTED', commitOid: HEAD, isBot: true },
      ],
    });
    expect(staleBotReviews(p)).toEqual([]);
  });

  it('ignores humans, who are not expected to re-review every push', () => {
    const p = pr({
      reviews: [{ author: 'alizaouane', state: 'APPROVED', commitOid: 'older111', isBot: false }],
    });
    expect(staleBotReviews(p)).toEqual([]);
  });

  it('reports several stale bots in a stable order', () => {
    const p = pr({
      reviews: [
        { author: 'coderabbitai', state: 'COMMENTED', commitOid: 'old', isBot: true },
        { author: 'chatgpt-codex-connector', state: 'COMMENTED', commitOid: 'old', isBot: true },
      ],
    });
    expect(staleBotReviews(p)).toEqual(['chatgpt-codex-connector', 'coderabbitai']);
  });
});

describe('triagePullRequest', () => {
  it('reports nothing on a clean PR', () => {
    const t = triagePullRequest(pr());
    expect(t.blockers).toEqual([]);
    expect(t.needsWork).toBe(false);
    expect(t.waitingOnly).toBe(false);
  });

  it('flags a failing check and names it', () => {
    const t = triagePullRequest(pr({ checks: [{ name: 'test', conclusion: 'FAILURE' }] }));
    expect(t.needsWork).toBe(true);
    expect(t.blockers[0].kind).toBe('failing-check');
    expect(t.blockers[0].detail).toContain('test');
  });

  it.each(['ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])(
    'treats %s as a failure, not as a pass',
    (conclusion) => {
      const t = triagePullRequest(pr({ checks: [{ name: 'x', conclusion }] }));
      expect(t.needsWork).toBe(true);
    },
  );

  it('waits on a running check instead of spending a model call on it', () => {
    const t = triagePullRequest(pr({ checks: [{ name: 'test', conclusion: null }] }));
    expect(t.blockers.map((b) => b.kind)).toEqual(['running-check']);
    expect(t.needsWork).toBe(false);
    expect(t.waitingOnly).toBe(true);
  });

  it('still needs work when a check is running alongside a real blocker', () => {
    const t = triagePullRequest(
      pr({ checks: [{ name: 'test', conclusion: null }], unresolvedThreadCount: 2 }),
    );
    expect(t.needsWork).toBe(true);
    expect(t.waitingOnly).toBe(false);
  });

  it('flags unresolved threads', () => {
    const t = triagePullRequest(pr({ unresolvedThreadCount: 3 }));
    expect(t.blockers[0].detail).toContain('3 unresolved');
    expect(t.needsWork).toBe(true);
  });

  it('flags a stale bot review, the blocker every push creates', () => {
    const t = triagePullRequest(
      pr({ reviews: [{ author: 'coderabbitai', state: 'COMMENTED', commitOid: 'old', isBot: true }] }),
    );
    expect(t.blockers.map((b) => b.kind)).toContain('stale-bot-review');
  });

  it('flags a required-but-missing approval, which nothing else catches', () => {
    // GitHub sets REVIEW_REQUIRED only when branch protection demands a review
    // and none exists. Such a PR has no other blocker, so without this it
    // reads as clean while GitHub still refuses the merge.
    const t = triagePullRequest(pr({ reviewDecision: 'REVIEW_REQUIRED' }));
    expect(t.blockers.map((b) => b.kind)).toEqual(['awaiting-approval']);
  });

  it('does not wake the fixer for a missing approval, which it cannot give', () => {
    // Passive, like a running check: waking the agent here spends a model call
    // to learn it cannot approve its own pull request.
    const t = triagePullRequest(pr({ reviewDecision: 'REVIEW_REQUIRED' }));
    expect(t.needsWork).toBe(false);
    expect(t.waitingOnly).toBe(true);
  });

  it('treats a null reviewDecision as no review required', () => {
    // Repos without required reviews report null; blocking on that would stall
    // every PR in them forever.
    expect(triagePullRequest(pr({ reviewDecision: null })).blockers).toEqual([]);
  });

  it('flags CHANGES_REQUESTED even when every check passed', () => {
    const t = triagePullRequest(pr({ reviewDecision: 'CHANGES_REQUESTED' }));
    expect(t.blockers.map((b) => b.kind)).toEqual(['changes-requested']);
  });

  it('leaves a PR labelled autopilot:off alone, however red it is', () => {
    // The wake comment tells the operator to use this label. A label that is
    // documented but not read is worse than none: they think they stopped it.
    const t = triagePullRequest(
      pr({
        labels: ['autopilot:off'],
        checks: [{ name: 'test', conclusion: 'FAILURE' }],
        unresolvedThreadCount: 5,
      }),
    );
    expect(t.blockers).toEqual([]);
    expect(t.needsWork).toBe(false);
  });

  it('is not confused by an unrelated label', () => {
    const t = triagePullRequest(
      pr({ labels: ['kind:feature'], checks: [{ name: 'test', conclusion: 'FAILURE' }] }),
    );
    expect(t.needsWork).toBe(true);
  });

  it('leaves a draft alone', () => {
    const t = triagePullRequest(
      pr({ isDraft: true, checks: [{ name: 'test', conclusion: 'FAILURE' }], unresolvedThreadCount: 5 }),
    );
    expect(t.blockers).toEqual([]);
    expect(t.needsWork).toBe(false);
  });

  it('gives the same blocker set the same signature regardless of order', () => {
    const a = triagePullRequest(
      pr({ checks: [{ name: 'test', conclusion: 'FAILURE' }], unresolvedThreadCount: 1 }),
    );
    const b = triagePullRequest(
      pr({ checks: [{ name: 'other', conclusion: 'ERROR' }], unresolvedThreadCount: 9 }),
    );
    expect(a.signature).toBe(b.signature);
  });
});

describe('selectActionable', () => {
  it('picks only dev-agent branches that need an agent', () => {
    const out = selectActionable([
      pr({ number: 1, checks: [{ name: 'test', conclusion: 'FAILURE' }] }),
      pr({ number: 2 }),
      pr({ number: 3, headRefName: 'feat/human-work', checks: [{ name: 't', conclusion: 'FAILURE' }] }),
      pr({
        number: 4,
        headRefName: 'dev-agent/spec-thing',
        unresolvedThreadCount: 1,
        reviews: [],
      }),
      pr({ number: 5, checks: [{ name: 'test', conclusion: null }] }),
    ]);
    expect(out.map((t) => t.number)).toEqual([1, 4]);
  });

  it('returns nothing when every PR is clean', () => {
    expect(selectActionable([pr({ number: 1 }), pr({ number: 2 })])).toEqual([]);
  });
});
