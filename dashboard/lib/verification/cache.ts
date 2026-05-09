import 'server-only';
import { createHash } from 'node:crypto';

const TTL_MS = 30 * 60 * 1000;

type Entry = { value: unknown; expires_at: number };
const store = new Map<string, Entry>();

export function hashInputs(repos: string[], windowDays: number): string {
  const sorted = [...repos].sort().join(',');
  return createHash('sha256').update(`${sorted}|${windowDays}`).digest('hex');
}

export function getCached<T>(key: string): T | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expires_at) {
    store.delete(key);
    return undefined;
  }
  return e.value as T;
}

export function setCached<T>(key: string, value: T): void {
  store.set(key, { value, expires_at: Date.now() + TTL_MS });
}

export function clearCache(): void {
  store.clear();
}
