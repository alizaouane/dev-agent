import { describe, it, expect } from 'vitest';
import {
  readArgs,
  findExistingStateLabels,
  performUnstick,
  ValidationError,
} from '../../lib/cli/orch-unstick';
import { STATE_LABELS } from '../../lib/orchestrator';

function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    ISSUE: '42',
    ORG: 'alizaouane',
    REPO: 'dev-agent',
    TARGET_STATE: 'state:blocked',
    JUSTIFICATION: 'workflow timeout on phase-implement',
    ...overrides,
  };
}

describe('readArgs', () => {
  it('parses a complete env', () => {
    const args = readArgs(baseEnv());
    expect(args.issue).toBe('42');
    expect(args.targetState).toBe('state:blocked');
    expect(args.dryRun).toBe(false);
  });

  it('honors DRY_RUN=true', () => {
    expect(readArgs(baseEnv({ DRY_RUN: 'true' })).dryRun).toBe(true);
    expect(readArgs(baseEnv({ DRY_RUN: '1' })).dryRun).toBe(true);
    expect(readArgs(baseEnv({ DRY_RUN: 'false' })).dryRun).toBe(false);
  });

  it.each([
    [{ ISSUE: undefined as unknown as string }, /ISSUE required/],
    [{ ISSUE: 'abc' }, /digits/],
    [{ ORG: undefined as unknown as string }, /ORG required/],
    [{ ORG: 'bad org' }, /alphanumeric/],
    [{ REPO: undefined as unknown as string }, /REPO required/],
    [{ TARGET_STATE: undefined as unknown as string }, /TARGET_STATE required/],
    [{ TARGET_STATE: 'state:bogus' }, /must be one of/],
    [{ JUSTIFICATION: undefined as unknown as string }, /JUSTIFICATION required/],
    [{ JUSTIFICATION: 'too short' }, /JUSTIFICATION required/],
  ])('rejects %j with %s', (overrides, pattern) => {
    expect(() => readArgs(baseEnv(overrides as NodeJS.ProcessEnv))).toThrow(pattern as RegExp);
  });

  it('rejects with a ValidationError specifically (so the CLI can exit 1, not 2)', () => {
    try {
      readArgs(baseEnv({ ISSUE: 'not-a-number' }));
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      return;
    }
    throw new Error('expected throw');
  });

  it('accepts every canonical state label as TARGET_STATE', () => {
    for (const s of STATE_LABELS) {
      expect(() => readArgs(baseEnv({ TARGET_STATE: s }))).not.toThrow();
    }
  });
});

describe('findExistingStateLabels', () => {
  it('returns only the labels that are STATE_LABELS', () => {
    const found = findExistingStateLabels([
      'kind:bug-scout',
      'state:implementing',
      'state:bogus',
      'state:blocked',
    ]);
    expect(found).toEqual(['state:implementing', 'state:blocked']);
  });

  it('returns [] for label sets with no state:* entries', () => {
    expect(findExistingStateLabels(['kind:foo', 'priority:high'])).toEqual([]);
  });
});

describe('performUnstick', () => {
  function fakeGh(initialLabels: string[]) {
    const events: Array<{ kind: string; arg: string }> = [];
    return {
      events,
      view: () => ({ labels: [...initialLabels] }),
      removeLabel: (_args: unknown, label: string) => {
        events.push({ kind: 'remove', arg: label });
      },
      addLabel: (_args: unknown, label: string) => {
        events.push({ kind: 'add', arg: label });
      },
      comment: (_args: unknown, body: string) => {
        events.push({ kind: 'comment', arg: body });
      },
    };
  }

  it('removes other state:* labels and adds the target', () => {
    const args = readArgs(baseEnv());
    const gh = fakeGh(['kind:foo', 'state:implementing']);
    const r = performUnstick(args, gh);
    expect(r.removed).toEqual(['state:implementing']);
    expect(r.added).toBe('state:blocked');
    // Order: remove the existing state, add the target, post the comment.
    expect(gh.events.map((e) => e.kind)).toEqual(['remove', 'add', 'comment']);
    expect(gh.events[0].arg).toBe('state:implementing');
    expect(gh.events[1].arg).toBe('state:blocked');
  });

  it('skips add when the target is already present (idempotent)', () => {
    const args = readArgs(baseEnv());
    const gh = fakeGh(['state:blocked']);
    const r = performUnstick(args, gh);
    expect(r.removed).toEqual([]);
    expect(gh.events.map((e) => e.kind)).toEqual(['comment']);
  });

  it('removes multiple stale state labels (defensive against label corruption)', () => {
    const args = readArgs(baseEnv());
    const gh = fakeGh(['state:implementing', 'state:acm-building', 'state:swarm-reviewing']);
    const r = performUnstick(args, gh);
    expect(r.removed.sort()).toEqual(
      ['state:acm-building', 'state:implementing', 'state:swarm-reviewing'].sort(),
    );
  });

  it('records the justification in the audit comment', () => {
    const args = readArgs(baseEnv({ JUSTIFICATION: 'flaky on phase-implement run #1234' }));
    const gh = fakeGh([]);
    performUnstick(args, gh);
    const commentEvent = gh.events.find((e) => e.kind === 'comment')!;
    expect(commentEvent.arg).toContain('flaky on phase-implement run #1234');
    expect(commentEvent.arg).toContain('orch-unstick');
    expect(commentEvent.arg).toContain('state:blocked');
  });
});
