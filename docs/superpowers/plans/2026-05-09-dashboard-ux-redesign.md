# Dashboard UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-09-dashboard-ux-redesign-design.md`

**Goal:** Replace the inbox-only home and thin per-repo page with a global Home (command center) and rich per-repo Workspace, both surfacing verification pillar outcomes as first-class artifacts.

**Architecture:** Two new server-side data loaders (`lib/dashboard/home-bands.ts`, `lib/dashboard/repo-workspace.ts`) compose data from existing libs (`pipeline.ts`, `repos.ts`, `scout/`, `active-runs.ts`) plus a new verification aggregator (`lib/verification/`). One reusable `<VerificationBadges>` component renders pillar outcomes across eight surfaces. Existing drill-down pages (`/proposals`, `/pipeline`, `/cost`, `/activity`, `/intent`) are preserved unchanged; only nav placement and entry density change.

**Tech Stack:** Next.js 15 App Router (RSC + `'use client'`), TypeScript strict, Tailwind v4, shadcn-style UI primitives in `components/ui/`, vitest + jsdom + @testing-library/react for unit/component tests, Playwright for E2E, Octokit for GitHub, recharts for cost charting.

---

## File structure

### New files

```
dashboard/lib/verification/
├── types.ts                        # VerificationOutcome, VerificationRollup, PillarId, PillarStatus
├── aggregate.ts                    # aggregate(repos, window) — orchestrates extractors, returns rollup
├── cache.ts                        # 30-min in-memory cache keyed on input hash (mirror categorize-proposals)
└── extractors/
    ├── gate-b.ts                   # readGateBOutcomes(octokit, repo, issueNumber) → VerificationOutcome | null
    ├── audit.ts                    # Pillar 4 — TS/JS apply audit
    ├── risk.ts                     # Pillar 5 — risk-annotation audit
    ├── smoke.ts                    # Pillar 7 — Tier-2 smoke live mode
    └── evidence.ts                 # Pillar 2 — EvidenceBundle freeze

dashboard/lib/dashboard/
├── home-bands.ts                   # one async fn per home band; returns typed band data
└── repo-workspace.ts               # one async fn per repo workspace band

dashboard/components/
├── verification-badges.tsx         # the eight-surface chip strip
├── feature-card.tsx                # unified row: title + repo + age + badges + actions
├── repo-card.tsx                   # Home Band 7 card
├── verification-posture-strip.tsx  # numeric strip for Home Band 6 / Repo Band 5
├── setup-checklist.tsx             # fresh-wired-repo onboarding panel
├── help-panel.tsx                  # header `?` slide-over (client)
└── empty-state.tsx                 # reusable: icon + title + body + optional CTA
```

### Modified files

- `dashboard/app/page.tsx` — rebuilt as 7-band Home
- `dashboard/app/repos/[name]/page.tsx` — rebuilt as 7-band Repo Workspace; preserves scan/scout/schedule panels by moving them into Band 7 (Settings)
- `dashboard/app/features/[issue]/page.tsx` — fetch verification outcomes; pass to FeatureDetail
- `dashboard/components/feature-detail.tsx` — add Verification card with gate timeline + pillar outcomes + evidence + cost
- `dashboard/components/nav-header.tsx` — collapse to 3 primary + secondary; promote "Brainstorm new work"; add `?` button

### Test files (mirror source paths under `__tests__/`)

```
dashboard/__tests__/lib/verification/
├── types.test.ts
├── aggregate.test.ts
├── cache.test.ts
└── extractors/
    ├── gate-b.test.ts
    ├── audit.test.ts
    ├── risk.test.ts
    ├── smoke.test.ts
    └── evidence.test.ts

dashboard/__tests__/lib/dashboard/
├── home-bands.test.ts
└── repo-workspace.test.ts

dashboard/__tests__/components/
├── verification-badges.test.tsx
├── feature-card.test.tsx
├── repo-card.test.tsx
├── verification-posture-strip.test.tsx
├── setup-checklist.test.tsx
├── help-panel.test.tsx
├── empty-state.test.tsx
└── nav-header.test.tsx

dashboard/__tests__/e2e/
└── dashboard-redesign.spec.ts
```

---

## Conventions

- **Test pattern:** copy the existing style from `__tests__/components/inbox-item.test.tsx` (component) and `__tests__/lib/pipeline.test.ts` (lib). Use vitest's `describe`/`it`/`expect`, `@testing-library/react` for rendering. No `import React` at top of `.tsx` (vitest config's automatic JSX runtime handles it).
- **Server-only modules:** files that perform server I/O (Octokit calls, in-memory caches, data loaders) start with `import 'server-only';` — `lib/verification/cache.ts`, `lib/verification/aggregate.ts`, the extractors, and `lib/dashboard/*`. **Exception:** `lib/verification/types.ts` is a pure types-and-constants module and MUST NOT have `server-only` (client components import its types/constants — `server-only` would crash the client at runtime).
- **Octokit mocks in tests:** instantiate via `new Octokit()` and stub specific methods with `vi.fn()` returning the canned response (existing pattern in `__tests__/lib/pipeline.test.ts`).
- **Branch:** create a fresh branch `feat/dashboard-ux-redesign` off `main` for this work — keep it isolated from the in-flight `feat/verification-pillar4-apply-audit` branch.
- **Commit cadence:** after every passing test (Step N's "Commit" is its own checkbox).
- **Run tests:** `cd dashboard && npm test -- <path-to-test-file>` for a single file; `npm test` for the full suite.
- **Typecheck:** `cd dashboard && npm run typecheck` after every step's final commit.

---

## Step 1 — Verification aggregator + types

Foundation. No UI yet. Defines the data contract every UI surface will consume.

### Task 1.1: Define core type contracts

**Files:**
- Create: `dashboard/lib/verification/types.ts`
- Test: `dashboard/__tests__/lib/verification/types.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/__tests__/lib/verification/types.test.ts
import { describe, it, expect } from 'vitest';
import {
  PILLAR_IDS,
  isVerificationOutcome,
  type VerificationOutcome,
  type VerificationRollup,
} from '@/lib/verification/types';

describe('verification types', () => {
  it('PILLAR_IDS lists the five v1 pillars', () => {
    expect(PILLAR_IDS).toEqual(['gate_b', 'audit_p4', 'risk_p5', 'smoke_p7', 'evidence_p2']);
  });

  it('isVerificationOutcome accepts a fully-formed outcome', () => {
    const ok: VerificationOutcome = {
      feature_id: 142,
      repo: 'qualiency/caliente',
      pillar: 'audit_p4',
      status: 'passed',
      summary: 'No syntax issues found',
      details_url: 'https://github.com/x/y/actions/runs/1',
      cost_usd: 0.04,
      ran_at: '2026-05-09T10:00:00Z',
    };
    expect(isVerificationOutcome(ok)).toBe(true);
  });

  it('isVerificationOutcome rejects bad status', () => {
    expect(
      isVerificationOutcome({
        feature_id: 1,
        repo: 'a/b',
        pillar: 'audit_p4',
        status: 'maybe',
        summary: '',
        details_url: '',
        ran_at: '2026-05-09T10:00:00Z',
      } as unknown),
    ).toBe(false);
  });

  it('VerificationRollup compiles with required fields', () => {
    const rollup: VerificationRollup = {
      window_days: 7,
      generated_at: '2026-05-09T10:00:00Z',
      shipped_count: 12,
      audit_caught_count: 3,
      risk_flagged_count: 2,
      smoke_failed_count: 1,
      total_cost_usd: 4.2,
    };
    expect(rollup.shipped_count).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/lib/verification/types.test.ts`
Expected: FAIL with module-not-found / type-not-exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// dashboard/lib/verification/types.ts
// Pure types + constants. NO `import 'server-only'` here — client components
// (verification badges, feature cards, posture strip) import from this file
// and `server-only` would crash the client bundle at runtime.

export const PILLAR_IDS = ['gate_b', 'audit_p4', 'risk_p5', 'smoke_p7', 'evidence_p2'] as const;
export type PillarId = (typeof PILLAR_IDS)[number];

export const PILLAR_LABELS: Record<PillarId, string> = {
  gate_b: 'Gate B',
  audit_p4: 'Audit (Pillar 4)',
  risk_p5: 'Risk (Pillar 5)',
  smoke_p7: 'Smoke (Pillar 7)',
  evidence_p2: 'Evidence (Pillar 2)',
};

export type PillarStatus = 'passed' | 'blocked' | 'advisory' | 'failed' | 'not_run';

export type VerificationOutcome = {
  feature_id: number;
  repo: string;
  pillar: PillarId;
  status: PillarStatus;
  summary: string;
  details_url: string;
  cost_usd?: number;
  ran_at: string; // ISO 8601
};

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'passed',
  'blocked',
  'advisory',
  'failed',
  'not_run',
]);

export function isVerificationOutcome(v: unknown): v is VerificationOutcome {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.feature_id === 'number' &&
    typeof o.repo === 'string' &&
    typeof o.pillar === 'string' &&
    (PILLAR_IDS as readonly string[]).includes(o.pillar) &&
    typeof o.status === 'string' &&
    VALID_STATUSES.has(o.status) &&
    typeof o.summary === 'string' &&
    typeof o.details_url === 'string' &&
    typeof o.ran_at === 'string'
  );
}

export type VerificationRollup = {
  window_days: number;
  generated_at: string; // ISO 8601
  shipped_count: number;
  audit_caught_count: number;
  risk_flagged_count: number;
  smoke_failed_count: number;
  total_cost_usd: number;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/lib/verification/types.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/verification/types.ts dashboard/__tests__/lib/verification/types.test.ts
git commit -m "feat(dashboard): verification types — Outcome + Rollup + PillarId"
```

---

### Task 1.2: Cache helper (30-min TTL, hash-keyed)

**Files:**
- Create: `dashboard/lib/verification/cache.ts`
- Test: `dashboard/__tests__/lib/verification/cache.test.ts`

The aggregator's GitHub round-trips are expensive; cache by the input-set hash for 30 min, mirroring `categorize-proposals`.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/__tests__/lib/verification/cache.test.ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/lib/verification/cache.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// dashboard/lib/verification/cache.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/lib/verification/cache.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/verification/cache.ts dashboard/__tests__/lib/verification/cache.test.ts
git commit -m "feat(dashboard): verification cache — 30-min TTL, hash-keyed"
```

---

### Task 1.3: Pillar 4 audit extractor

**Files:**
- Create: `dashboard/lib/verification/extractors/audit.ts`
- Test: `dashboard/__tests__/lib/verification/extractors/audit.test.ts`

**Investigation step before coding:** read `lib/cli/risk-audit.ts` and `prompts/` and `.github/workflows/phase-implement.yml` to find where Pillar 4 (TS/JS apply audit) writes its output. The audit is advisory and posts results as a PR comment with a recognizable heading like `## Apply Audit (Pillar 4)`. The extractor reads the issue's PR comments and looks for that heading.

- [ ] **Step 1: Investigation note (no code)**

Run these to confirm the artifact format:

```bash
grep -rn "Apply Audit\|Pillar 4\|apply-audit" /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/lib /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/prompts /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/.github/workflows | head -30
git log --oneline -10 --all -- 'lib/cli/risk-audit.ts'
```

Capture the exact heading the audit writes (and where) before implementing the extractor. Update the test fixture below to match the real format.

- [ ] **Step 2: Write the failing test**

```typescript
// dashboard/__tests__/lib/verification/extractors/audit.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractAuditOutcome } from '@/lib/verification/extractors/audit';

function mkOctokit(comments: Array<{ body: string; html_url: string }>) {
  return {
    issues: {
      listComments: vi.fn().mockResolvedValue({ data: comments }),
    },
    paginate: vi.fn(async (_fn: unknown, _opts: unknown) => comments),
  } as unknown as Parameters<typeof extractAuditOutcome>[0];
}

describe('extractAuditOutcome (Pillar 4)', () => {
  it('returns null when no audit comment exists', async () => {
    const oct = mkOctokit([{ body: 'unrelated comment', html_url: 'x' }]);
    const out = await extractAuditOutcome(oct, 'a/b', 142);
    expect(out).toBeNull();
  });

  it('returns passed when audit found 0 issues', async () => {
    const body = '## Apply Audit (Pillar 4)\n\nResult: passed\nIssues: 0';
    const oct = mkOctokit([{ body, html_url: 'https://example/c1' }]);
    const out = await extractAuditOutcome(oct, 'a/b', 142);
    expect(out).toMatchObject({
      pillar: 'audit_p4',
      status: 'passed',
      details_url: 'https://example/c1',
    });
  });

  it('returns advisory when audit found N issues but did not block', async () => {
    const body = '## Apply Audit (Pillar 4)\n\nResult: advisory\nIssues: 2';
    const oct = mkOctokit([{ body, html_url: 'https://example/c2' }]);
    const out = await extractAuditOutcome(oct, 'a/b', 142);
    expect(out?.status).toBe('advisory');
    expect(out?.summary).toMatch(/2/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/lib/verification/extractors/audit.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 4: Write minimal implementation**

```typescript
// dashboard/lib/verification/extractors/audit.ts
import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { VerificationOutcome } from '../types';

const HEADING = /^##\s*Apply\s+Audit\s*\(Pillar\s*4\)/im;
const RESULT_LINE = /Result:\s*(passed|advisory|blocked|failed)/i;
const ISSUES_LINE = /Issues:\s*(\d+)/i;

export async function extractAuditOutcome(
  octokit: Octokit,
  repo: string,
  issueNumber: number,
): Promise<VerificationOutcome | null> {
  const [owner, name] = repo.split('/');
  type C = { body?: string | null; html_url: string; created_at?: string };
  const comments = (await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo: name,
    issue_number: issueNumber,
    per_page: 100,
  })) as C[];
  // Walk newest-first to find the latest audit comment.
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body ?? '';
    if (!HEADING.test(body)) continue;
    const result = body.match(RESULT_LINE)?.[1]?.toLowerCase() ?? 'advisory';
    const issues = parseInt(body.match(ISSUES_LINE)?.[1] ?? '0', 10);
    const status = result === 'passed' ? 'passed' : (result as 'advisory' | 'blocked' | 'failed');
    return {
      feature_id: issueNumber,
      repo,
      pillar: 'audit_p4',
      status,
      summary: status === 'passed' ? 'No syntax issues found' : `${issues} issue${issues === 1 ? '' : 's'}`,
      details_url: comments[i].html_url,
      ran_at: comments[i].created_at ?? new Date().toISOString(),
    };
  }
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/lib/verification/extractors/audit.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/verification/extractors/audit.ts dashboard/__tests__/lib/verification/extractors/audit.test.ts
git commit -m "feat(dashboard): Pillar 4 audit outcome extractor"
```

---

### Task 1.4: Pillar 5 risk extractor

**Files:**
- Create: `dashboard/lib/verification/extractors/risk.ts`
- Test: `dashboard/__tests__/lib/verification/extractors/risk.test.ts`

Same pattern as Task 1.3. Investigation: read `lib/cli/risk-audit.ts` and find the comment heading (likely `## Risk Annotation Audit (Pillar 5)`).

- [ ] **Step 1: Investigation**

```bash
grep -rn "Risk\s*Annotation\|Pillar 5\|risk-audit\|risk_audit" /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/lib /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/prompts | head -20
```

Confirm the heading + status field names. Update the fixture in Step 2 if the format differs.

- [ ] **Step 2: Write the failing test**

```typescript
// dashboard/__tests__/lib/verification/extractors/risk.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractRiskOutcome } from '@/lib/verification/extractors/risk';

function mkOctokit(comments: Array<{ body: string; html_url: string; created_at?: string }>) {
  return {
    issues: { listComments: vi.fn() },
    paginate: vi.fn(async () => comments),
  } as unknown as Parameters<typeof extractRiskOutcome>[0];
}

describe('extractRiskOutcome (Pillar 5)', () => {
  it('returns null with no risk comment', async () => {
    const oct = mkOctokit([{ body: 'noise', html_url: 'x' }]);
    expect(await extractRiskOutcome(oct, 'a/b', 1)).toBeNull();
  });

  it('returns advisory when risk-flagged for re-review', async () => {
    const body = '## Risk Annotation Audit (Pillar 5)\n\nResult: advisory\nFlags: re-review';
    const oct = mkOctokit([{ body, html_url: 'https://example/c' }]);
    const out = await extractRiskOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('advisory');
    expect(out?.pillar).toBe('risk_p5');
  });

  it('returns passed when no risk flags', async () => {
    const body = '## Risk Annotation Audit (Pillar 5)\n\nResult: passed';
    const oct = mkOctokit([{ body, html_url: 'https://example/c' }]);
    const out = await extractRiskOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('passed');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/lib/verification/extractors/risk.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write minimal implementation**

```typescript
// dashboard/lib/verification/extractors/risk.ts
import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { VerificationOutcome } from '../types';

const HEADING = /^##\s*Risk\s+Annotation\s+Audit\s*\(Pillar\s*5\)/im;
const RESULT_LINE = /Result:\s*(passed|advisory|blocked|failed)/i;

export async function extractRiskOutcome(
  octokit: Octokit,
  repo: string,
  issueNumber: number,
): Promise<VerificationOutcome | null> {
  const [owner, name] = repo.split('/');
  type C = { body?: string | null; html_url: string; created_at?: string };
  const comments = (await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo: name,
    issue_number: issueNumber,
    per_page: 100,
  })) as C[];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body ?? '';
    if (!HEADING.test(body)) continue;
    const result = body.match(RESULT_LINE)?.[1]?.toLowerCase() ?? 'advisory';
    const status = result === 'passed' ? 'passed' : (result as 'advisory' | 'blocked' | 'failed');
    return {
      feature_id: issueNumber,
      repo,
      pillar: 'risk_p5',
      status,
      summary: status === 'passed' ? 'No risk flags' : 'Risk flags raised',
      details_url: comments[i].html_url,
      ran_at: comments[i].created_at ?? new Date().toISOString(),
    };
  }
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/lib/verification/extractors/risk.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/verification/extractors/risk.ts dashboard/__tests__/lib/verification/extractors/risk.test.ts
git commit -m "feat(dashboard): Pillar 5 risk outcome extractor"
```

---

### Task 1.5: Pillar 7 smoke extractor

**Files:**
- Create: `dashboard/lib/verification/extractors/smoke.ts`
- Test: `dashboard/__tests__/lib/verification/extractors/smoke.test.ts`

Smoke results are produced by `phase-tier2-smoke.yml` and `phase-smoke-verify.yml`. They post a comment summarizing the smoke run; we extract status from a heading like `## Tier-2 Smoke (Pillar 7)`.

- [ ] **Step 1: Investigation**

```bash
grep -rn "Tier-2 Smoke\|Pillar 7\|smoke-verify\|tier2_smoke" /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/.github/workflows /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/lib | head -20
```

Confirm the comment heading. Update fixture if needed.

- [ ] **Step 2: Write the failing test**

```typescript
// dashboard/__tests__/lib/verification/extractors/smoke.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractSmokeOutcome } from '@/lib/verification/extractors/smoke';

function mkOctokit(comments: Array<{ body: string; html_url: string; created_at?: string }>) {
  return {
    issues: { listComments: vi.fn() },
    paginate: vi.fn(async () => comments),
  } as unknown as Parameters<typeof extractSmokeOutcome>[0];
}

describe('extractSmokeOutcome (Pillar 7)', () => {
  it('returns null without a smoke comment', async () => {
    const oct = mkOctokit([{ body: 'x', html_url: 'y' }]);
    expect(await extractSmokeOutcome(oct, 'a/b', 1)).toBeNull();
  });

  it('returns passed when smoke succeeded', async () => {
    const body = '## Tier-2 Smoke (Pillar 7)\n\nResult: passed';
    const oct = mkOctokit([{ body, html_url: 'https://example/c' }]);
    const out = await extractSmokeOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('passed');
  });

  it('returns failed when smoke failed', async () => {
    const body = '## Tier-2 Smoke (Pillar 7)\n\nResult: failed\nFailures: 1';
    const oct = mkOctokit([{ body, html_url: 'https://example/c' }]);
    const out = await extractSmokeOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('failed');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/lib/verification/extractors/smoke.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write minimal implementation**

```typescript
// dashboard/lib/verification/extractors/smoke.ts
import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { VerificationOutcome } from '../types';

const HEADING = /^##\s*Tier-2\s+Smoke\s*\(Pillar\s*7\)/im;
const RESULT_LINE = /Result:\s*(passed|advisory|blocked|failed)/i;

export async function extractSmokeOutcome(
  octokit: Octokit,
  repo: string,
  issueNumber: number,
): Promise<VerificationOutcome | null> {
  const [owner, name] = repo.split('/');
  type C = { body?: string | null; html_url: string; created_at?: string };
  const comments = (await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo: name,
    issue_number: issueNumber,
    per_page: 100,
  })) as C[];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body ?? '';
    if (!HEADING.test(body)) continue;
    const result = body.match(RESULT_LINE)?.[1]?.toLowerCase() ?? 'advisory';
    const status = result === 'passed' ? 'passed' : (result as 'advisory' | 'blocked' | 'failed');
    return {
      feature_id: issueNumber,
      repo,
      pillar: 'smoke_p7',
      status,
      summary: status === 'passed' ? 'Smoke passed' : 'Smoke failed',
      details_url: comments[i].html_url,
      ran_at: comments[i].created_at ?? new Date().toISOString(),
    };
  }
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/lib/verification/extractors/smoke.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/verification/extractors/smoke.ts dashboard/__tests__/lib/verification/extractors/smoke.test.ts
git commit -m "feat(dashboard): Pillar 7 smoke outcome extractor"
```

---

### Task 1.6: Gate B reviewer extractor

**Files:**
- Create: `dashboard/lib/verification/extractors/gate-b.ts`
- Test: `dashboard/__tests__/lib/verification/extractors/gate-b.test.ts`

Gate B is the swarm-review phase. `phase-swarm-review.yml` posts a summary comment with a heading like `## Swarm Review (Gate B)` and a per-reviewer breakdown.

- [ ] **Step 1: Investigation**

```bash
grep -rn "Swarm Review\|Gate B\|swarm_review\|swarm-review" /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/.github/workflows /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/lib /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/prompts | head -20
```

- [ ] **Step 2: Write the failing test**

```typescript
// dashboard/__tests__/lib/verification/extractors/gate-b.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractGateBOutcome } from '@/lib/verification/extractors/gate-b';

function mkOctokit(comments: Array<{ body: string; html_url: string; created_at?: string }>) {
  return {
    issues: { listComments: vi.fn() },
    paginate: vi.fn(async () => comments),
  } as unknown as Parameters<typeof extractGateBOutcome>[0];
}

describe('extractGateBOutcome', () => {
  it('returns null without a Gate B comment', async () => {
    const oct = mkOctokit([{ body: 'x', html_url: 'y' }]);
    expect(await extractGateBOutcome(oct, 'a/b', 1)).toBeNull();
  });

  it('returns passed and counts reviewers', async () => {
    const body = '## Swarm Review (Gate B)\n\nResult: passed\nReviewers: 3';
    const oct = mkOctokit([{ body, html_url: 'https://example/c' }]);
    const out = await extractGateBOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('passed');
    expect(out?.summary).toMatch(/3/);
  });

  it('returns blocked when any reviewer blocked', async () => {
    const body = '## Swarm Review (Gate B)\n\nResult: blocked\nReviewers: 3';
    const oct = mkOctokit([{ body, html_url: 'https://example/c' }]);
    const out = await extractGateBOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('blocked');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/lib/verification/extractors/gate-b.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write minimal implementation**

```typescript
// dashboard/lib/verification/extractors/gate-b.ts
import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { VerificationOutcome } from '../types';

const HEADING = /^##\s*Swarm\s+Review\s*\(Gate\s*B\)/im;
const RESULT_LINE = /Result:\s*(passed|advisory|blocked|failed)/i;
const REVIEWERS_LINE = /Reviewers:\s*(\d+)/i;

export async function extractGateBOutcome(
  octokit: Octokit,
  repo: string,
  issueNumber: number,
): Promise<VerificationOutcome | null> {
  const [owner, name] = repo.split('/');
  type C = { body?: string | null; html_url: string; created_at?: string };
  const comments = (await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo: name,
    issue_number: issueNumber,
    per_page: 100,
  })) as C[];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body ?? '';
    if (!HEADING.test(body)) continue;
    const result = body.match(RESULT_LINE)?.[1]?.toLowerCase() ?? 'passed';
    const reviewers = parseInt(body.match(REVIEWERS_LINE)?.[1] ?? '0', 10);
    const status = result === 'passed' ? 'passed' : (result as 'advisory' | 'blocked' | 'failed');
    return {
      feature_id: issueNumber,
      repo,
      pillar: 'gate_b',
      status,
      summary: `${reviewers} reviewer${reviewers === 1 ? '' : 's'}`,
      details_url: comments[i].html_url,
      ran_at: comments[i].created_at ?? new Date().toISOString(),
    };
  }
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/lib/verification/extractors/gate-b.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/verification/extractors/gate-b.ts dashboard/__tests__/lib/verification/extractors/gate-b.test.ts
git commit -m "feat(dashboard): Gate B reviewer outcome extractor"
```

---

### Task 1.7: Pillar 2 EvidenceBundle extractor

**Files:**
- Create: `dashboard/lib/verification/extractors/evidence.ts`
- Test: `dashboard/__tests__/lib/verification/extractors/evidence.test.ts`

The EvidenceBundle freeze is uploaded as a workflow-run artifact (or linked in a comment via heading `## Evidence Bundle (Pillar 2)`).

- [ ] **Step 1: Investigation**

```bash
grep -rn "Evidence Bundle\|Pillar 2\|evidence-bundle\|EvidenceBundle\|evidence_bundle" /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/.github/workflows /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/lib /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/prompts | head -20
```

- [ ] **Step 2: Write the failing test**

```typescript
// dashboard/__tests__/lib/verification/extractors/evidence.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractEvidenceOutcome } from '@/lib/verification/extractors/evidence';

function mkOctokit(comments: Array<{ body: string; html_url: string; created_at?: string }>) {
  return {
    issues: { listComments: vi.fn() },
    paginate: vi.fn(async () => comments),
  } as unknown as Parameters<typeof extractEvidenceOutcome>[0];
}

describe('extractEvidenceOutcome (Pillar 2)', () => {
  it('returns null without an evidence bundle comment', async () => {
    const oct = mkOctokit([{ body: 'x', html_url: 'y' }]);
    expect(await extractEvidenceOutcome(oct, 'a/b', 1)).toBeNull();
  });

  it('returns passed and exposes the artifact URL', async () => {
    const body = '## Evidence Bundle (Pillar 2)\n\nFrozen at: https://example/artifact.json';
    const oct = mkOctokit([{ body, html_url: 'https://example/comment' }]);
    const out = await extractEvidenceOutcome(oct, 'a/b', 1);
    expect(out?.status).toBe('passed');
    expect(out?.details_url).toBe('https://example/artifact.json');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/lib/verification/extractors/evidence.test.ts`
Expected: FAIL.

- [ ] **Step 4: Write minimal implementation**

```typescript
// dashboard/lib/verification/extractors/evidence.ts
import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { VerificationOutcome } from '../types';

const HEADING = /^##\s*Evidence\s+Bundle\s*\(Pillar\s*2\)/im;
const URL_LINE = /Frozen at:\s*(\S+)/i;

export async function extractEvidenceOutcome(
  octokit: Octokit,
  repo: string,
  issueNumber: number,
): Promise<VerificationOutcome | null> {
  const [owner, name] = repo.split('/');
  type C = { body?: string | null; html_url: string; created_at?: string };
  const comments = (await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo: name,
    issue_number: issueNumber,
    per_page: 100,
  })) as C[];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body ?? '';
    if (!HEADING.test(body)) continue;
    const artifactUrl = body.match(URL_LINE)?.[1] ?? comments[i].html_url;
    return {
      feature_id: issueNumber,
      repo,
      pillar: 'evidence_p2',
      status: 'passed',
      summary: 'Evidence frozen',
      details_url: artifactUrl,
      ran_at: comments[i].created_at ?? new Date().toISOString(),
    };
  }
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/lib/verification/extractors/evidence.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/verification/extractors/evidence.ts dashboard/__tests__/lib/verification/extractors/evidence.test.ts
git commit -m "feat(dashboard): Pillar 2 EvidenceBundle outcome extractor"
```

---

### Task 1.8: Aggregator — combine extractors + rollup + cache

**Files:**
- Create: `dashboard/lib/verification/aggregate.ts`
- Test: `dashboard/__tests__/lib/verification/aggregate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/__tests__/lib/verification/aggregate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clearCache } from '@/lib/verification/cache';
import {
  outcomesForFeature,
  rollup,
  type AggregatorDeps,
} from '@/lib/verification/aggregate';
import type { VerificationOutcome } from '@/lib/verification/types';

beforeEach(() => clearCache());

const passed = (pillar: VerificationOutcome['pillar']): VerificationOutcome => ({
  feature_id: 1,
  repo: 'a/b',
  pillar,
  status: 'passed',
  summary: 'ok',
  details_url: 'x',
  ran_at: '2026-05-09T10:00:00Z',
});

describe('outcomesForFeature', () => {
  it('returns one outcome per pillar that produced one', async () => {
    const deps: AggregatorDeps = {
      extractGateB: vi.fn().mockResolvedValue(passed('gate_b')),
      extractAudit: vi.fn().mockResolvedValue(passed('audit_p4')),
      extractRisk: vi.fn().mockResolvedValue(null),
      extractSmoke: vi.fn().mockResolvedValue(passed('smoke_p7')),
      extractEvidence: vi.fn().mockResolvedValue(null),
    };
    const out = await outcomesForFeature({} as never, 'a/b', 1, deps);
    expect(out.map((o) => o.pillar).sort()).toEqual(['audit_p4', 'gate_b', 'smoke_p7']);
  });
});

describe('rollup', () => {
  it('counts shipped, audit-caught, risk-flagged, smoke-failed', () => {
    const r = rollup(
      [
        passed('gate_b'),
        { ...passed('audit_p4'), status: 'advisory' },
        { ...passed('risk_p5'), status: 'advisory' },
        { ...passed('smoke_p7'), status: 'failed' },
      ],
      { window_days: 7, shipped_count: 12, total_cost_usd: 4.2 },
    );
    expect(r).toMatchObject({
      window_days: 7,
      shipped_count: 12,
      audit_caught_count: 1,
      risk_flagged_count: 1,
      smoke_failed_count: 1,
      total_cost_usd: 4.2,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/lib/verification/aggregate.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// dashboard/lib/verification/aggregate.ts
import 'server-only';
import type { Octokit } from '@octokit/rest';
import { extractAuditOutcome } from './extractors/audit';
import { extractRiskOutcome } from './extractors/risk';
import { extractSmokeOutcome } from './extractors/smoke';
import { extractGateBOutcome } from './extractors/gate-b';
import { extractEvidenceOutcome } from './extractors/evidence';
import type { VerificationOutcome, VerificationRollup } from './types';

export type AggregatorDeps = {
  extractGateB: typeof extractGateBOutcome;
  extractAudit: typeof extractAuditOutcome;
  extractRisk: typeof extractRiskOutcome;
  extractSmoke: typeof extractSmokeOutcome;
  extractEvidence: typeof extractEvidenceOutcome;
};

const DEFAULT_DEPS: AggregatorDeps = {
  extractGateB: extractGateBOutcome,
  extractAudit: extractAuditOutcome,
  extractRisk: extractRiskOutcome,
  extractSmoke: extractSmokeOutcome,
  extractEvidence: extractEvidenceOutcome,
};

export async function outcomesForFeature(
  octokit: Octokit,
  repo: string,
  issueNumber: number,
  deps: AggregatorDeps = DEFAULT_DEPS,
): Promise<VerificationOutcome[]> {
  const results = await Promise.all([
    deps.extractGateB(octokit, repo, issueNumber),
    deps.extractAudit(octokit, repo, issueNumber),
    deps.extractRisk(octokit, repo, issueNumber),
    deps.extractSmoke(octokit, repo, issueNumber),
    deps.extractEvidence(octokit, repo, issueNumber),
  ]);
  return results.filter((r): r is VerificationOutcome => r !== null);
}

export function rollup(
  outcomes: VerificationOutcome[],
  base: { window_days: number; shipped_count: number; total_cost_usd: number },
): VerificationRollup {
  return {
    window_days: base.window_days,
    generated_at: new Date().toISOString(),
    shipped_count: base.shipped_count,
    audit_caught_count: outcomes.filter(
      (o) => o.pillar === 'audit_p4' && (o.status === 'advisory' || o.status === 'blocked'),
    ).length,
    risk_flagged_count: outcomes.filter(
      (o) => o.pillar === 'risk_p5' && (o.status === 'advisory' || o.status === 'blocked'),
    ).length,
    smoke_failed_count: outcomes.filter(
      (o) => o.pillar === 'smoke_p7' && o.status === 'failed',
    ).length,
    total_cost_usd: base.total_cost_usd,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/lib/verification/aggregate.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/verification/aggregate.ts dashboard/__tests__/lib/verification/aggregate.test.ts
git commit -m "feat(dashboard): verification aggregator + rollup"
```

---

### Step 1 final verify

- [ ] Run full unit suite

```bash
cd dashboard && npm test -- __tests__/lib/verification
```

Expected: all verification tests PASS, no warnings.

- [ ] Typecheck

```bash
cd dashboard && npm run typecheck
```

Expected: no errors.

---

## Step 2 — Pure UI components

Components are built in isolation with @testing-library/react. They have no GitHub dependency — they take typed props and render.

### Task 2.1: `<EmptyState>` component

**Files:**
- Create: `dashboard/components/empty-state.tsx`
- Test: `dashboard/__tests__/components/empty-state.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/__tests__/components/empty-state.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '@/components/empty-state';

describe('<EmptyState>', () => {
  it('renders title and body', () => {
    render(<EmptyState title="No items" body="Nothing here yet" />);
    expect(screen.getByText('No items')).toBeInTheDocument();
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });
  it('renders the optional CTA link', () => {
    render(<EmptyState title="No repos" body="Wire one up" cta={{ label: 'Wire up', href: '/repos' }} />);
    expect(screen.getByRole('link', { name: /wire up/i })).toHaveAttribute('href', '/repos');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/components/empty-state.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```tsx
// dashboard/components/empty-state.tsx
import Link from 'next/link';

export function EmptyState({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta?: { label: string; href: string };
}) {
  return (
    <div className="rounded-md border border-dashed border-border bg-card p-6 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      {cta ? (
        <div className="mt-3">
          <Link
            href={cta.href}
            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            {cta.label}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/components/empty-state.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/empty-state.tsx dashboard/__tests__/components/empty-state.test.tsx
git commit -m "feat(dashboard): EmptyState reusable component"
```

---

### Task 2.2: `<VerificationBadges>` component

**Files:**
- Create: `dashboard/components/verification-badges.tsx`
- Test: `dashboard/__tests__/components/verification-badges.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/__tests__/components/verification-badges.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerificationBadges } from '@/components/verification-badges';
import type { VerificationOutcome } from '@/lib/verification/types';

const ok = (pillar: VerificationOutcome['pillar'], status: VerificationOutcome['status'], summary = 'ok'): VerificationOutcome => ({
  feature_id: 1,
  repo: 'a/b',
  pillar,
  status,
  summary,
  details_url: 'https://example/x',
  ran_at: '2026-05-09T10:00:00Z',
});

describe('<VerificationBadges>', () => {
  it('renders nothing when given an empty list', () => {
    const { container } = render(<VerificationBadges outcomes={[]} />);
    expect(container.querySelector('a, span')).toBeNull();
  });

  it('renders one chip per outcome with the pillar label', () => {
    render(
      <VerificationBadges outcomes={[ok('gate_b', 'passed', '3 reviewers'), ok('audit_p4', 'advisory', '2 issues')]} />,
    );
    expect(screen.getByText(/Gate B/)).toBeInTheDocument();
    expect(screen.getByText(/3 reviewers/)).toBeInTheDocument();
    expect(screen.getByText(/Audit \(Pillar 4\)/)).toBeInTheDocument();
    expect(screen.getByText(/2 issues/)).toBeInTheDocument();
  });

  it('chips link to the deep-link URL with the pillar param', () => {
    render(
      <VerificationBadges
        outcomes={[ok('smoke_p7', 'failed', 'Smoke failed')]}
        featureHref="/features/142?repo=a%2Fb"
      />,
    );
    const link = screen.getByRole('link', { name: /Smoke/ });
    expect(link.getAttribute('href')).toContain('tab=verification');
    expect(link.getAttribute('href')).toContain('pillar=smoke_p7');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/components/verification-badges.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```tsx
// dashboard/components/verification-badges.tsx
import Link from 'next/link';
import { PILLAR_LABELS, type VerificationOutcome, type PillarStatus } from '@/lib/verification/types';

const STATUS_CLASSES: Record<PillarStatus, string> = {
  passed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  advisory: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  blocked: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  failed: 'bg-destructive/15 text-destructive',
  not_run: 'bg-muted text-muted-foreground',
};

const STATUS_ICON: Record<PillarStatus, string> = {
  passed: '✓',
  advisory: '⚠',
  blocked: '⚠',
  failed: '✗',
  not_run: '·',
};

function deepLink(featureHref: string | undefined, pillar: string): string {
  if (!featureHref) return '#';
  const sep = featureHref.includes('?') ? '&' : '?';
  return `${featureHref}${sep}tab=verification&pillar=${encodeURIComponent(pillar)}`;
}

export function VerificationBadges({
  outcomes,
  featureHref,
}: {
  outcomes: VerificationOutcome[];
  /** When set, each chip links to /features/[issue]?...&tab=verification&pillar=<id> */
  featureHref?: string;
}) {
  if (outcomes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {outcomes.map((o) => {
        const cls = `inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[o.status]}`;
        const content = (
          <>
            <span aria-hidden>{STATUS_ICON[o.status]}</span>
            <span>{PILLAR_LABELS[o.pillar]}</span>
            {o.summary ? <span className="opacity-80">— {o.summary}</span> : null}
          </>
        );
        return featureHref ? (
          <Link
            key={`${o.pillar}-${o.feature_id}`}
            href={deepLink(featureHref, o.pillar)}
            className={cls}
            title={`${PILLAR_LABELS[o.pillar]}: ${o.summary}`}
          >
            {content}
          </Link>
        ) : (
          <span key={`${o.pillar}-${o.feature_id}`} className={cls}>
            {content}
          </span>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/components/verification-badges.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/verification-badges.tsx dashboard/__tests__/components/verification-badges.test.tsx
git commit -m "feat(dashboard): VerificationBadges chip strip — eight-surface component"
```

---

### Task 2.3: `<FeatureCard>` component

**Files:**
- Create: `dashboard/components/feature-card.tsx`
- Test: `dashboard/__tests__/components/feature-card.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/__tests__/components/feature-card.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeatureCard } from '@/components/feature-card';

describe('<FeatureCard>', () => {
  const base = {
    repo: 'a/b',
    issue_number: 42,
    title: 'add refund button',
    state: 'state:implementing' as const,
    age_seconds: 3600,
    outcomes: [],
  };

  it('renders the title and repo', () => {
    render(<FeatureCard item={base} />);
    expect(screen.getByText('add refund button')).toBeInTheDocument();
    expect(screen.getByText(/a\/b/)).toBeInTheDocument();
  });

  it('shows the state pill', () => {
    render(<FeatureCard item={base} />);
    expect(screen.getByText(/implementing/)).toBeInTheDocument();
  });

  it('shows verification badges when outcomes present', () => {
    render(
      <FeatureCard
        item={{
          ...base,
          outcomes: [
            {
              feature_id: 42,
              repo: 'a/b',
              pillar: 'gate_b',
              status: 'passed',
              summary: '3 reviewers',
              details_url: 'x',
              ran_at: '2026-05-09T10:00:00Z',
            },
          ],
        }}
      />,
    );
    expect(screen.getByText(/Gate B/)).toBeInTheDocument();
  });

  it('links the title to /features/[issue]', () => {
    render(<FeatureCard item={base} />);
    const link = screen.getByRole('link', { name: /add refund button/ });
    expect(link.getAttribute('href')).toContain('/features/42');
    expect(link.getAttribute('href')).toContain('repo=a%2Fb');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/components/feature-card.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```tsx
// dashboard/components/feature-card.tsx
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { VerificationBadges } from '@/components/verification-badges';
import type { VerificationOutcome } from '@/lib/verification/types';
import type { StateLabel } from '@/lib/pipeline';

export type FeatureCardItem = {
  repo: string;
  issue_number: number;
  title: string;
  state: StateLabel;
  age_seconds: number;
  outcomes: VerificationOutcome[];
};

function ageLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function FeatureCard({ item, hideRepo = false }: { item: FeatureCardItem; hideRepo?: boolean }) {
  const featureHref = `/features/${item.issue_number}?repo=${encodeURIComponent(item.repo)}`;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge variant="secondary">{item.state.replace('state:', '')}</Badge>
        {hideRepo ? null : <span className="text-xs text-muted-foreground">{item.repo}</span>}
        <span className="text-xs text-muted-foreground">{ageLabel(item.age_seconds)} ago</span>
      </div>
      <Link href={featureHref} className="font-medium hover:underline">
        {item.title}
      </Link>
      <VerificationBadges outcomes={item.outcomes} featureHref={featureHref} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/components/feature-card.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/feature-card.tsx dashboard/__tests__/components/feature-card.test.tsx
git commit -m "feat(dashboard): FeatureCard unified row with verification badges"
```

---

### Task 2.4: `<RepoCard>` component

**Files:**
- Create: `dashboard/components/repo-card.tsx`
- Test: `dashboard/__tests__/components/repo-card.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/__tests__/components/repo-card.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepoCard } from '@/components/repo-card';

describe('<RepoCard>', () => {
  const base = {
    repo: 'qualiency/caliente',
    in_flight_count: 2,
    proposals_count: 5,
    last_shipped_age_seconds: 7200,
    cost_7d_usd: 1.42,
  };

  it('renders the repo name as a link to /repos/[name]', () => {
    render(<RepoCard {...base} />);
    const link = screen.getByRole('link', { name: /qualiency\/caliente/ });
    expect(link.getAttribute('href')).toBe('/repos/qualiency%2Fcaliente');
  });

  it('shows in-flight, proposals, last-shipped, cost', () => {
    render(<RepoCard {...base} />);
    expect(screen.getByText(/2 in flight/i)).toBeInTheDocument();
    expect(screen.getByText(/5 proposal/i)).toBeInTheDocument();
    expect(screen.getByText(/2h ago/)).toBeInTheDocument();
    expect(screen.getByText(/\$1\.42/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/components/repo-card.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```tsx
// dashboard/components/repo-card.tsx
import Link from 'next/link';

function ageLabel(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function RepoCard({
  repo,
  in_flight_count,
  proposals_count,
  last_shipped_age_seconds,
  cost_7d_usd,
}: {
  repo: string;
  in_flight_count: number;
  proposals_count: number;
  last_shipped_age_seconds: number | null;
  cost_7d_usd: number;
}) {
  const href = `/repos/${encodeURIComponent(repo)}`;
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-md border border-border bg-card p-4 hover:bg-accent/30"
    >
      <span className="font-medium">{repo}</span>
      <span className="text-xs text-muted-foreground">
        {in_flight_count} in flight · {proposals_count} proposal{proposals_count === 1 ? '' : 's'}
      </span>
      <span className="text-xs text-muted-foreground">
        last shipped {ageLabel(last_shipped_age_seconds)} · ${cost_7d_usd.toFixed(2)} (7d)
      </span>
    </Link>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/components/repo-card.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/repo-card.tsx dashboard/__tests__/components/repo-card.test.tsx
git commit -m "feat(dashboard): RepoCard for Home Band 7"
```

---

### Task 2.5: `<VerificationPostureStrip>` component

**Files:**
- Create: `dashboard/components/verification-posture-strip.tsx`
- Test: `dashboard/__tests__/components/verification-posture-strip.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/__tests__/components/verification-posture-strip.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VerificationPostureStrip } from '@/components/verification-posture-strip';

describe('<VerificationPostureStrip>', () => {
  it('renders all five metrics for a populated rollup', () => {
    render(
      <VerificationPostureStrip
        rollup={{
          window_days: 7,
          generated_at: '2026-05-09T10:00:00Z',
          shipped_count: 12,
          audit_caught_count: 3,
          risk_flagged_count: 2,
          smoke_failed_count: 1,
          total_cost_usd: 4.2,
        }}
      />,
    );
    expect(screen.getByText(/12 features shipped/)).toBeInTheDocument();
    expect(screen.getByText(/3 audits caught/)).toBeInTheDocument();
    expect(screen.getByText(/2 risk-flagged/)).toBeInTheDocument();
    expect(screen.getByText(/1 smoke check failed/)).toBeInTheDocument();
    expect(screen.getByText(/\$4\.20 spent/)).toBeInTheDocument();
  });

  it('shows the empty-state copy when nothing has been verified yet', () => {
    render(
      <VerificationPostureStrip
        rollup={{
          window_days: 7,
          generated_at: '2026-05-09T10:00:00Z',
          shipped_count: 0,
          audit_caught_count: 0,
          risk_flagged_count: 0,
          smoke_failed_count: 0,
          total_cost_usd: 0,
        }}
      />,
    );
    expect(screen.getByText(/No verification activity yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/components/verification-posture-strip.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```tsx
// dashboard/components/verification-posture-strip.tsx
import type { VerificationRollup } from '@/lib/verification/types';

export function VerificationPostureStrip({ rollup }: { rollup: VerificationRollup }) {
  const isEmpty =
    rollup.shipped_count === 0 &&
    rollup.audit_caught_count === 0 &&
    rollup.risk_flagged_count === 0 &&
    rollup.smoke_failed_count === 0 &&
    rollup.total_cost_usd === 0;
  if (isEmpty) {
    return (
      <div className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
        No verification activity yet — runs will populate this once you ship a feature.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-card p-4 text-sm">
      <span className="font-medium">Last {rollup.window_days} days:</span>{' '}
      {rollup.shipped_count} features shipped ·{' '}
      {rollup.audit_caught_count} audits caught issues fixed pre-merge ·{' '}
      {rollup.risk_flagged_count} risk-flagged for re-review ·{' '}
      {rollup.smoke_failed_count} smoke check{rollup.smoke_failed_count === 1 ? '' : 's'} failed ·{' '}
      ${rollup.total_cost_usd.toFixed(2)} spent
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/components/verification-posture-strip.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/verification-posture-strip.tsx dashboard/__tests__/components/verification-posture-strip.test.tsx
git commit -m "feat(dashboard): VerificationPostureStrip — Home Band 6 / Repo Band 5"
```

---

### Step 2 final verify

- [ ] Run component suite

```bash
cd dashboard && npm test -- __tests__/components/verification-badges __tests__/components/feature-card __tests__/components/repo-card __tests__/components/empty-state __tests__/components/verification-posture-strip
```

Expected: all PASS.

- [ ] Typecheck

```bash
cd dashboard && npm run typecheck
```

Expected: no errors.

---

## Step 3 — Global Home (`/`) redesign

Rebuild `app/page.tsx` as the 7-band command center. One server-side data loader composes everything.

### Task 3.1: home-bands.ts data loader skeleton

**Files:**
- Create: `dashboard/lib/dashboard/home-bands.ts`
- Test: `dashboard/__tests__/lib/dashboard/home-bands.test.ts`

The loader exposes one function per band so the page can `Promise.all` them.

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/__tests__/lib/dashboard/home-bands.test.ts
import { describe, it, expect } from 'vitest';
import {
  type HeroBand,
  type RepoSummary,
  buildHero,
} from '@/lib/dashboard/home-bands';
import type { RepoInfo } from '@/lib/repos';

const wired = (owner: string, name: string): RepoInfo => ({
  owner,
  name,
  default_branch: 'main',
  wired_up: true,
  html_url: `https://github.com/${owner}/${name}`,
  description: null,
});

describe('buildHero', () => {
  it('returns wired-state copy when at least one repo is wired', () => {
    const h: HeroBand = buildHero(
      [wired('a', 'b'), wired('a', 'c')],
      { needs_action_count: 2, in_motion_count: 1 },
    );
    expect(h.state).toBe('wired');
    expect(h.message).toMatch(/2 things need you/);
    expect(h.message).toMatch(/1 in motion/);
    expect(h.message).toMatch(/2 repos/);
  });

  it('returns empty-state copy when no repos are wired', () => {
    const h: HeroBand = buildHero([], { needs_action_count: 0, in_motion_count: 0 });
    expect(h.state).toBe('empty');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/lib/dashboard/home-bands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```typescript
// dashboard/lib/dashboard/home-bands.ts
import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { RepoInfo } from '@/lib/repos';
import type { FeatureItem } from '@/lib/pipeline';
import { fetchPipeline, needsActionFilter, isTerminalState } from '@/lib/pipeline';
import { outcomesForFeature, rollup } from '@/lib/verification/aggregate';
import type { VerificationOutcome, VerificationRollup } from '@/lib/verification/types';

export type HeroBand =
  | { state: 'empty'; message: string }
  | { state: 'wired'; message: string; repo_count: number };

export type RepoSummary = {
  repo: string;
  in_flight_count: number;
  proposals_count: number; // populated 0 in v1; scout-per-repo wiring is a follow-up
  last_shipped_age_seconds: number | null;
  cost_7d_usd: number; // populated 0 in v1; cost-per-repo aggregation is a follow-up
};

export function buildHero(
  wired: RepoInfo[],
  counts: { needs_action_count: number; in_motion_count: number },
): HeroBand {
  if (wired.length === 0) {
    return { state: 'empty', message: 'Welcome to dev-agent' };
  }
  return {
    state: 'wired',
    repo_count: wired.length,
    message: `Good morning. dev-agent is watching ${wired.length} repo${wired.length === 1 ? '' : 's'}. ${counts.needs_action_count} thing${counts.needs_action_count === 1 ? '' : 's'} need${counts.needs_action_count === 1 ? 's' : ''} you, ${counts.in_motion_count} in motion.`,
  };
}

const IN_MOTION_STATES = new Set([
  'state:scoping',
  'state:acm-building',
  'state:implementing',
  'state:swarm-reviewing',
  'state:staging-deployed',
  'state:tier2-smoke',
  'state:promoting',
]);

export function partitionPipeline(items: FeatureItem[]) {
  const needsAction = items.filter(needsActionFilter);
  const inMotion = items.filter((i) => IN_MOTION_STATES.has(i.state));
  const recentlyShipped = items.filter(
    (i) => i.state === 'state:done' && i.age_seconds <= 7 * 24 * 3600,
  );
  return { needsAction, inMotion, recentlyShipped };
}

export async function attachOutcomes(
  octokit: Octokit,
  items: FeatureItem[],
): Promise<Array<FeatureItem & { outcomes: VerificationOutcome[] }>> {
  return Promise.all(
    items.map(async (i) => ({
      ...i,
      outcomes: await outcomesForFeature(octokit, i.repo, i.issue_number),
    })),
  );
}

export function buildRepoSummaries(
  wired: RepoInfo[],
  items: FeatureItem[],
): RepoSummary[] {
  return wired.map((r) => {
    const repo = `${r.owner}/${r.name}`;
    const repoItems = items.filter((i) => i.repo === repo);
    const inFlight = repoItems.filter((i) => !isTerminalState(i.state) && !needsActionFilter(i));
    const lastShipped = repoItems
      .filter((i) => i.state === 'state:done')
      .sort((a, b) => a.age_seconds - b.age_seconds)[0];
    return {
      repo,
      in_flight_count: inFlight.length,
      proposals_count: 0,
      last_shipped_age_seconds: lastShipped ? lastShipped.age_seconds : null,
      cost_7d_usd: 0,
    };
  });
}

export async function buildVerificationRollup(
  octokit: Octokit,
  items: FeatureItem[],
  windowDays = 7,
): Promise<VerificationRollup> {
  const recent = items.filter((i) => i.state === 'state:done' && i.age_seconds <= windowDays * 24 * 3600);
  const all: VerificationOutcome[] = (
    await Promise.all(recent.map((i) => outcomesForFeature(octokit, i.repo, i.issue_number)))
  ).flat();
  const totalCost = all.reduce((sum, o) => sum + (o.cost_usd ?? 0), 0);
  return rollup(all, {
    window_days: windowDays,
    shipped_count: recent.length,
    total_cost_usd: totalCost,
  });
}

export async function loadHomeBands(octokit: Octokit, wired: RepoInfo[]) {
  const items = await fetchPipeline(octokit, wired, { include_terminal: true });
  const { needsAction, inMotion, recentlyShipped } = partitionPipeline(items);
  const [needsActionWithOutcomes, inMotionWithOutcomes, recentWithOutcomes, postureRollup] =
    await Promise.all([
      attachOutcomes(octokit, needsAction.slice(0, 5)),
      attachOutcomes(octokit, inMotion.slice(0, 5)),
      attachOutcomes(octokit, recentlyShipped.slice(0, 5)),
      buildVerificationRollup(octokit, items),
    ]);
  const hero = buildHero(wired, {
    needs_action_count: needsAction.length,
    in_motion_count: inMotion.length,
  });
  const repoSummaries = buildRepoSummaries(wired, items);
  return {
    hero,
    needsAction: needsActionWithOutcomes,
    inMotion: inMotionWithOutcomes,
    recentlyShipped: recentWithOutcomes,
    posture: postureRollup,
    repoSummaries,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/lib/dashboard/home-bands.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/dashboard/home-bands.ts dashboard/__tests__/lib/dashboard/home-bands.test.ts
git commit -m "feat(dashboard): home-bands loader — partitioning + outcomes + rollup"
```

---

### Task 3.2: Rebuild `app/page.tsx` as the 7-band Home

**Files:**
- Modify: `dashboard/app/page.tsx`

This task wires up the full Home page. No new test (rendering tests for individual bands are covered by component tests; an E2E smoke test comes in Task 6.5).

- [ ] **Step 1: Replace `app/page.tsx` content**

```tsx
// dashboard/app/page.tsx
import Link from 'next/link';
import { getOctokit } from '@/lib/gh';
import { listAllowedRepos, wiredRepos } from '@/lib/repos';
import { runAllScouts } from '@/lib/scout';
import { loadHomeBands } from '@/lib/dashboard/home-bands';
import { Button } from '@/components/ui/button';
import { FeatureCard } from '@/components/feature-card';
import { RepoCard } from '@/components/repo-card';
import { VerificationPostureStrip } from '@/components/verification-posture-strip';
import { EmptyState } from '@/components/empty-state';

export default async function HomePage() {
  const octokit = await getOctokit();
  const repos = await listAllowedRepos(octokit);
  const wired = wiredRepos(repos);

  if (wired.length === 0) {
    return (
      <div className="mx-auto max-w-2xl py-12 text-center">
        <h1 className="mb-2 text-2xl font-semibold">Welcome to dev-agent</h1>
        <p className="mb-6 text-muted-foreground">
          {repos.length === 0
            ? "We don't see any GitHub repos for your account yet. Make sure your token includes the repo scope."
            : `You have ${repos.length} repo${repos.length === 1 ? '' : 's'} accessible, but none are wired up to dev-agent yet.`}
        </p>
        <Link
          href="/repos"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {repos.length === 0 ? 'See my repos' : 'Wire up your first repo'}
        </Link>
      </div>
    );
  }

  const [bands, proposals] = await Promise.all([
    loadHomeBands(octokit, wired),
    runAllScouts(octokit, wired).catch(() => []),
  ]);
  const topProposals = proposals.slice(0, 5);

  return (
    <div className="flex flex-col gap-10">
      {/* Band 1 — Hero */}
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold">Home</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {bands.hero.state === 'wired' ? bands.hero.message : ''}
          </p>
        </div>
        <Link href="/intent">
          <Button size="lg">Brainstorm new work</Button>
        </Link>
      </section>

      {/* Band 2 — Needs you */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Needs you now</h2>
        {bands.needsAction.length === 0 ? (
          <EmptyState title="Nothing waiting on you — nice." body="" />
        ) : (
          <div className="flex flex-col gap-2">
            {bands.needsAction.map((i) => (
              <FeatureCard key={`${i.repo}#${i.issue_number}`} item={i} />
            ))}
          </div>
        )}
      </section>

      {/* Band 3 — In motion */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">In motion</h2>
        {bands.inMotion.length === 0 ? (
          <EmptyState
            title="No active runs."
            body="Start one with Brainstorm new work or pick from PM proposes below."
            cta={{ label: 'Brainstorm', href: '/intent' }}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {bands.inMotion.map((i) => (
              <FeatureCard key={`${i.repo}#${i.issue_number}`} item={i} />
            ))}
          </div>
        )}
      </section>

      {/* Band 4 — Recently shipped */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Recently shipped (last 7d)</h2>
        {bands.recentlyShipped.length === 0 ? (
          <EmptyState
            title="No features shipped in the last 7 days."
            body="Once a feature merges, it lands here with verification badges."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {bands.recentlyShipped.map((i) => (
              <FeatureCard key={`${i.repo}#${i.issue_number}`} item={i} />
            ))}
          </div>
        )}
      </section>

      {/* Band 5 — PM proposes */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">PM proposes</h2>
          <Link href="/proposals" className="text-sm underline">
            See all ({proposals.length})
          </Link>
        </div>
        {topProposals.length === 0 ? (
          <EmptyState
            title="PM has nothing to suggest."
            body="Either you're caught up, or no scout sources are wired yet."
          />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {topProposals.map((p) => (
              <li key={p.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{p.source}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{p.repo}</span>
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="mt-1 block font-medium hover:underline">
                    {p.title}
                  </a>
                </div>
                <Link
                  href={`/intent?repo=${encodeURIComponent(p.repo)}&prefill=${encodeURIComponent(p.title)}`}
                  className="text-sm underline"
                >
                  Discuss with PM
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Band 6 — Verification posture */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Verification posture</h2>
        <VerificationPostureStrip rollup={bands.posture} />
      </section>

      {/* Band 7 — Repo summary cards */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Your repos</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {bands.repoSummaries.map((s) => (
            <RepoCard key={s.repo} {...s} />
          ))}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke (dev server)**

```bash
cd dashboard && npm run dev
```

Open `http://localhost:3000`. Sign in. Confirm:
- Hero shows "Good morning…" with correct counts.
- Each band renders (with empty-state copy where empty).
- Verification chips appear on shipped features (if any pillar has run).
- Repo cards link correctly to `/repos/[name]`.

- [ ] **Step 4: Commit**

```bash
git add dashboard/app/page.tsx
git commit -m "feat(dashboard): rebuild Home as 7-band command center"
```

---

### Step 3 final verify

- [ ] All home-related tests still pass

```bash
cd dashboard && npm test -- __tests__/lib/dashboard __tests__/components
```

Expected: all PASS.

- [ ] Typecheck

```bash
cd dashboard && npm run typecheck
```

Expected: no errors.

---

## Step 4 — Per-repo workspace (`/repos/[name]`) redesign

Same band logic as Home, scoped to one repo. Preserves the existing scan / scout / schedule panels by moving them into Band 7 (Settings).

### Task 4.1: repo-workspace.ts data loader

**Files:**
- Create: `dashboard/lib/dashboard/repo-workspace.ts`
- Test: `dashboard/__tests__/lib/dashboard/repo-workspace.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// dashboard/__tests__/lib/dashboard/repo-workspace.test.ts
import { describe, it, expect } from 'vitest';
import { partitionRepoPipeline, configuredPillars } from '@/lib/dashboard/repo-workspace';
import type { FeatureItem } from '@/lib/pipeline';

const item = (state: FeatureItem['state'], age: number): FeatureItem => ({
  repo: 'a/b',
  issue_number: Math.floor(Math.random() * 1000),
  title: 't',
  state,
  age_seconds: age,
  last_telemetry: null,
  blockers: [],
  html_url: 'x',
});

describe('partitionRepoPipeline', () => {
  it('splits items into in-flight, recently-shipped (14d), and other', () => {
    const items = [
      item('state:implementing', 1000),
      item('state:done', 3 * 24 * 3600),
      item('state:done', 30 * 24 * 3600),
    ];
    const p = partitionRepoPipeline(items);
    expect(p.inFlight.length).toBe(1);
    expect(p.recentlyShipped.length).toBe(1);
  });
});

describe('configuredPillars', () => {
  it('marks gate_b, audit_p4, evidence_p2 as universal', () => {
    const pillars = configuredPillars({ workflows: [] });
    expect(pillars.gate_b).toBe(true);
    expect(pillars.audit_p4).toBe(true);
    expect(pillars.evidence_p2).toBe(true);
  });

  it('marks risk_p5 as opt-in based on workflow presence', () => {
    expect(configuredPillars({ workflows: [] }).risk_p5).toBe(false);
    expect(
      configuredPillars({ workflows: ['.github/workflows/dev-agent-risk-audit.yml'] }).risk_p5,
    ).toBe(true);
  });

  it('marks smoke_p7 as opt-in based on workflow presence', () => {
    expect(configuredPillars({ workflows: [] }).smoke_p7).toBe(false);
    expect(
      configuredPillars({ workflows: ['.github/workflows/dev-agent-tier2-smoke.yml'] }).smoke_p7,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/lib/dashboard/repo-workspace.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```typescript
// dashboard/lib/dashboard/repo-workspace.ts
import 'server-only';
import type { Octokit } from '@octokit/rest';
import type { RepoInfo } from '@/lib/repos';
import type { FeatureItem } from '@/lib/pipeline';
import { isTerminalState, fetchPipeline } from '@/lib/pipeline';
import { attachOutcomes, buildVerificationRollup } from './home-bands';
import type { PillarId } from '@/lib/verification/types';

const RISK_WORKFLOW = '.github/workflows/dev-agent-risk-audit.yml';
const SMOKE_WORKFLOW = '.github/workflows/dev-agent-tier2-smoke.yml';

export function partitionRepoPipeline(items: FeatureItem[]) {
  const inFlight = items.filter((i) => !isTerminalState(i.state));
  const recentlyShipped = items.filter(
    (i) => i.state === 'state:done' && i.age_seconds <= 14 * 24 * 3600,
  );
  return { inFlight, recentlyShipped };
}

export function configuredPillars(opts: { workflows: string[] }): Record<PillarId, boolean> {
  return {
    gate_b: true,
    audit_p4: true,
    evidence_p2: true,
    risk_p5: opts.workflows.includes(RISK_WORKFLOW),
    smoke_p7: opts.workflows.includes(SMOKE_WORKFLOW),
  };
}

async function fetchRepoWorkflows(
  octokit: Octokit,
  owner: string,
  name: string,
  ref: string,
): Promise<string[]> {
  try {
    const resp = await octokit.repos.getContent({ owner, repo: name, path: '.github/workflows', ref });
    const data = resp.data;
    if (Array.isArray(data)) {
      return data.filter((d) => d.type === 'file').map((d) => `.github/workflows/${d.name}`);
    }
    return [];
  } catch {
    return [];
  }
}

export async function loadRepoWorkspace(octokit: Octokit, repo: RepoInfo) {
  const items = await fetchPipeline(octokit, [repo], { include_terminal: true });
  const { inFlight, recentlyShipped } = partitionRepoPipeline(items);
  const [inFlightOutcomes, recentOutcomes, posture, workflows] = await Promise.all([
    attachOutcomes(octokit, inFlight.slice(0, 10)),
    attachOutcomes(octokit, recentlyShipped.slice(0, 10)),
    buildVerificationRollup(octokit, items),
    fetchRepoWorkflows(octokit, repo.owner, repo.name, repo.default_branch),
  ]);
  return {
    inFlight: inFlightOutcomes,
    recentlyShipped: recentOutcomes,
    posture,
    pillars: configuredPillars({ workflows }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/lib/dashboard/repo-workspace.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/dashboard/repo-workspace.ts dashboard/__tests__/lib/dashboard/repo-workspace.test.ts
git commit -m "feat(dashboard): repo-workspace loader — partition + configured pillars"
```

---

### Task 4.2: Rebuild `app/repos/[name]/page.tsx` as 7-band workspace

**Files:**
- Modify: `dashboard/app/repos/[name]/page.tsx`

Preserves the existing scan / scout / schedule panels by relocating them under Band 7 (Settings).

- [ ] **Step 1: Replace `app/repos/[name]/page.tsx` content**

```tsx
// dashboard/app/repos/[name]/page.tsx
import Link from 'next/link';
import { getOctokit } from '@/lib/gh';
import { listAllowedRepos } from '@/lib/repos';
import { loadRepoWorkspace } from '@/lib/dashboard/repo-workspace';
import { runAllScouts } from '@/lib/scout';
import { readBugScoutSchedule } from '@/lib/bug-scout-schedule';
import { Button } from '@/components/ui/button';
import { FeatureCard } from '@/components/feature-card';
import { VerificationPostureStrip } from '@/components/verification-posture-strip';
import { EmptyState } from '@/components/empty-state';
import { BugScoutScheduleForm } from '@/components/bug-scout-schedule-form';
import { ScanWithPmButton } from '@/components/scan-with-pm-button';
import { ScanCleanupButton } from '@/components/scan-cleanup-button';
import { PILLAR_LABELS } from '@/lib/verification/types';

const UNFINISHED_WORK_WORKFLOW_PATH = '.github/workflows/dev-agent-unfinished-work-scout.yml';
const CLEANUP_WORKFLOW_PATH = '.github/workflows/dev-agent-cleanup-scout.yml';

async function isWorkflowInstalled(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string,
  default_branch: string,
  path: string,
): Promise<boolean> {
  try {
    await octokit.repos.getContent({ owner, repo, path, ref: default_branch });
    return true;
  } catch {
    return false;
  }
}

export default async function RepoPage(props: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await props.params;
  const name = decodeURIComponent(rawName);
  const octokit = await getOctokit();
  const allRepos = await listAllowedRepos(octokit);
  const repo = allRepos.find((r) => `${r.owner}/${r.name}` === name);
  if (!repo) return <p className="text-muted-foreground">Repo not found in allowlist.</p>;

  const [workspace, proposals, scheduleSnapshot, unfinishedWorkInstalled, cleanupInstalled] =
    await Promise.all([
      loadRepoWorkspace(octokit, repo),
      runAllScouts(octokit, [repo]).catch(() => []),
      repo.wired_up
        ? readBugScoutSchedule(octokit, repo.owner, repo.name, repo.default_branch).catch(() => null)
        : Promise.resolve(null),
      repo.wired_up
        ? isWorkflowInstalled(octokit, repo.owner, repo.name, repo.default_branch, UNFINISHED_WORK_WORKFLOW_PATH)
        : Promise.resolve(false),
      repo.wired_up
        ? isWorkflowInstalled(octokit, repo.owner, repo.name, repo.default_branch, CLEANUP_WORKFLOW_PATH)
        : Promise.resolve(false),
    ]);

  return (
    <div className="flex flex-col gap-10">
      {/* Band 1 — Repo header */}
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{name}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {repo.wired_up ? 'Wired ✓' : 'Not wired'} · default branch {repo.default_branch} ·{' '}
            <a href={repo.html_url} target="_blank" rel="noreferrer noopener" className="underline">
              GitHub
            </a>
          </p>
        </div>
        <Link href={`/intent?repo=${encodeURIComponent(name)}`}>
          <Button size="lg">Brainstorm new work on {name}</Button>
        </Link>
      </section>

      {/* Band 2 — In flight */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">In flight</h2>
        {workspace.inFlight.length === 0 ? (
          <EmptyState title="Nothing in flight on this repo." body="" />
        ) : (
          <div className="flex flex-col gap-2">
            {workspace.inFlight.map((i) => (
              <FeatureCard key={`${i.repo}#${i.issue_number}`} item={i} hideRepo />
            ))}
          </div>
        )}
      </section>

      {/* Band 3 — PM proposes */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">PM proposes</h2>
          <Link href="/proposals" className="text-sm underline">
            See all
          </Link>
        </div>
        {proposals.length === 0 ? (
          <EmptyState title="PM doesn't see anything pressing for this repo right now." body="" />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {proposals.slice(0, 5).map((p) => (
              <li key={p.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{p.source}</span>
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="mt-1 block font-medium hover:underline">
                    {p.title}
                  </a>
                </div>
                <Link
                  href={`/intent?repo=${encodeURIComponent(name)}&prefill=${encodeURIComponent(p.title)}`}
                  className="text-sm underline"
                >
                  Discuss with PM
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Band 4 — Recently shipped */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Recently shipped (last 14d)</h2>
        {workspace.recentlyShipped.length === 0 ? (
          <EmptyState title="No features shipped in the last 14 days." body="" />
        ) : (
          <div className="flex flex-col gap-2">
            {workspace.recentlyShipped.map((i) => (
              <FeatureCard key={`${i.repo}#${i.issue_number}`} item={i} hideRepo />
            ))}
          </div>
        )}
      </section>

      {/* Band 5 — Verification posture for this repo */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Verification posture (this repo)</h2>
        <div className="flex flex-col gap-3">
          <VerificationPostureStrip rollup={workspace.posture} />
          <div className="rounded-md border border-border bg-card p-4 text-sm">
            <p className="mb-2 font-medium">Configured pillars</p>
            <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {(Object.keys(workspace.pillars) as Array<keyof typeof workspace.pillars>).map((p) => (
                <li key={p} className="flex items-center gap-2">
                  <span aria-hidden>{workspace.pillars[p] ? '✓' : '·'}</span>
                  <span className={workspace.pillars[p] ? '' : 'text-muted-foreground'}>
                    {PILLAR_LABELS[p]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Band 6 — Cost (placeholder for v1; per-repo cost band is a follow-up) */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Cost (this repo, last 30d)</h2>
        <Link href={`/cost?repo=${encodeURIComponent(name)}`} className="text-sm underline">
          Open full cost view →
        </Link>
      </section>

      {/* Band 7 — Settings & links */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Settings &amp; links</h2>
        {repo.wired_up ? (
          <div className="flex flex-col gap-6">
            <div className="rounded-md border border-border bg-card p-5">
              <h3 className="mb-1 text-base font-semibold">Scan with PM (deep)</h3>
              <ScanWithPmButton repo={name} workflowPresent={unfinishedWorkInstalled} />
            </div>
            <div className="rounded-md border border-border bg-card p-5">
              <h3 className="mb-1 text-base font-semibold">Cleanup scan</h3>
              <ScanCleanupButton repo={name} workflowPresent={cleanupInstalled} />
            </div>
            {scheduleSnapshot ? (
              <div className="rounded-md border border-border bg-card p-5">
                <h3 className="mb-1 text-base font-semibold">Bug-scout schedule</h3>
                <BugScoutScheduleForm
                  repo={name}
                  current={scheduleSnapshot.preset}
                  currentCron={scheduleSnapshot.cron}
                />
              </div>
            ) : null}
            <div className="rounded-md border border-border bg-card p-5">
              <h3 className="mb-1 text-base font-semibold">Files</h3>
              <ul className="text-sm">
                <li>
                  <a className="underline" href={`${repo.html_url}/blob/${repo.default_branch}/.dev-agent.yml`} target="_blank" rel="noreferrer noopener">
                    .dev-agent.yml
                  </a>
                </li>
                <li>
                  <a className="underline" href={`${repo.html_url}/blob/${repo.default_branch}/.dev-agent/pm.md`} target="_blank" rel="noreferrer noopener">
                    .dev-agent/pm.md
                  </a>
                </li>
                <li>
                  <a className="underline" href={`${repo.html_url}/blob/${repo.default_branch}/.dev-agent/SESSION_LOG.md`} target="_blank" rel="noreferrer noopener">
                    SESSION_LOG.md
                  </a>
                </li>
              </ul>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Repo is not wired up yet.</p>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke**

Visit `/repos/<owner>%2F<name>` for a wired repo. Confirm 7 bands render, scan/scout/schedule preserved under Settings.

- [ ] **Step 4: Commit**

```bash
git add dashboard/app/repos/[name]/page.tsx
git commit -m "feat(dashboard): rebuild Repo Workspace as 7-band page; preserve scan/scout under Settings"
```

---

### Step 4 final verify

- [ ] All tests still pass

```bash
cd dashboard && npm test
```

- [ ] Typecheck

```bash
cd dashboard && npm run typecheck
```

---

## Step 5 — `/features/[issue]` Verification tab

Add a Verification card to `FeatureDetail` showing per-pillar outcomes, support deep-linking via `?tab=verification&pillar=<id>`.

### Task 5.1: Extend `FeatureDetail` with verification props

**Files:**
- Modify: `dashboard/components/feature-detail.tsx`
- Test: `dashboard/__tests__/components/feature-detail.test.tsx` (extend existing)

- [ ] **Step 1: Add a failing test (extend the file)**

Add the import line to the top of `__tests__/components/feature-detail.test.tsx` (alongside the existing imports), and the `describe` block at the bottom of the file:

```tsx
// Add to the top imports section:
import type { VerificationOutcome } from '@/lib/verification/types';

// Add at the bottom of the file:
describe('<FeatureDetail> Verification card', () => {
  const baseProps = {
    repo: 'a/b',
    issue: { number: 42, title: 't', body: '', html_url: 'x', state: 'state:done' },
    telemetry: [],
    prUrl: null,
  };

  const outcome = (pillar: VerificationOutcome['pillar']): VerificationOutcome => ({
    feature_id: 42,
    repo: 'a/b',
    pillar,
    status: 'passed',
    summary: 'ok',
    details_url: 'https://example/x',
    ran_at: '2026-05-09T10:00:00Z',
  });

  it('does not render the Verification card when outcomes are empty', () => {
    render(<FeatureDetail {...baseProps} verification={{ outcomes: [], expandedPillar: null }} />);
    expect(screen.queryByText(/Verification/)).toBeNull();
  });

  it('renders one expandable card per outcome', () => {
    render(
      <FeatureDetail
        {...baseProps}
        verification={{ outcomes: [outcome('gate_b'), outcome('audit_p4')], expandedPillar: null }}
      />,
    );
    expect(screen.getByText(/Gate B/)).toBeInTheDocument();
    expect(screen.getByText(/Audit \(Pillar 4\)/)).toBeInTheDocument();
  });

  it('expands the requested pillar via expandedPillar prop', () => {
    render(
      <FeatureDetail
        {...baseProps}
        verification={{ outcomes: [outcome('smoke_p7')], expandedPillar: 'smoke_p7' }}
      />,
    );
    const details = screen.getByText(/Smoke \(Pillar 7\)/).closest('details');
    expect(details).toHaveAttribute('open');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/components/feature-detail.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Modify `components/feature-detail.tsx`**

Add the Verification card and the optional `verification` prop. Preserve existing telemetry / issue cards exactly as-is.

```tsx
// At top of dashboard/components/feature-detail.tsx, add:
import { PILLAR_LABELS, type PillarId, type VerificationOutcome } from '@/lib/verification/types';

// Extend the props of FeatureDetail (replace the existing signature):
export function FeatureDetail({
  repo,
  issue,
  telemetry,
  prUrl,
  verification,
}: {
  repo: string;
  issue: IssueShape;
  telemetry: ParsedTelemetry[];
  prUrl: string | null;
  verification?: { outcomes: VerificationOutcome[]; expandedPillar: PillarId | null };
}) {
```

Then, before the closing `</div>` of the wrapper, add:

```tsx
      {verification && verification.outcomes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Verification</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              {verification.outcomes.map((o) => (
                <details
                  key={o.pillar}
                  open={verification.expandedPillar === o.pillar}
                  className="rounded border border-border p-3"
                >
                  <summary className="cursor-pointer text-sm font-medium">
                    {PILLAR_LABELS[o.pillar]} — {o.status} — {o.summary}
                  </summary>
                  <div className="mt-2 text-sm text-muted-foreground">
                    Ran at {o.ran_at}.{' '}
                    <a className="underline" href={o.details_url} target="_blank" rel="noreferrer noopener">
                      Open details
                    </a>
                    {typeof o.cost_usd === 'number' ? <> · cost ${o.cost_usd.toFixed(4)}</> : null}
                  </div>
                </details>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/components/feature-detail.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/feature-detail.tsx dashboard/__tests__/components/feature-detail.test.tsx
git commit -m "feat(dashboard): FeatureDetail Verification card with expandable pillar outcomes"
```

---

### Task 5.2: Wire `app/features/[issue]/page.tsx` to fetch outcomes + read deep-link params

**Files:**
- Modify: `dashboard/app/features/[issue]/page.tsx`

- [ ] **Step 1: Modify the page**

At the top, add the import:

```tsx
import { outcomesForFeature } from '@/lib/verification/aggregate';
import { PILLAR_IDS, type PillarId } from '@/lib/verification/types';
```

Extend the page's `searchParams` type (currently `{ repo?: string }`) to also accept `tab` and `pillar`:

```tsx
type SearchParams = Promise<{ repo?: string; tab?: string; pillar?: string }>;
```

In the `Promise.all` block, add `outcomesForFeature` as a parallel fetch:

```tsx
  const [
    { data: issueData },
    commentsResp,
    sessionLog,
    activeRuns,
    failedRuns,
    featurePR,
    outcomes,
  ] = await Promise.all([
    octokit.issues.get({ owner, repo: name, issue_number }),
    octokit.issues.listComments({ owner, repo: name, issue_number, per_page: 100 }),
    fetchSessionLog(octokit, owner, name),
    fetchActiveRunsForIssue(octokit, owner, name, issue_number),
    fetchRecentFailuresForIssue(octokit, owner, name, issue_number),
    fetchFeaturePR(octokit, owner, name, issue_number),
    outcomesForFeature(octokit, `${owner}/${name}`, issue_number),
  ]);
```

After resolving the params, compute the expanded pillar:

```tsx
  const { repo, tab, pillar } = await props.searchParams;
  // ... existing code that uses `repo` ...
  const expandedPillar: PillarId | null =
    tab === 'verification' && pillar && (PILLAR_IDS as readonly string[]).includes(pillar)
      ? (pillar as PillarId)
      : null;
```

Pass to `<FeatureDetail>`:

```tsx
  return (
    <FeatureDetail
      repo={`${owner}/${name}`}
      issue={{ ...issueData, body: issueData.body ?? '', state: stateLabel }}
      telemetry={telemetry}
      prUrl={prUrl}
      verification={{ outcomes, expandedPillar }}
    />
    // ... existing siblings (FeatureTimeline, ActiveRunsPanel, etc.) ...
  );
```

(Keep all existing siblings; just add the `verification` prop to FeatureDetail.)

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke**

Visit `/features/<issue>?repo=<owner>%2F<name>`. Confirm Verification card appears (when at least one pillar has run).
Visit `/features/<issue>?repo=...&tab=verification&pillar=audit_p4`. Confirm the audit pillar card is open by default.

- [ ] **Step 4: Commit**

```bash
git add dashboard/app/features/[issue]/page.tsx
git commit -m "feat(dashboard): /features/[issue] fetches verification outcomes + supports deep-links"
```

---

### Step 5 final verify

- [ ] All tests pass

```bash
cd dashboard && npm test
```

- [ ] Typecheck clean

```bash
cd dashboard && npm run typecheck
```

---

## Step 6 — Nav simplification + help panel + setup checklist

### Task 6.1: Refactor `nav-header.tsx` to 3 primary + secondary

**Files:**
- Modify: `dashboard/components/nav-header.tsx`
- Test: `dashboard/__tests__/components/nav-header.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/__tests__/components/nav-header.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NavLinks } from '@/components/nav-header';

describe('<NavLinks>', () => {
  it('renders 3 primary links: Home, Repos, Brainstorm', () => {
    render(<NavLinks />);
    expect(screen.getByRole('link', { name: /^Home$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Repos$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Brainstorm$/ })).toBeInTheDocument();
  });
  it('renders secondary links (Proposals, Pipeline, Activity, Cost)', () => {
    render(<NavLinks />);
    for (const label of ['Proposals', 'Pipeline', 'Activity', 'Cost']) {
      expect(screen.getByRole('link', { name: new RegExp(`^${label}$`) })).toBeInTheDocument();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/components/nav-header.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Refactor `components/nav-header.tsx`**

Extract a `NavLinks` pure component (so it's testable without `auth()`), and rebuild the nav:

```tsx
// dashboard/components/nav-header.tsx
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { auth, signOut } from '@/lib/auth';

const PRIMARY = [
  { href: '/', label: 'Home' },
  { href: '/repos', label: 'Repos' },
  { href: '/intent', label: 'Brainstorm' },
];

const SECONDARY = [
  { href: '/proposals', label: 'Proposals' },
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/activity', label: 'Activity' },
  { href: '/cost', label: 'Cost' },
];

export function NavLinks() {
  return (
    <nav className="flex flex-wrap items-center gap-4 text-sm">
      {PRIMARY.map((l) => (
        <Link key={l.href} href={l.href} className="font-medium hover:text-foreground">
          {l.label}
        </Link>
      ))}
      <span aria-hidden className="hidden text-border sm:inline">|</span>
      {SECONDARY.map((l) => (
        <Link key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

export async function NavHeader() {
  const session = await auth();
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="font-semibold">
          dev-agent
        </Link>
        <div className="hidden sm:block">
          <NavLinks />
        </div>
        <div className="flex items-center gap-3">
          <Link href="/intent">
            <Button size="sm">Brainstorm new work</Button>
          </Link>
          {session?.user && (
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/auth/signin' });
              }}
            >
              <Button type="submit" variant="ghost" size="sm">
                @{session.user.username}
              </Button>
            </form>
          )}
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/components/nav-header.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/nav-header.tsx dashboard/__tests__/components/nav-header.test.tsx
git commit -m "feat(dashboard): nav simplification — 3 primary + secondary links"
```

---

### Task 6.2: `<HelpPanel>` slide-over (header `?`)

**Files:**
- Create: `dashboard/components/help-panel.tsx`
- Test: `dashboard/__tests__/components/help-panel.test.tsx`

Uses `@radix-ui/react-dialog` (already in deps) for the slide-over.

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/__tests__/components/help-panel.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HelpPanel } from '@/components/help-panel';

describe('<HelpPanel>', () => {
  it('opens when the trigger is clicked and shows the pitch', () => {
    render(<HelpPanel />);
    fireEvent.click(screen.getByRole('button', { name: /help/i }));
    expect(screen.getByText(/dev-agent/i)).toBeInTheDocument();
    expect(screen.getByText(/30 second/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/components/help-panel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```tsx
// dashboard/components/help-panel.tsx
'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';

export function HelpPanel() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          aria-label="Help"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border text-sm hover:bg-accent"
        >
          ?
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 w-full max-w-md overflow-y-auto bg-background p-6 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">About dev-agent</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            A 30 second pitch: dev-agent watches your wired-up repos, lets you brainstorm features
            with a PM agent, ships them through gated phases (spec → PR → promote), and runs
            verification pillars on every change so you can trust what merged.
          </Dialog.Description>
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium">What to do today</h3>
            <ul className="ml-5 list-disc text-sm text-muted-foreground">
              <li>
                Check <Link className="underline" href="/" onClick={() => setOpen(false)}>Home</Link> for what needs you.
              </li>
              <li>
                Open <Link className="underline" href="/intent" onClick={() => setOpen(false)}>Brainstorm</Link> to start something new.
              </li>
            </ul>
          </div>
          <div className="mt-6 flex justify-end">
            <Dialog.Close asChild>
              <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/components/help-panel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into `nav-header.tsx`**

Add the import + render the trigger next to the user button:

```tsx
import { HelpPanel } from '@/components/help-panel';

// inside the right-side flex container in NavHeader, before the user form:
<HelpPanel />
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/help-panel.tsx dashboard/__tests__/components/help-panel.test.tsx dashboard/components/nav-header.tsx
git commit -m "feat(dashboard): HelpPanel slide-over wired into nav header"
```

---

### Task 6.3: `<SetupChecklist>` component

**Files:**
- Create: `dashboard/components/setup-checklist.tsx`
- Test: `dashboard/__tests__/components/setup-checklist.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// dashboard/__tests__/components/setup-checklist.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SetupChecklist } from '@/components/setup-checklist';

describe('<SetupChecklist>', () => {
  it('renders 5 steps with checked / unchecked state', () => {
    render(
      <SetupChecklist
        repoName="a/b"
        steps={{
          wired: true,
          pm_md_present: true,
          scout_configured: false,
          first_proposal: false,
          first_feature_shipped: false,
        }}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText(/wired/i).closest('li')).toHaveTextContent('✓');
    expect(screen.getByText(/scout/i).closest('li')).toHaveTextContent('☐');
  });

  it('does not render once all steps are done', () => {
    const { container } = render(
      <SetupChecklist
        repoName="a/b"
        steps={{
          wired: true,
          pm_md_present: true,
          scout_configured: true,
          first_proposal: true,
          first_feature_shipped: true,
        }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- __tests__/components/setup-checklist.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```tsx
// dashboard/components/setup-checklist.tsx
export type SetupSteps = {
  wired: boolean;
  pm_md_present: boolean;
  scout_configured: boolean;
  first_proposal: boolean;
  first_feature_shipped: boolean;
};

const LABELS: Array<{ key: keyof SetupSteps; label: string }> = [
  { key: 'wired', label: 'Repo wired up' },
  { key: 'pm_md_present', label: 'pm.md present' },
  { key: 'scout_configured', label: 'Scout sources configured' },
  { key: 'first_proposal', label: 'First proposal generated' },
  { key: 'first_feature_shipped', label: 'First feature shipped' },
];

export function SetupChecklist({ repoName, steps }: { repoName: string; steps: SetupSteps }) {
  const allDone = LABELS.every(({ key }) => steps[key]);
  if (allDone) return null;
  return (
    <div className="rounded-md border border-border bg-card p-5">
      <h3 className="mb-2 text-base font-semibold">Set up checklist for {repoName}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {LABELS.map(({ key, label }) => (
          <li key={key} className={steps[key] ? 'text-muted-foreground' : ''}>
            {steps[key] ? '✓' : '☐'} {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- __tests__/components/setup-checklist.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/setup-checklist.tsx dashboard/__tests__/components/setup-checklist.test.tsx
git commit -m "feat(dashboard): SetupChecklist for fresh-wired repos"
```

---

### Task 6.4: Wire `<SetupChecklist>` into Repo Workspace

**Files:**
- Modify: `dashboard/app/repos/[name]/page.tsx`

- [ ] **Step 1: Add the data probe + render**

Add a helper at the top of the file (above the page component):

```tsx
import { SetupChecklist, type SetupSteps } from '@/components/setup-checklist';

async function probeFile(
  octokit: Awaited<ReturnType<typeof getOctokit>>,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<boolean> {
  try {
    await octokit.repos.getContent({ owner, repo, path, ref });
    return true;
  } catch {
    return false;
  }
}
```

In the page, after `loadRepoWorkspace`, fetch the steps:

```tsx
  const [pmMdPresent] = await Promise.all([
    repo.wired_up
      ? probeFile(octokit, repo.owner, repo.name, '.dev-agent/pm.md', repo.default_branch)
      : Promise.resolve(false),
  ]);
  const setupSteps: SetupSteps = {
    wired: repo.wired_up,
    pm_md_present: pmMdPresent,
    scout_configured: unfinishedWorkInstalled,
    first_proposal: proposals.length > 0,
    first_feature_shipped: workspace.recentlyShipped.length > 0 || workspace.inFlight.length > 0,
  };
```

Render at the top of the page body, just under Band 1:

```tsx
      <SetupChecklist repoName={name} steps={setupSteps} />
```

- [ ] **Step 2: Typecheck + manual smoke**

```bash
cd dashboard && npm run typecheck
cd dashboard && npm run dev
```

Visit a freshly wired repo's workspace; checklist should appear with appropriate checks.

- [ ] **Step 3: Commit**

```bash
git add dashboard/app/repos/[name]/page.tsx
git commit -m "feat(dashboard): wire SetupChecklist into Repo Workspace"
```

---

### Task 6.5: E2E smoke test for the redesigned dashboard

**Files:**
- Create: `dashboard/__tests__/e2e/dashboard-redesign.spec.ts`

- [ ] **Step 1: Write the smoke test**

This relies on Playwright's existing config. It checks the Home renders the 7 bands and the nav has the expected primary links. Skips quietly if no auth fixture is set up.

```typescript
// dashboard/__tests__/e2e/dashboard-redesign.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Dashboard redesign smoke', () => {
  test('Home renders 7 bands and 3 primary nav links', async ({ page }) => {
    await page.goto('/');
    // If signed out, the test environment redirects to /auth/signin. Skip.
    if (page.url().includes('/auth/signin')) test.skip();

    // Primary nav
    await expect(page.getByRole('link', { name: /^Home$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Repos$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Brainstorm$/ })).toBeVisible();

    // 7 bands by heading
    for (const heading of [
      'Needs you now',
      'In motion',
      'Recently shipped (last 7d)',
      'PM proposes',
      'Verification posture',
      'Your repos',
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }

    // Hero CTA
    await expect(page.getByRole('button', { name: /Brainstorm new work/ })).toBeVisible();
  });

  test('Help panel opens', async ({ page }) => {
    await page.goto('/');
    if (page.url().includes('/auth/signin')) test.skip();
    await page.getByRole('button', { name: /help/i }).click();
    await expect(page.getByText(/About dev-agent/)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run E2E**

```bash
cd dashboard && npm run test:e2e -- dashboard-redesign.spec.ts
```

Expected: PASS (or SKIPPED if no auth fixture). If FAIL, debug.

- [ ] **Step 3: Commit**

```bash
git add dashboard/__tests__/e2e/dashboard-redesign.spec.ts
git commit -m "test(dashboard): E2E smoke for redesigned Home + help panel"
```

---

### Step 6 final verify

- [ ] Full suite

```bash
cd dashboard && npm test
```

Expected: every test PASSES.

- [ ] Typecheck

```bash
cd dashboard && npm run typecheck
```

Expected: clean.

- [ ] E2E

```bash
cd dashboard && npm run test:e2e
```

Expected: PASS or SKIPPED depending on auth fixture.

- [ ] Manual end-to-end walkthrough

```bash
cd dashboard && npm run dev
```

1. Visit `/` — confirm 7 bands and Brainstorm CTA.
2. Click `?` help — panel opens.
3. Click a repo card → workspace renders 7 bands.
4. From workspace Band 4 (recently shipped), click a verification chip → lands on `/features/[issue]?tab=verification&pillar=<id>` with the right pillar expanded.
5. Click "Brainstorm new work on …" → `/intent` opens with repo pre-selected.
6. Confirm scan/scout/schedule controls still work under Settings band.

---

## PR & merge

- [ ] Push branch and open PR

```bash
git push -u origin feat/dashboard-ux-redesign
gh pr create --title "feat(dashboard): UX redesign — Home + Repo Workspace + verification visibility" --body "$(cat <<'EOF'
## Summary
- Replaces inbox-only Home with a 7-band command center
- Replaces thin per-repo page with a 7-band Workspace
- Surfaces verification pillar outcomes everywhere (8 surfaces, one component)
- Collapses 7-peer nav to 3 primary + secondary
- Adds help panel and setup checklist

Spec: docs/superpowers/specs/2026-05-09-dashboard-ux-redesign-design.md
Plan: docs/superpowers/plans/2026-05-09-dashboard-ux-redesign.md

## Test plan
- [ ] All vitest unit/component tests pass
- [ ] Typecheck clean
- [ ] E2E smoke (`dashboard-redesign.spec.ts`) passes
- [ ] Manual walkthrough: Home → repo workspace → feature detail → verification chip deep-link → brainstorm pre-scoped
EOF
)"
```

---

## Sub-task tracker (deferred to follow-up specs)

These were called out in the spec but are not implemented in v1:

- **Per-repo proposals count + per-repo cost-7d** in `RepoSummary` — currently populated as `0` in `home-bands.ts` because scout-per-repo and cost-per-repo aggregations don't exist yet. Add when those libs land.
- **Cost band** on Repo Workspace (Band 6) — currently a link to `/cost?repo=...` placeholder; full chart deferred.
- **Real-time updates** — page-load fetch only.
- **Mobile polish** — responsive but not designed for mobile-first.
- **Per-pillar cost in `VerificationOutcome.cost_usd`** — currently `undefined` for all extractors because pillar artifacts don't carry cost yet. Wire when telemetry comments per pillar land.
- **In-flight "Discuss with PM" CTA on feature cards** — spec calls for a per-card CTA that pre-loads `/intent` with the existing issue body so the user can refine scope mid-build. Deferred because it needs its own data plumbing (issue body fetch for prefill); the existing `<FeatureCard>` link to `/features/[issue]` is the v1 fallback.
