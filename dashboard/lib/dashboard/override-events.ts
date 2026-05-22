// dashboard/lib/dashboard/override-events.ts
import 'server-only';
import type { Octokit } from '@octokit/rest';
import { createHash } from 'node:crypto';
import { extractAnchors, decodeAnchor, summarizeOverride } from '../../../lib/events-scrape';

export interface OverrideEvent {
  ts: string;
  pr_number: number;
  actor: string;
  reason: string;
  source_comment_url: string;
}

interface CacheEntry {
  value: OverrideEvent[];
  expires_at: number;
}

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 256;
const cache = new Map<string, CacheEntry>();

function cacheKey(owner: string, name: string, limit: number, windowDays: number): string {
  return createHash('sha256').update(`${owner}/${name}|${limit}|${windowDays}`).digest('hex');
}

function getCached(key: string, now = Date.now()): OverrideEvent[] | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (now >= e.expires_at) { cache.delete(key); return undefined; }
  return e.value;
}

function setCached(key: string, value: OverrideEvent[], now = Date.now()): void {
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires_at: now + TTL_MS });
}

export function __resetCacheForTests(): void { cache.clear(); }

export interface LoadOpts {
  limit?: number;        // default 10
  windowDays?: number;   // default 90
}

export async function loadOverrideEvents(
  octokit: Octokit,
  repo: { owner: string; name: string },
  opts: LoadOpts = {},
): Promise<OverrideEvent[]> {
  const limit = opts.limit ?? 10;
  const windowDays = opts.windowDays ?? 90;
  const key = cacheKey(repo.owner, repo.name, limit, windowDays);
  const cached = getCached(key);
  if (cached) return cached;

  let events: OverrideEvent[] = [];
  try {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const prs = await octokit.paginate(octokit.pulls.list, {
      owner: repo.owner,
      repo: repo.name,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });
    const recent = (prs as { number: number; updated_at: string }[]).filter((p) => p.updated_at >= since);

    for (const pr of recent) {
      const comments = await octokit.paginate(octokit.issues.listComments, {
        owner: repo.owner,
        repo: repo.name,
        issue_number: pr.number,
        per_page: 100,
      });
      for (const c of comments as { body?: string; html_url: string }[]) {
        for (const b64 of extractAnchors(c.body ?? '')) {
          const decoded = decodeAnchor(b64);
          if (!decoded) continue;
          const sum = summarizeOverride(decoded);
          if (!sum) continue;
          events.push({
            ts: sum.ts,
            pr_number: pr.number,
            actor: sum.actor,
            reason: sum.reason,
            source_comment_url: c.html_url,
          });
        }
      }
    }
    events.sort((a, b) => b.ts.localeCompare(a.ts));
    events = events.slice(0, limit);
  } catch {
    // Failures (rate limit, 404, network) yield an empty list — the UI
    // shows the empty state, which is the right read of "we don't have
    // data right now" without making the operator chase a 500 page.
    events = [];
  }

  setCached(key, events);
  return events;
}
