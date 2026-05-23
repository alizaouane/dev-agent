# Events scraper + per-repo Overrides panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize the `<!-- dev-agent:event:b64 ... -->` audit anchors shipped in PRs #96/#97/#98 into queryable override events, and surface them on the dashboard's repo workspace page.

**Architecture:** Three layers — pure-TS helpers + a CLI shell + a dashboard server loader with cache + a UI panel. Mirrors cost-watchdog. No commits-back, no DB, no workflow changes.

**Tech Stack:** TypeScript, vitest, `@octokit/rest`, Next.js app router, React server components.

---

## File structure

| File | Responsibility |
|---|---|
| `lib/events-scrape.ts` | Pure helpers: `extractAnchors`, `decodeAnchor`, `summarizeOverride`. No `fs`, no octokit. Unit-tested directly. |
| `lib/cli/events-scrape.ts` | CLI shell: loads octokit from env, paginates PRs + comments, calls helpers, writes JSONL per PR to `<out-dir>`. |
| `tests/unit/events-scrape.test.ts` | Unit tests for the pure helpers (extract / decode / summarize). |
| `dashboard/lib/dashboard/override-events.ts` | Server-side loader: paginates PRs + comments via octokit, calls helpers, sorts by ts desc, returns at most `limit` results. Cached with 30-min TTL. |
| `dashboard/__tests__/lib/dashboard/override-events.test.ts` | Loader tests with mocked octokit fixtures. |
| `dashboard/components/override-events-panel.tsx` | Server component rendering the per-repo Overrides card. |
| `dashboard/__tests__/components/override-events-panel.test.tsx` | Component render tests (populated + empty states). |
| `dashboard/app/repos/[name]/page.tsx` | Add the override-events fetch + render the new card between bands 5 and 6. |
| `docs/runbooks/2026-05-16-swarm-review-enforcement.md` | One-paragraph note about the CLI for offline JSONL export. |
| `package.json` (root) | Add `"events-scrape": "tsx lib/cli/events-scrape.ts"`. |

---

### Task 1: Pure helpers — `lib/events-scrape.ts`

**Files:**
- Create: `lib/events-scrape.ts`
- Test: `tests/unit/events-scrape.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/unit/events-scrape.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  extractAnchors,
  decodeAnchor,
  summarizeOverride,
  type DevAgentEventLike,
} from '../../lib/events-scrape';

const buildEvent = (overrides: Partial<DevAgentEventLike> = {}): DevAgentEventLike => ({
  ts: '2026-05-22T10:00:00Z',
  run_id: '12345',
  issue: 42,
  phase: 'phase-pr-review',
  event: 'override.applied',
  payload: { override_type: 'swarm-override', actor: 'alice', reason: 'false positive' },
  ...overrides,
});

const encode = (e: DevAgentEventLike): string =>
  Buffer.from(JSON.stringify(e), 'utf8').toString('base64');

const wrap = (b64: string): string => `audit comment body\n\n<!-- dev-agent:event:b64 ${b64} -->`;

describe('extractAnchors', () => {
  it('finds a single anchor in a comment body', () => {
    const b64 = encode(buildEvent());
    const found = extractAnchors(wrap(b64));
    expect(found).toEqual([b64]);
  });

  it('finds multiple anchors when a comment was edited to fix a typo', () => {
    const a = encode(buildEvent({ payload: { override_type: 'swarm-override', actor: 'alice', reason: 'fp' } }));
    const b = encode(buildEvent({ payload: { override_type: 'swarm-override', actor: 'alice', reason: 'false positive' } }));
    const body = `${wrap(a)}\n\nedit: ${wrap(b)}`;
    expect(extractAnchors(body)).toEqual([a, b]);
  });

  it('ignores pre-#96 unencoded anchors (no :b64 suffix)', () => {
    const body = '<!-- dev-agent:event {"ts":"2026-05-20T10:00:00Z"} -->';
    expect(extractAnchors(body)).toEqual([]);
  });

  it('ignores unrelated HTML comments', () => {
    const body = '<!-- vercel:deploy abc -->\n<!-- prettier-ignore -->';
    expect(extractAnchors(body)).toEqual([]);
  });

  it('returns empty array for empty / whitespace-only body', () => {
    expect(extractAnchors('')).toEqual([]);
    expect(extractAnchors('   \n  \n')).toEqual([]);
  });
});

describe('decodeAnchor', () => {
  it('round-trips a valid override.applied event', () => {
    const original = buildEvent();
    const decoded = decodeAnchor(encode(original));
    expect(decoded).toEqual(original);
  });

  it('returns null for non-base64 input', () => {
    expect(decodeAnchor('!!! not base64 !!!')).toBeNull();
  });

  it('returns null for base64 that decodes to invalid JSON', () => {
    const b64 = Buffer.from('not json', 'utf8').toString('base64');
    expect(decodeAnchor(b64)).toBeNull();
  });

  it('returns null for JSON missing required fields', () => {
    const b64 = Buffer.from(JSON.stringify({ ts: '2026-01-01T00:00:00Z' }), 'utf8').toString('base64');
    expect(decodeAnchor(b64)).toBeNull();
  });
});

describe('summarizeOverride', () => {
  it('narrows an override.applied event correctly', () => {
    const e = buildEvent();
    const s = summarizeOverride(e);
    expect(s).toEqual({
      ts: e.ts,
      issue: e.issue,
      actor: 'alice',
      reason: 'false positive',
      override_type: 'swarm-override',
    });
  });

  it('returns null for non-override event types', () => {
    const e = buildEvent({ event: 'cost.snapshot', payload: { total: 10, budget: 50 } });
    expect(summarizeOverride(e)).toBeNull();
  });

  it('returns null when override.applied payload is missing required fields', () => {
    const e = buildEvent({ payload: { override_type: 'swarm-override' } as any });
    expect(summarizeOverride(e)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail** (module doesn't exist):

```bash
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/events-scrape.test.ts
```

Expected: FAIL — `lib/events-scrape` does not exist.

- [ ] **Step 3: Write the implementation** `lib/events-scrape.ts`:

```ts
// Mirrors the shape of `DevAgentEvent` from lib/events.ts but kept loose-typed
// here so this module has no runtime dependency on the writer. The scraper
// must tolerate future event-shape additions without crashing.
export interface DevAgentEventLike {
  ts: string;
  run_id: string;
  issue: number | null;
  phase: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface OverrideSummary {
  ts: string;
  issue: number | null;
  actor: string;
  reason: string;
  override_type: string;
}

// `[A-Za-z0-9+/=]+` is the canonical base64 alphabet. The trailing `=` may
// or may not be present depending on padding; both work.
const ANCHOR = /<!--\s*dev-agent:event:b64\s+([A-Za-z0-9+/=]+)\s*-->/g;

export function extractAnchors(commentBody: string): string[] {
  if (!commentBody) return [];
  const out: string[] = [];
  for (const m of commentBody.matchAll(ANCHOR)) {
    out.push(m[1]);
  }
  return out;
}

export function decodeAnchor(b64: string): DevAgentEventLike | null {
  let json: string;
  try {
    json = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const e = parsed as Partial<DevAgentEventLike>;
  if (
    typeof e.ts !== 'string' ||
    typeof e.run_id !== 'string' ||
    typeof e.phase !== 'string' ||
    typeof e.event !== 'string' ||
    !e.payload ||
    typeof e.payload !== 'object'
  ) {
    return null;
  }
  // `issue` may be null (global events) — only reject if it's neither.
  if (e.issue !== null && typeof e.issue !== 'number') return null;
  return e as DevAgentEventLike;
}

export function summarizeOverride(e: DevAgentEventLike): OverrideSummary | null {
  if (e.event !== 'override.applied') return null;
  const p = e.payload as Record<string, unknown>;
  if (
    typeof p.override_type !== 'string' ||
    typeof p.actor !== 'string' ||
    typeof p.reason !== 'string'
  ) {
    return null;
  }
  return {
    ts: e.ts,
    issue: e.issue,
    actor: p.actor,
    reason: p.reason,
    override_type: p.override_type,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**:

```bash
cd "$(git rev-parse --show-toplevel)" && npx vitest run tests/unit/events-scrape.test.ts
```

Expected: PASS — all assertions green.

- [ ] **Step 5: Verify tsc clean**:

```bash
cd "$(git rev-parse --show-toplevel)" && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 6: Commit**:

```bash
git add lib/events-scrape.ts tests/unit/events-scrape.test.ts
git commit -m "feat(events-scrape): pure helpers — extract, decode, summarize"
```

---

### Task 2: CLI shell — `lib/cli/events-scrape.ts`

**Files:**
- Create: `lib/cli/events-scrape.ts`
- Modify: `package.json` (add `"events-scrape": "tsx lib/cli/events-scrape.ts"` to scripts)

- [ ] **Step 1: Read the sibling CLI pattern**. Open `lib/cli/cost-watchdog.ts` to see how it (a) instantiates octokit from `GH_TOKEN`/`GITHUB_TOKEN`, (b) parses `GITHUB_REPOSITORY` into `{ owner, repo }`, (c) paginates issues + comments. The events-scrape CLI mirrors that I/O surface — different business logic, same shell.

- [ ] **Step 2: Write the CLI**:

```ts
// lib/cli/events-scrape.ts
import { Octokit } from '@octokit/rest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractAnchors, decodeAnchor, summarizeOverride } from '../events-scrape';

function parseArgs(argv: string[]): { outDir: string; windowDays: number } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) { args.out = argv[i + 1]; i++; }
    else if (argv[i] === '--window-days' && argv[i + 1]) { args.windowDays = argv[i + 1]; i++; }
  }
  return {
    outDir: args.out ?? '.dev-agent/events',
    windowDays: args.windowDays ? parseInt(args.windowDays, 10) : 90,
  };
}

async function main(): Promise<void> {
  const { outDir, windowDays } = parseArgs(process.argv.slice(2));
  const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GH_TOKEN / GITHUB_TOKEN required');
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY required (owner/repo)');

  const octokit = new Octokit({ auth: ghToken });
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  // pulls.list (state: 'all') with sort+direction gives us closed PRs too;
  // we filter by updated_at >= since on the client side because the API
  // doesn't expose a server-side `since` for pulls (only issues).
  const prs = await octokit.paginate(octokit.pulls.list, {
    owner,
    repo,
    state: 'all',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  });
  const recentPrs = prs.filter((p) => p.updated_at >= since);

  fs.mkdirSync(outDir, { recursive: true });
  let totalWritten = 0;

  for (const pr of recentPrs) {
    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const out: string[] = [];
    for (const c of comments) {
      const body = c.body ?? '';
      for (const b64 of extractAnchors(body)) {
        const event = decodeAnchor(b64);
        if (!event) continue;
        // Write the raw event — downstream tooling decides whether to narrow.
        out.push(JSON.stringify(event));
      }
    }
    if (out.length === 0) continue;
    const file = path.join(outDir, `${pr.number}.jsonl`);
    fs.writeFileSync(file, out.join('\n') + '\n');
    totalWritten += out.length;
    console.log(`wrote ${out.length} events to ${file}`);
  }
  console.log(`done — ${totalWritten} events across ${recentPrs.length} PRs scanned`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Add the script entry to `package.json`**. In the root `package.json`'s `scripts` block, add:

```json
"events-scrape": "tsx lib/cli/events-scrape.ts"
```

Place it alphabetically (between `cost-watchdog` and any later entry).

- [ ] **Step 4: Verify tsc clean + tests stay green**:

```bash
cd "$(git rev-parse --show-toplevel)" && npx tsc --noEmit && npm test
```

Expected: zero tsc errors, root suite all green (count goes up by 11 vs pre-Task-1).

- [ ] **Step 5: Commit**:

```bash
git add lib/cli/events-scrape.ts package.json
git commit -m "feat(events-scrape): CLI shell + npm script"
```

---

### Task 3: Dashboard server loader — `dashboard/lib/dashboard/override-events.ts`

**Files:**
- Create: `dashboard/lib/dashboard/override-events.ts`
- Test: `dashboard/__tests__/lib/dashboard/override-events.test.ts`

- [ ] **Step 1: Read the cache pattern**. Open `dashboard/lib/verification/cache.ts`. The override loader uses the same TTL + FIFO + hashed-key pattern. You can either reuse `getCached`/`setCached`/`hashInputs` from that file directly or write a sibling — reuse is preferred unless the hashInputs signature is too rigid (it takes `(repos, windowDays)`; override loader needs `(owner, name, limit, windowDays)`).

- [ ] **Step 2: Write the failing test**:

```ts
// dashboard/__tests__/lib/dashboard/override-events.test.ts
import { describe, it, expect, vi } from 'vitest';
import { loadOverrideEvents, __resetCacheForTests } from '../../../lib/dashboard/override-events';

const buildEvent = (overrides: Record<string, unknown> = {}) => ({
  ts: '2026-05-22T10:00:00Z',
  run_id: '12345',
  issue: 42,
  phase: 'phase-pr-review',
  event: 'override.applied',
  payload: { override_type: 'swarm-override', actor: 'alice', reason: 'false positive' },
  ...overrides,
});

const wrapAnchor = (event: object): string =>
  `audit comment\n\n<!-- dev-agent:event:b64 ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')} -->`;

function makeMockOctokit(prs: { number: number; updated_at: string; comments: { body: string; html_url: string }[] }[]) {
  return {
    paginate: vi.fn(async (fn: unknown, opts: { issue_number?: number }) => {
      if (opts.issue_number !== undefined) {
        const pr = prs.find((p) => p.number === opts.issue_number);
        return pr?.comments ?? [];
      }
      return prs.map((p) => ({ number: p.number, updated_at: p.updated_at }));
    }),
    pulls: { list: vi.fn() },
    issues: { listComments: vi.fn() },
  } as never;
}

describe('loadOverrideEvents', () => {
  beforeEach(() => __resetCacheForTests());

  it('returns the most recent override events sorted by ts desc', async () => {
    const older = buildEvent({ ts: '2026-05-20T10:00:00Z', payload: { override_type: 'swarm-override', actor: 'bob', reason: 'old' } });
    const newer = buildEvent({ ts: '2026-05-22T10:00:00Z', payload: { override_type: 'swarm-override', actor: 'alice', reason: 'new' } });
    const octokit = makeMockOctokit([
      { number: 42, updated_at: '2026-05-22T10:00:00Z', comments: [{ body: wrapAnchor(newer), html_url: 'https://gh.example/42#new' }] },
      { number: 41, updated_at: '2026-05-20T10:00:00Z', comments: [{ body: wrapAnchor(older), html_url: 'https://gh.example/41#old' }] },
    ]);
    const events = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' });
    expect(events).toHaveLength(2);
    expect(events[0].actor).toBe('alice');
    expect(events[1].actor).toBe('bob');
    expect(events[0].source_comment_url).toBe('https://gh.example/42#new');
  });

  it('skips comments without anchors and PRs without override comments', async () => {
    const octokit = makeMockOctokit([
      { number: 99, updated_at: '2026-05-22T10:00:00Z', comments: [{ body: 'no anchor here', html_url: 'x' }] },
    ]);
    const events = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' });
    expect(events).toEqual([]);
  });

  it('truncates to the limit and uses the cache on second call', async () => {
    const octokit = makeMockOctokit([
      { number: 1, updated_at: '2026-05-22T10:00:00Z', comments: [{ body: wrapAnchor(buildEvent()), html_url: 'x' }] },
    ]);
    const first = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' }, { limit: 5 });
    const second = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' }, { limit: 5 });
    expect(second).toEqual(first);
    // Second call hit the cache — paginate should not have been called again
    // for the same key. Expectation: paginate called for PRs+comments on the
    // first run, no additional calls on the second.
    expect((octokit as never as { paginate: { mock: { calls: unknown[] } } }).paginate.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('returns [] on octokit errors instead of crashing', async () => {
    const octokit = {
      paginate: vi.fn(async () => { throw new Error('rate limit'); }),
      pulls: { list: vi.fn() },
      issues: { listComments: vi.fn() },
    } as never;
    const events = await loadOverrideEvents(octokit, { owner: 'o', name: 'r' });
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test, confirm it fails** (module doesn't exist):

```bash
cd "$(git rev-parse --show-toplevel)/dashboard" && npx vitest run __tests__/lib/dashboard/override-events.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the loader**:

```ts
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
```

- [ ] **Step 5: Run the test, verify pass**:

```bash
cd "$(git rev-parse --show-toplevel)/dashboard" && npx vitest run __tests__/lib/dashboard/override-events.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full dashboard suite to confirm no regression**:

```bash
cd "$(git rev-parse --show-toplevel)/dashboard" && npm test
```

Expected: all green (count goes up by the 4 new override-events tests).

- [ ] **Step 7: Commit**:

```bash
git add dashboard/lib/dashboard/override-events.ts dashboard/__tests__/lib/dashboard/override-events.test.ts
git commit -m "feat(events-scrape): dashboard server loader with 30-min cache"
```

---

### Task 4: UI panel + page integration + runbook touch-up

**Files:**
- Create: `dashboard/components/override-events-panel.tsx`
- Test: `dashboard/__tests__/components/override-events-panel.test.tsx`
- Modify: `dashboard/app/repos/[name]/page.tsx`
- Modify: `docs/runbooks/2026-05-16-swarm-review-enforcement.md`

- [ ] **Step 1: Read the existing panel pattern**. Open `dashboard/components/verification-posture-strip.tsx` to see the established card layout, typography, and how empty states are handled. The Overrides panel mirrors that visual language.

- [ ] **Step 2: Write the failing component test**:

```tsx
// dashboard/__tests__/components/override-events-panel.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverrideEventsPanel } from '../../components/override-events-panel';

const sample = (n = 1) =>
  Array.from({ length: n }, (_, i) => ({
    ts: `2026-05-${20 + i}T10:00:00Z`,
    pr_number: 100 + i,
    actor: `user${i}`,
    reason: i === 0 ? 'short reason' : 'x'.repeat(120),
    source_comment_url: `https://github.com/o/r/pull/${100 + i}#issuecomment-${i}`,
  }));

describe('OverrideEventsPanel', () => {
  it('renders the empty state when no events exist', () => {
    render(<OverrideEventsPanel events={[]} repo="owner/name" />);
    expect(screen.getByText(/no .* override activity/i)).toBeInTheDocument();
  });

  it('renders one row per event with actor, PR, and source link', () => {
    render(<OverrideEventsPanel events={sample(2)} repo="owner/name" />);
    expect(screen.getByText('@user0')).toBeInTheDocument();
    expect(screen.getByText('@user1')).toBeInTheDocument();
    expect(screen.getByText('#100')).toBeInTheDocument();
    expect(screen.getByText('#101')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /view audit comment/i });
    expect(links.length).toBe(2);
  });

  it('truncates reasons over 80 chars with an ellipsis', () => {
    render(<OverrideEventsPanel events={sample(2)} repo="owner/name" />);
    // The long reason (index 1) should be rendered truncated.
    // truncate(s, 80) → s.slice(0, 79) + '…' for s.length > 80, so the
    // expected output is 79 x's + ellipsis, matching the implementation.
    expect(screen.getByText(/^x{79}…$/)).toBeInTheDocument();
  });
});
```

(The test uses `@testing-library/react` — verify it's already in the dashboard's dev deps with `grep "testing-library/react" dashboard/package.json`. If absent, the dashboard tests are using a different harness; mirror that instead.)

- [ ] **Step 3: Run the test, confirm it fails**:

```bash
cd "$(git rev-parse --show-toplevel)/dashboard" && npx vitest run __tests__/components/override-events-panel.test.tsx
```

Expected: FAIL — component doesn't exist.

- [ ] **Step 4: Write the component**:

```tsx
// dashboard/components/override-events-panel.tsx
import type { OverrideEvent } from '@/lib/dashboard/override-events';

const TRUNCATE = 80;

function truncate(s: string, n = TRUNCATE): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function relativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function OverrideEventsPanel({
  events,
  repo,
}: {
  events: OverrideEvent[];
  repo: string; // "owner/name", used in PR link construction
}) {
  if (events.length === 0) {
    return (
      <section className="rounded-md border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">Recent overrides</h2>
        <p className="mt-2 text-xs text-zinc-500">
          No <code>/swarm-override</code> activity on this repo in the last 90 days.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-md border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-zinc-900">Recent overrides</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Reconstructed from audit anchors on PR comments. Last 10 in the past 90 days.
      </p>
      <ul className="mt-3 divide-y divide-zinc-100">
        {events.map((e) => (
          <li key={e.source_comment_url} className="grid grid-cols-12 gap-2 py-2 text-xs">
            <time
              className="col-span-2 text-zinc-500"
              dateTime={e.ts}
              title={e.ts}
            >
              {relativeTime(e.ts)}
            </time>
            <a
              className="col-span-1 font-mono text-blue-600 hover:underline"
              href={`https://github.com/${repo}/pull/${e.pr_number}`}
              target="_blank"
              rel="noreferrer"
            >
              #{e.pr_number}
            </a>
            <a
              className="col-span-2 text-blue-600 hover:underline"
              href={`https://github.com/${e.actor}`}
              target="_blank"
              rel="noreferrer"
            >
              @{e.actor}
            </a>
            <span className="col-span-5 text-zinc-700" title={e.reason}>
              {truncate(e.reason)}
            </span>
            <a
              className="col-span-2 text-right text-zinc-500 hover:text-blue-600 hover:underline"
              href={e.source_comment_url}
              target="_blank"
              rel="noreferrer"
            >
              view audit comment
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Run the test, confirm pass**:

```bash
cd "$(git rev-parse --show-toplevel)/dashboard" && npx vitest run __tests__/components/override-events-panel.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Wire into `dashboard/app/repos/[name]/page.tsx`**. Locate **Band 5 — Verification posture for this repo** (around line 171) and **Band 6 — Cost** (around line 192). Between them, add:

```tsx
import { loadOverrideEvents } from '@/lib/dashboard/override-events';
import { OverrideEventsPanel } from '@/components/override-events-panel';
```

(Place imports alphabetically near the existing ones.)

Then in the page body, between the existing Band 5 and Band 6 closing tags, add:

```tsx
{/* Band 5.5 — Recent overrides */}
<section className="mt-6">
  {(() => {
    const overrideEvents = await loadOverrideEvents(octokit, {
      owner: repo.owner,
      name: repo.name,
    });
    return <OverrideEventsPanel events={overrideEvents} repo={`${repo.owner}/${repo.name}`} />;
  })()}
</section>
```

(That async IIFE inside JSX won't work — make this a top-level `await` alongside `loadRepoWorkspace`. Pattern: find where `loadRepoWorkspace(octokit, repo)` is awaited at the top of the page component, add a sibling `const overrideEvents = await loadOverrideEvents(octokit, { owner: repo.owner, name: repo.name });` next to it, then render with the simple JSX `<OverrideEventsPanel events={overrideEvents} repo={...} />`.)

- [ ] **Step 7: Update the runbook**. In `docs/runbooks/2026-05-16-swarm-review-enforcement.md`, immediately after the "Audit trail for /swarm-override (engine + consumer)" subsection, add a new subsection:

```markdown
### Offline export — `lib/cli/events-scrape.ts`

For ad-hoc audit-trail export (offline analysis, eval pipelines, etc.), the engine repo's `events-scrape` CLI walks PR comments by anchor and writes one JSONL line per event:

```bash
GH_TOKEN=... GITHUB_REPOSITORY=owner/name npm run events-scrape -- --out .dev-agent/events
```

Output is `.dev-agent/events/<pr-number>.jsonl` per PR with at least one override event. Default scan window is the last 90 days; override with `--window-days N`. The CLI is opt-in (manual invocation) — operators who want persisted history can run it on a cadence of their choice. The dashboard's Overrides panel reads the same anchors directly and does not require the CLI to be run.
```

- [ ] **Step 8: Run all tests + tsc + verify the dashboard builds**:

```bash
cd "$(git rev-parse --show-toplevel)" && npm test
cd "$(git rev-parse --show-toplevel)/dashboard" && npm test && npx tsc --noEmit
```

All three must be all-green.

- [ ] **Step 9: Manually verify the panel locally**. Start the dashboard dev server, visit `/repos/<a-repo-with-known-override-history>`, confirm the card renders. If no repo has shipped an override yet (canary just started), confirm the empty state renders correctly.

```bash
cd "$(git rev-parse --show-toplevel)/dashboard" && npm run dev
# Then visit http://localhost:3000/repos/<name>
```

- [ ] **Step 10: Commit**:

```bash
git add dashboard/components/override-events-panel.tsx dashboard/__tests__/components/override-events-panel.test.tsx dashboard/app/repos/[name]/page.tsx docs/runbooks/2026-05-16-swarm-review-enforcement.md
git commit -m "feat(events-scrape): per-repo Overrides panel + page wire-up + runbook"
```

---

## Self-review

- [x] Spec coverage: pure helpers → Task 1; CLI → Task 2; loader+cache → Task 3; UI panel + page + runbook → Task 4. No spec section is unaddressed.
- [x] No placeholders. Each step has exact files, exact commands, exact code.
- [x] Type consistency: `DevAgentEventLike`, `OverrideSummary`, `OverrideEvent`, `LoadOpts` — same names used in tests, helpers, loader, component.
- [x] File count math: 4 new TS files (lib + CLI + loader + component) + 3 new test files + 2 modified files (page, runbook) + 1 modified `package.json` = 10 files touched.
- [x] No engine workflow changes. No schema changes. No DB. No commits-back. Purely additive on top of the audit-anchor pipeline already shipped.
