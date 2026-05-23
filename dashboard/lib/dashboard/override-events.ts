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

const SUCCESS_TTL_MS = 30 * 60 * 1000;
// Errors cache too — without this, a transient outage would hammer the
// GitHub API on every page load. But we use a shorter TTL than success
// so a retry within the half-hour window can actually succeed once the
// outage clears.
const ERROR_TTL_MS = 60 * 1000;
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

function setCached(key: string, value: OverrideEvent[], ttlMs: number, now = Date.now()): void {
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires_at: now + ttlMs });
}

export function __resetCacheForTests(): void { cache.clear(); }

export interface LoadOpts {
  limit?: number;        // default 10
  windowDays?: number;   // default 30 (was 90 in v1 — operators can pass
                         // larger via the CLI; the dashboard surface is
                         // "recent overrides", so 30 days is the right
                         // default and saves API volume on large repos.)
}

export async function loadOverrideEvents(
  octokit: Octokit,
  repo: { owner: string; name: string },
  opts: LoadOpts = {},
): Promise<OverrideEvent[]> {
  const limit = opts.limit ?? 10;
  const windowDays = opts.windowDays ?? 30;
  const key = cacheKey(repo.owner, repo.name, limit, windowDays);
  const cached = getCached(key);
  if (cached) return cached;

  let events: OverrideEvent[] = [];
  let hadError = false;
  try {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    // Use paginate.iterator + sort:updated/direction:desc so we can stop
    // fetching PR pages as soon as we cross the lookback boundary. The full
    // `paginate(...)` API would walk every page before our filter runs.
    const recent: Array<{ number: number; updated_at: string }> = [];
    for await (const page of octokit.paginate.iterator(octokit.pulls.list, {
      owner: repo.owner,
      repo: repo.name,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    })) {
      let stop = false;
      for (const pr of page.data as Array<{ number: number; updated_at: string }>) {
        if (pr.updated_at < since) { stop = true; break; }
        recent.push(pr);
      }
      if (stop) break;
    }

    for (const pr of recent) {
      const comments = await octokit.paginate(octokit.issues.listComments, {
        owner: repo.owner,
        repo: repo.name,
        issue_number: pr.number,
        per_page: 100,
      });
      // Only treat comments authored by `github-actions[bot]` as trusted
      // audit sources. The override workflows always post under that
      // identity; if any other commenter types the anchor format into a
      // comment, the dashboard would otherwise surface their forged event
      // as a real override. This is the audit-integrity gate.
      const trusted = (comments as { body?: string; html_url: string; user?: { login?: string } | null }[])
        .filter((c) => c.user?.login === 'github-actions[bot]');
      for (const c of trusted) {
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
    // data right now" without making the operator chase a 500 page. Cache
    // the empty result on a SHORT TTL so a retry within the half-hour
    // success window can actually succeed once the outage clears.
    events = [];
    hadError = true;
  }

  setCached(key, events, hadError ? ERROR_TTL_MS : SUCCESS_TTL_MS);
  return events;
}
