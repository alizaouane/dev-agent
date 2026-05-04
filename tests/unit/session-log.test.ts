import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPhaseEntry,
  buildApprovedScopeEntry,
  prependEntry,
} from '../../lib/session-log';

describe('buildPhaseEntry', () => {
  it('builds the minimum-viable entry with header + trigger + outcome + next-session', () => {
    const out = buildPhaseEntry({
      timestamp: new Date('2026-05-04T14:30:00Z'),
      phase: 'implement',
      issue: 42,
      outcome: 'success',
      next_session_hint: 'review PR #123 against the agreed scope.',
    });
    expect(out).toContain('## 2026-05-04 14:30 UTC — implement — issue #42\n');
    expect(out).toContain('**Trigger:** dev-agent implement phase');
    expect(out).toContain('**Outcome:** success');
    expect(out).toContain('**Next session should start with:** review PR #123');
    expect(out.endsWith('---\n')).toBe(true);
  });

  it('appends the outcome to the header for non-success outcomes', () => {
    const out = buildPhaseEntry({
      timestamp: new Date('2026-05-04T14:30:00Z'),
      phase: 'implement',
      issue: 42,
      outcome: 'blocked',
      next_session_hint: 'decide whether to relax the guardrail or split the feature.',
    });
    expect(out).toContain('## 2026-05-04 14:30 UTC — implement — issue #42 — BLOCKED');
  });

  it('renders tokens / files_changed / PR url when provided', () => {
    const out = buildPhaseEntry({
      timestamp: new Date('2026-05-04T14:30:00Z'),
      phase: 'implement',
      issue: 42,
      outcome: 'success',
      tokens: { input: 18452, output: 4203, cost_usd: 0.42 },
      files_changed: 7,
      pr_url: 'https://github.com/owner/repo/pull/123',
      next_session_hint: 'review the PR.',
    });
    expect(out).toContain('**Tokens:** in=18452, out=4203, cost=$0.42');
    expect(out).toContain('**Files changed:** 7');
    expect(out).toContain('**PR:** https://github.com/owner/repo/pull/123');
  });

  it('renders deferred bullets when provided', () => {
    const out = buildPhaseEntry({
      timestamp: new Date('2026-05-04T14:30:00Z'),
      phase: 'staging-deploy',
      issue: 50,
      outcome: 'success',
      deferred: ['Manual smoke on staging.', 'Promote to prod after sign-off.'],
      next_session_hint: 'smoke staging.',
    });
    expect(out).toContain('**Deferred / Next:**\n- Manual smoke on staging.\n- Promote to prod');
  });

  it('uses a custom trigger when provided', () => {
    const out = buildPhaseEntry({
      timestamp: new Date('2026-05-04T14:30:00Z'),
      phase: 'rollback',
      issue: 99,
      outcome: 'rolled_back',
      trigger: 'Manual rollback after staging smoke surfaced regression.',
      next_session_hint: 'investigate root cause before retry.',
    });
    expect(out).toContain('**Trigger:** Manual rollback after staging smoke');
  });
});

describe('buildApprovedScopeEntry', () => {
  it('records a one-line scope and the approver', () => {
    const out = buildApprovedScopeEntry({
      timestamp: new Date('2026-05-04T14:30:00Z'),
      issue: 200,
      approver: 'alizaouane',
      title: 'Add refund button',
      scope: 'Add a refund button to the booking-detail page.\nStripe API only, no partial refunds.',
    });
    expect(out).toContain('## 2026-05-04 14:30 UTC — user-approved scope — issue #200');
    expect(out).toContain('**Trigger:** @alizaouane clicked "Approve and start"');
    expect(out).toContain('**Title:** Add refund button');
    expect(out).toContain(
      '**Scope (one-line):** Add a refund button to the booking-detail page. Stripe API only, no partial refunds.',
    );
  });

  it('truncates very long scope text', () => {
    const long = 'word '.repeat(200);
    const out = buildApprovedScopeEntry({
      timestamp: new Date('2026-05-04T14:30:00Z'),
      issue: 1,
      approver: 'alizaouane',
      title: 't',
      scope: long,
    });
    const scopeLine = out.split('\n').find((l) => l.startsWith('**Scope (one-line):**'))!;
    expect(scopeLine.length).toBeLessThan(320);
    expect(scopeLine.endsWith('…')).toBe(true);
  });
});

describe('prependEntry', () => {
  let dir: string;
  let logpath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sessionlog-'));
    logpath = join(dir, 'SESSION_LOG.md');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('initializes the file with H1 + entry when missing', () => {
    const entry = '## 2026-05-04 14:30 UTC — implement — issue #1\n\n**Trigger:** test.\n\n---\n';
    const result = prependEntry(logpath, entry);
    expect(result.changed).toBe(true);
    expect(existsSync(logpath)).toBe(true);
    const contents = readFileSync(logpath, 'utf8');
    expect(contents).toMatch(/^# Session Log\n/);
    expect(contents).toContain('## 2026-05-04 14:30 UTC — implement — issue #1');
  });

  it('prepends new entries above older ones (newest-first)', () => {
    const oldEntry = '## 2026-05-03 10:00 UTC — implement — issue #1\n\n**Trigger:** old.\n\n---\n';
    writeFileSync(logpath, `# Session Log\n\n${oldEntry}`, 'utf8');

    const newEntry = '## 2026-05-04 14:30 UTC — implement — issue #2\n\n**Trigger:** new.\n\n---\n';
    const result = prependEntry(logpath, newEntry);

    expect(result.changed).toBe(true);
    const contents = readFileSync(logpath, 'utf8');
    const newIdx = contents.indexOf('issue #2');
    const oldIdx = contents.indexOf('issue #1');
    expect(newIdx).toBeLessThan(oldIdx);
    expect(newIdx).toBeGreaterThan(0); // newest-first, after the H1
  });

  it('is idempotent on retry: same first H2 line is a no-op', () => {
    const entry = '## 2026-05-04 14:30 UTC — implement — issue #5\n\n**Trigger:** test.\n\n---\n';
    prependEntry(logpath, entry);
    const beforeRetry = readFileSync(logpath, 'utf8');
    const result = prependEntry(logpath, entry);
    expect(result.changed).toBe(false);
    expect(readFileSync(logpath, 'utf8')).toBe(beforeRetry);
  });

  it('preserves the user-authored H1 and existing entries', () => {
    const initial = `# Session Log\n\nSome free-form intro paragraph.\n\n## 2026-05-03 ... — old entry\n\nbody\n\n---\n`;
    writeFileSync(logpath, initial, 'utf8');
    const entry = '## 2026-05-04 14:30 UTC — implement — issue #7\n\n**Trigger:** test.\n\n---\n';
    prependEntry(logpath, entry);
    const contents = readFileSync(logpath, 'utf8');
    expect(contents).toMatch(/^# Session Log\n/);
    expect(contents).toContain('## 2026-05-04 14:30 UTC — implement — issue #7');
    expect(contents).toContain('## 2026-05-03 ... — old entry');
  });

  it('handles a file without an H1 by injecting one', () => {
    writeFileSync(logpath, 'just some text without a heading\n', 'utf8');
    const entry = '## 2026-05-04 14:30 UTC — implement — issue #9\n\n**Trigger:** test.\n\n---\n';
    prependEntry(logpath, entry);
    const contents = readFileSync(logpath, 'utf8');
    expect(contents).toMatch(/^# Session Log\n/);
    expect(contents).toContain('## 2026-05-04 14:30 UTC — implement — issue #9');
    expect(contents).toContain('just some text without a heading');
  });
});
