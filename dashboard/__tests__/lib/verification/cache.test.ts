import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hashInputs, getCached, setCached, clearCache } from '@/lib/verification/cache';

describe('verification cache', () => {
  beforeEach(() => {
    clearCache();
    vi.useRealTimers();
  });

  it('hashInputs is stable for equal inputs and different for different inputs', () => {
    const a = hashInputs(['x/y', 'a/b'], 7);
    const b = hashInputs(['a/b', 'x/y'], 7); // order should not matter
    const c = hashInputs(['x/y'], 7);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('returns undefined on miss, value on hit', () => {
    const k = hashInputs(['x/y'], 7);
    expect(getCached(k)).toBeUndefined();
    setCached(k, { window_days: 7 } as never);
    expect(getCached(k)).toEqual({ window_days: 7 });
  });

  it('expires after 30 minutes', () => {
    vi.useFakeTimers();
    const start = new Date('2026-05-09T10:00:00Z');
    vi.setSystemTime(start);
    const k = hashInputs(['x/y'], 7);
    setCached(k, { window_days: 7 } as never);
    vi.setSystemTime(new Date(start.getTime() + 29 * 60 * 1000));
    expect(getCached(k)).toBeDefined();
    vi.setSystemTime(new Date(start.getTime() + 31 * 60 * 1000));
    expect(getCached(k)).toBeUndefined();
  });

  it('expires at exactly 30 minutes (boundary case)', () => {
    const start = 1_000_000;
    const k = hashInputs(['x/y'], 7);
    setCached(k, { window_days: 7 } as never, start);
    expect(getCached(k, start + 30 * 60 * 1000 - 1)).toBeDefined();
    expect(getCached(k, start + 30 * 60 * 1000)).toBeUndefined();
  });

  it('evicts oldest entry when MAX_ENTRIES exceeded', () => {
    // The MAX_ENTRIES const is 256; this test depends on it. If the cap
    // changes, update this number too.
    const cap = 256;
    for (let i = 0; i < cap; i++) {
      setCached(`key-${i}`, i);
    }
    expect(getCached('key-0')).toBe(0); // still present
    setCached('overflow', 'X');
    expect(getCached('key-0')).toBeUndefined(); // oldest evicted
    expect(getCached('overflow')).toBe('X');    // newest present
    expect(getCached('key-1')).toBe(1);         // second-oldest still present
  });
});
