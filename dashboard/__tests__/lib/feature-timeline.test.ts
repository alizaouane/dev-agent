import { describe, it, expect } from 'vitest';
import {
  aggregateTimeline,
  parseSessionLogEntriesFor,
  type IssueCommentRow,
  type IssueRow,
} from '@/lib/feature-timeline';

const ISSUE: IssueRow = {
  number: 42,
  title: 'Add refund button',
  body: '## Agreed scope\n\nAdd a refund button to the booking-detail page.',
  html_url: 'https://github.com/q/r/issues/42',
  created_at: '2026-05-04T10:00:00Z',
};

const TELEMETRY_COMMENT: IssueCommentRow = {
  id: 1,
  body:
    '🤖 Phase: implement\nModel: claude-sonnet-4-6\nMode: live\nStatus: success\nTokens: 18452 in / 4203 out\nCost: $0.42\nBranch: feat/dev-agent-issue-42\nPR: #100\n',
  user: { login: 'github-actions', type: 'Bot' },
  created_at: '2026-05-04T11:00:00Z',
  html_url: 'https://github.com/q/r/issues/42#issuecomment-1',
};

const HUMAN_COMMENT: IssueCommentRow = {
  id: 2,
  body: 'LGTM, kicking off staging soon.',
  user: { login: 'alizaouane', type: 'User' },
  created_at: '2026-05-04T12:00:00Z',
  html_url: 'https://github.com/q/r/issues/42#issuecomment-2',
};

const SESSION_LOG = [
  '# Session Log',
  '',
  '## 2026-05-04 13:00 UTC — staging-deploy — issue #42',
  '',
  '**Trigger:** PR merged to default branch — staging deploy + smoke verify run.',
  '',
  '**Outcome:** success',
  '',
  '**Next session should start with:** manual smoke on staging, then promote.',
  '',
  '---',
  '',
  '## 2026-05-03 — Release: staging (PR #99 → unrelated feature)',
  '',
  'unrelated entry',
  '',
  '---',
  '',
].join('\n');

describe('aggregateTimeline', () => {
  it('emits an intent event from the issue', () => {
    const events = aggregateTimeline({ issue: ISSUE, comments: [], sessionLog: null });
    const intent = events.find((e) => e.kind === 'intent');
    expect(intent).toBeDefined();
    expect(intent?.title).toBe('Intent captured');
    expect(intent?.timestamp).toBe('2026-05-04T10:00:00Z');
    expect(intent?.description).toContain('Add a refund button');
    expect(intent?.url).toBe('https://github.com/q/r/issues/42');
  });

  it('emits a phase event + a pr_link event from a telemetry comment with PR: #N', () => {
    const events = aggregateTimeline({
      issue: ISSUE,
      comments: [TELEMETRY_COMMENT],
      sessionLog: null,
    });
    const phase = events.find((e) => e.kind === 'phase');
    expect(phase).toBeDefined();
    expect(phase?.title).toBe('Implement phase ran');
    expect(phase?.description).toContain('claude-sonnet-4-6');
    expect(phase?.description).toContain('18452');
    expect(phase?.description).toContain('$0.4200');
    expect(phase?.meta?.phase).toBe('implement');

    const prLink = events.find((e) => e.kind === 'pr_link');
    expect(prLink).toBeDefined();
    expect(prLink?.title).toBe('PR #100 opened');
    expect(prLink?.meta?.pr_number).toBe(100);
  });

  it('appends suffix to phase title when status != success', () => {
    const blockedComment: IssueCommentRow = {
      ...TELEMETRY_COMMENT,
      body:
        '🤖 Phase: implement\nModel: claude-sonnet-4-6\nMode: live\nStatus: blocked\nTokens: 0 in / 0 out\nCost: $0\n',
    };
    const events = aggregateTimeline({
      issue: ISSUE,
      comments: [blockedComment],
      sessionLog: null,
    });
    const phase = events.find((e) => e.kind === 'phase');
    expect(phase?.title).toBe('Implement phase ran — blocked');
  });

  it('emits a comment event for human comments and skips other bots', () => {
    const otherBotComment: IssueCommentRow = {
      id: 3,
      body: 'some random bot ping',
      user: { login: 'dependabot[bot]', type: 'Bot' },
      created_at: '2026-05-04T11:30:00Z',
    };
    const events = aggregateTimeline({
      issue: ISSUE,
      comments: [otherBotComment, HUMAN_COMMENT],
      sessionLog: null,
    });
    const comments = events.filter((e) => e.kind === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].title).toBe('@alizaouane commented');
    expect(comments[0].description).toBe('LGTM, kicking off staging soon.');
  });

  it('only includes session-log entries that reference this issue', () => {
    const events = aggregateTimeline({
      issue: ISSUE,
      comments: [],
      sessionLog: SESSION_LOG,
    });
    const sessionEvents = events.filter((e) => e.kind === 'session_log');
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0].title).toContain('issue #42');
    expect(sessionEvents[0].description).toContain('Trigger: PR merged');
    expect(sessionEvents[0].description).toContain('Next: manual smoke');
    expect(sessionEvents[0].meta?.outcome).toBe('success');
  });

  it('orders events newest-first across all sources', () => {
    const events = aggregateTimeline({
      issue: ISSUE,
      comments: [TELEMETRY_COMMENT, HUMAN_COMMENT],
      sessionLog: SESSION_LOG,
    });
    // Expected order (newest first):
    //   - session_log (2026-05-04 13:00 UTC)
    //   - human comment (12:00 UTC)
    //   - phase + pr_link (11:00 UTC, same timestamp)
    //   - intent (10:00 UTC)
    const ts = events.map((e) => e.timestamp);
    for (let i = 0; i < ts.length - 1; i++) {
      expect(ts[i] >= ts[i + 1]).toBe(true);
    }
  });
});

describe('parseSessionLogEntriesFor', () => {
  it('returns empty array when log has no entries for the issue', () => {
    const log = [
      '# Session Log',
      '',
      '## 2026-05-03 — Release: staging (PR #99 → some other feature)',
      '',
      'body',
      '',
      '---',
      '',
    ].join('\n');
    expect(parseSessionLogEntriesFor(log, 42)).toEqual([]);
  });

  it('matches both lower- and upper-case "issue #N"', () => {
    const log = [
      '# Session Log',
      '',
      '## 2026-05-04 14:30 UTC — implement — Issue #42',
      '',
      '**Trigger:** test',
      '',
      '---',
      '',
    ].join('\n');
    expect(parseSessionLogEntriesFor(log, 42)).toHaveLength(1);
  });

  it('parses the date-only header variant', () => {
    const log = [
      '# Session Log',
      '',
      '## 2026-05-04 — manual entry mentioning issue #42',
      '',
      '**Trigger:** the user',
      '',
      '---',
      '',
    ].join('\n');
    const out = parseSessionLogEntriesFor(log, 42);
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe('2026-05-04T00:00:00Z');
  });
});
