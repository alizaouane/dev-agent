import 'server-only';
import { createHash } from 'node:crypto';

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 256;

type Entry = { value: unknown; expires_at: number };
const store = new Map<string, Entry>();

export function hashInputs(repos: string[], windowDays: number): string {
  const sorted = [...repos].sort().join(',');
  return createHash('sha256').update(`${sorted}|${windowDays}`).digest('hex');
}

export function getCached<T>(key: string, now: number = Date.now()): T | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (now >= e.expires_at) {
    store.delete(key);
    return undefined;
  }
  return e.value as T;
}

export function setCached<T>(key: string, value: T, now: number = Date.now()): void {
  // FIFO eviction when at capacity. Map preserves insertion order, so the
  // first key in keys() is the oldest. We delete BEFORE inserting so the
  // new key lands at the end of the insertion order.
  if (!store.has(key) && store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expires_at: now + TTL_MS });
}

export function clearCache(): void {
  store.clear();
}
