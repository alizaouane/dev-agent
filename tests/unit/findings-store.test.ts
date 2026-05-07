import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InMemoryStorage,
  JsonlFileStorage,
  findingId,
  recordFinding,
  recordOutcome,
  shouldSuppress,
  currentOutcomes,
  type FindingRecord,
} from '../../lib/findings-store';

let tempDir: string;
const fixedNow = (): Date => new Date('2026-05-07T00:00:00Z');

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findings-store-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('findingId', () => {
  it('produces the same id for the same (rule, file, message-prefix)', () => {
    const a = findingId('unvalidated-input', 'src/api/route.ts', 'req.body reaches sql without validation');
    const b = findingId('unvalidated-input', 'src/api/route.ts', 'req.body reaches sql without validation');
    expect(a).toBe(b);
  });

  it('normalizes whitespace + case for stable matching', () => {
    const a = findingId('Unvalidated-Input', 'src/api/route.ts', 'req.body reaches sql without validation');
    const b = findingId('  unvalidated-input  ', 'src/api/route.ts', 'req.body  reaches    sql  without validation');
    expect(a).toBe(b);
  });

  it('uses only the first 60 chars of the message for the key', () => {
    const a = findingId('r', 'f.ts', 'A'.repeat(60) + ' tail-A');
    const b = findingId('r', 'f.ts', 'A'.repeat(60) + ' tail-B');
    expect(a).toBe(b);
  });

  it('produces different ids for different rules / files / messages', () => {
    const a = findingId('rule-a', 'f.ts', 'msg');
    const b = findingId('rule-b', 'f.ts', 'msg');
    const c = findingId('rule-a', 'g.ts', 'msg');
    const d = findingId('rule-a', 'f.ts', 'different msg here');
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('returns ids prefixed with `f` and 8 hex chars', () => {
    const id = findingId('r', 'f', 'm');
    expect(id).toMatch(/^f[0-9a-f]{8}$/);
  });
});

describe('recordFinding', () => {
  it('appends a record with outcome=open and ts from the clock', () => {
    const store = new InMemoryStorage();
    const r = recordFinding(
      { rule: 'r', file: 'f.ts', message: 'msg', severity: 'high', reviewer: 'spec-compliance', pr_number: 42 },
      store,
      fixedNow,
    );
    expect(r.outcome).toBe('open');
    expect(r.ts).toBe('2026-05-07T00:00:00.000Z');
    expect(store.readAll()).toHaveLength(1);
  });

  it('captures both message and message_key (60-char prefix)', () => {
    const store = new InMemoryStorage();
    const longMsg = 'A'.repeat(80);
    const r = recordFinding(
      { rule: 'r', file: 'f', message: longMsg, severity: 'low', reviewer: 'rg', pr_number: 1 },
      store,
      fixedNow,
    );
    expect(r.message).toBe(longMsg);
    expect(r.message_key.length).toBe(60);
  });
});

describe('shouldSuppress', () => {
  it('does not suppress when there are zero prior dismissals', () => {
    const store = new InMemoryStorage();
    const d = shouldSuppress({ rule: 'r', file: 'f', message: 'm' }, store);
    expect(d.suppress).toBe(false);
    expect(d.prior_dismissals).toBe(0);
    expect(d.prior_total).toBe(0);
  });

  it('does not suppress with 2 dismissals (threshold 3)', () => {
    const store = new InMemoryStorage();
    const id = findingId('r', 'f', 'm');
    for (let i = 0; i < 2; i++) {
      const r = recordFinding({ rule: 'r', file: 'f', message: 'm', severity: 'low', reviewer: 'sc', pr_number: i }, store, fixedNow);
      recordOutcome(r.id, 'dismissed', { reviewer: 'sc', pr_number: i }, store, fixedNow);
    }
    const d = shouldSuppress({ rule: 'r', file: 'f', message: 'm' }, store);
    expect(d.suppress).toBe(false);
    expect(d.matched_id).toBe(id);
  });

  it('suppresses with 3 dismissals (default threshold)', () => {
    const store = new InMemoryStorage();
    for (let i = 0; i < 3; i++) {
      const r = recordFinding({ rule: 'r', file: 'f', message: 'm', severity: 'low', reviewer: 'sc', pr_number: i }, store, fixedNow);
      recordOutcome(r.id, 'dismissed', { reviewer: 'sc', pr_number: i }, store, fixedNow);
    }
    const d = shouldSuppress({ rule: 'r', file: 'f', message: 'm' }, store);
    expect(d.suppress).toBe(true);
    expect(d.prior_dismissals).toBe(3);
  });

  it('counts false-positive outcomes as dismissive', () => {
    const store = new InMemoryStorage();
    for (let i = 0; i < 3; i++) {
      const r = recordFinding({ rule: 'r', file: 'f', message: 'm', severity: 'low', reviewer: 'sc', pr_number: i }, store, fixedNow);
      recordOutcome(r.id, 'false-positive', { reviewer: 'sc', pr_number: i }, store, fixedNow);
    }
    expect(shouldSuppress({ rule: 'r', file: 'f', message: 'm' }, store).suppress).toBe(true);
  });

  it('does NOT count merged-with-fix outcomes as dismissive (positive signal)', () => {
    const store = new InMemoryStorage();
    for (let i = 0; i < 5; i++) {
      const r = recordFinding({ rule: 'r', file: 'f', message: 'm', severity: 'low', reviewer: 'sc', pr_number: i }, store, fixedNow);
      recordOutcome(r.id, 'merged-with-fix', { reviewer: 'sc', pr_number: i }, store, fixedNow);
    }
    expect(shouldSuppress({ rule: 'r', file: 'f', message: 'm' }, store).suppress).toBe(false);
  });

  it('honors a custom dismissalCount threshold', () => {
    const store = new InMemoryStorage();
    for (let i = 0; i < 2; i++) {
      const r = recordFinding({ rule: 'r', file: 'f', message: 'm', severity: 'low', reviewer: 'sc', pr_number: i }, store, fixedNow);
      recordOutcome(r.id, 'dismissed', { reviewer: 'sc', pr_number: i }, store, fixedNow);
    }
    expect(shouldSuppress({ rule: 'r', file: 'f', message: 'm' }, store, { dismissalCount: 2 }).suppress).toBe(true);
    expect(shouldSuppress({ rule: 'r', file: 'f', message: 'm' }, store, { dismissalCount: 5 }).suppress).toBe(false);
  });
});

describe('recordOutcome', () => {
  it('throws when the finding id does not exist', () => {
    const store = new InMemoryStorage();
    expect(() => recordOutcome('fdeadbeef', 'dismissed', { reviewer: 'sc', pr_number: 1 }, store)).toThrow(/no prior record/);
  });

  it('preserves append-only by writing a new record with updated outcome', () => {
    const store = new InMemoryStorage();
    const r = recordFinding({ rule: 'r', file: 'f', message: 'm', severity: 'low', reviewer: 'sc', pr_number: 1 }, store, fixedNow);
    expect(store.readAll()).toHaveLength(1);
    recordOutcome(r.id, 'dismissed', { reviewer: 'sc', pr_number: 1 }, store, fixedNow);
    expect(store.readAll()).toHaveLength(2);
    expect(store.readAll()[1].outcome).toBe('dismissed');
    expect(store.readAll()[1].outcome_ts).toBeTruthy();
  });
});

describe('currentOutcomes', () => {
  it('returns the latest record per id (append-only projection)', () => {
    const store = new InMemoryStorage();
    const r = recordFinding({ rule: 'r', file: 'f', message: 'm', severity: 'low', reviewer: 'sc', pr_number: 1 }, store, fixedNow);
    recordOutcome(r.id, 'dismissed', { reviewer: 'sc', pr_number: 1 }, store, fixedNow);
    recordOutcome(r.id, 'merged-with-fix', { reviewer: 'sc', pr_number: 2 }, store, fixedNow);
    const map = currentOutcomes(store);
    expect(map.size).toBe(1);
    expect(map.get(r.id)!.outcome).toBe('merged-with-fix');
    expect(map.get(r.id)!.pr_number).toBe(2);
  });
});

describe('JsonlFileStorage', () => {
  it('round-trips records via the filesystem', () => {
    const file = path.join(tempDir, 'findings.jsonl');
    const store = new JsonlFileStorage(file);
    expect(store.readAll()).toEqual([]);
    const r = recordFinding({ rule: 'r', file: 'f', message: 'm', severity: 'low', reviewer: 'sc', pr_number: 1 }, store, fixedNow);
    const reread = new JsonlFileStorage(file).readAll();
    expect(reread).toHaveLength(1);
    expect(reread[0].id).toBe(r.id);
  });

  it('skips malformed lines silently', () => {
    const file = path.join(tempDir, 'findings.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"id":"f1","rule":"r","file":"f","message":"m","message_key":"m","severity":"low","reviewer":"sc","pr_number":1,"ts":"2026-01-01T00:00:00Z","outcome":"open"}\nnot-json\n{"id":"f2","rule":"r","file":"g","message":"m","message_key":"m","severity":"low","reviewer":"sc","pr_number":1,"ts":"2026-01-01T00:00:00Z","outcome":"open"}\n');
    const store = new JsonlFileStorage(file);
    expect(store.readAll()).toHaveLength(2);
  });

  it('appends without overwriting existing records', () => {
    const file = path.join(tempDir, 'findings.jsonl');
    const store = new JsonlFileStorage(file);
    recordFinding({ rule: 'r', file: 'f1', message: 'm', severity: 'low', reviewer: 'sc', pr_number: 1 }, store, fixedNow);
    recordFinding({ rule: 'r', file: 'f2', message: 'm', severity: 'low', reviewer: 'sc', pr_number: 1 }, store, fixedNow);
    const reread = new JsonlFileStorage(file).readAll();
    expect(reread.map((r: FindingRecord) => r.file).sort()).toEqual(['f1', 'f2']);
  });
});
