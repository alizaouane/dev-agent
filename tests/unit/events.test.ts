import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { emit, readEvents } from '../../lib/events';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-agent-events-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('events', () => {
  it('appends events to a per-issue JSONL file', () => {
    emit({ run_id: 'r1', issue: 42, phase: 'phase-acm', event: 'phase.started', payload: {} }, { dir });
    emit({ run_id: 'r1', issue: 42, phase: 'phase-acm', event: 'phase.completed', payload: { ok: true } }, { dir });
    const events = readEvents(42, { dir });
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('phase.started');
    expect(events[1].event).toBe('phase.completed');
    expect(events[1].payload).toEqual({ ok: true });
  });

  it('routes null-issue events to a global file', () => {
    emit({ run_id: 'r1', issue: null, phase: 'cost-watchdog', event: 'cost.report', payload: { spent: 12.34 } }, { dir });
    const issueEvents = readEvents(42, { dir });
    expect(issueEvents).toEqual([]);
    const globalEvents = readEvents(null, { dir });
    expect(globalEvents).toHaveLength(1);
    expect(globalEvents[0].phase).toBe('cost-watchdog');
  });

  it('stamps ISO timestamps and respects an injected clock', () => {
    const fixed = new Date('2026-05-06T12:34:56.000Z');
    const e = emit({ run_id: 'r1', issue: 1, phase: 'test', event: 'ev', payload: {} }, { dir, now: () => fixed });
    expect(e.ts).toBe('2026-05-06T12:34:56.000Z');
  });

  it('skips malformed lines instead of failing the read', () => {
    emit({ run_id: 'r1', issue: 7, phase: 'p', event: 'ok-1', payload: {} }, { dir });
    fs.appendFileSync(path.join(dir, '7.jsonl'), 'not-json\n');
    emit({ run_id: 'r1', issue: 7, phase: 'p', event: 'ok-2', payload: {} }, { dir });
    const events = readEvents(7, { dir });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.event)).toEqual(['ok-1', 'ok-2']);
  });

  it('returns [] for an issue with no events', () => {
    expect(readEvents(999, { dir })).toEqual([]);
  });

  it('preserves append order under rapid emits', () => {
    for (let i = 0; i < 50; i++) {
      emit({ run_id: 'r1', issue: 1, phase: 'p', event: `ev-${i}`, payload: { i } }, { dir });
    }
    const events = readEvents(1, { dir });
    expect(events).toHaveLength(50);
    for (let i = 0; i < 50; i++) expect(events[i].event).toBe(`ev-${i}`);
  });
});
