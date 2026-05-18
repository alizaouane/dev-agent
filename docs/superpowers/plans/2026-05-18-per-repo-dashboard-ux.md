# Per-Repo Dashboard UX Bundle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dev-agent dashboard easy to use one repo at a time — local-timezone schedule labels, an on-demand bug-scout trigger, repo-scoped proposals navigation, and in-app scan status instead of "go check GitHub".

**Architecture:** All changes are in `dashboard/`. New work mirrors existing patterns: `triggerBugScoutScan` copies `triggerCleanupScan`; the scan-status feature splits into a pure decision helper (`lib/scan-run.ts`, unit-tested), a read-only server action (`getLatestScanRun`), and a polling client component (`scan-run-status.tsx`) shared by all three scan buttons. The timezone label is a pure helper in `lib/bug-scout-schedule.ts`.

**Tech Stack:** Next.js 15 (App Router, server components + server actions), TypeScript, Vitest, Octokit, Tailwind, `Intl` for timezone formatting.

---

## File summary

| File | Task | Responsibility |
|---|---|---|
| `dashboard/lib/bug-scout-schedule.ts` | 1 | add `cronToLocalLabel` pure helper |
| `dashboard/__tests__/lib/bug-scout-schedule.test.ts` | 1 | unit tests for `cronToLocalLabel` (create if absent) |
| `dashboard/components/bug-scout-schedule-form.tsx` | 1, 6 | timezone labels in the `<Select>`; "Run bug-scout now" button |
| `dashboard/lib/actions.ts` | 2, 4 | add `triggerBugScoutScan`, `getLatestScanRun` |
| `dashboard/__tests__/lib/actions.test.ts` | 2, 4 | tests for the two new actions |
| `dashboard/lib/scan-run.ts` | 3 | new — `ScanRunStatus` + `ScanPhase` types, `interpretScanRun` pure fn |
| `dashboard/__tests__/lib/scan-run.test.ts` | 3 | new — unit tests for `interpretScanRun` |
| `dashboard/components/scan-run-status.tsx` | 5 | new — polling client component, shared status UI |
| `dashboard/components/scan-with-pm-button.tsx` | 6 | use `scan-run-status`, drop "check GitHub" copy |
| `dashboard/components/scan-cleanup-button.tsx` | 6 | use `scan-run-status`, drop "check GitHub" copy |
| `dashboard/app/proposals/page.tsx` | 7 | accept `?repo=`, scope scouts + header |
| `dashboard/app/repos/[name]/page.tsx` | 7 | "See all" links to `/proposals?repo=` |

---

## Task 1: Timezone-aware bug-scout schedule labels

**Files:**
- Modify: `dashboard/lib/bug-scout-schedule.ts`
- Create or modify: `dashboard/__tests__/lib/bug-scout-schedule.test.ts`
- Modify: `dashboard/components/bug-scout-schedule-form.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/__tests__/lib/bug-scout-schedule.test.ts` (if it already exists, append the `describe` block):

```typescript
import { describe, it, expect } from 'vitest';
import { cronToLocalLabel } from '@/lib/bug-scout-schedule';

describe('cronToLocalLabel', () => {
  it('converts the daily 09:00 UTC preset to Singapore time (UTC+8)', () => {
    const label = cronToLocalLabel('daily', 'Asia/Singapore');
    expect(label).toContain('Daily');
    expect(label).toContain('17:00');
    expect(label).toContain('09:00 UTC');
  });

  it('converts the weekdays preset to local time', () => {
    const label = cronToLocalLabel('weekdays', 'Asia/Singapore');
    expect(label).toContain('Weekdays');
    expect(label).toContain('17:00');
    expect(label).toContain('09:00 UTC');
  });

  it('shows the local weekday for the weekly preset', () => {
    const label = cronToLocalLabel('weekly', 'Asia/Singapore');
    // 09:00 UTC Monday is 17:00 Monday in Singapore.
    expect(label).toContain('Mon 17:00');
    expect(label).toContain('Mon 09:00 UTC');
  });

  it('shifts the weekday when the UTC->local conversion crosses midnight', () => {
    // Honolulu is UTC-10: 09:00 UTC Monday is 23:00 Sunday local.
    const label = cronToLocalLabel('weekly', 'Pacific/Honolulu');
    expect(label).toContain('Sun 23:00');
    expect(label).toContain('Mon 09:00 UTC');
  });

  it('returns the off label unchanged', () => {
    expect(cronToLocalLabel('off', 'Asia/Singapore')).toBe('Off (manual only)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run __tests__/lib/bug-scout-schedule.test.ts`
Expected: FAIL — `cronToLocalLabel` is not exported.

- [ ] **Step 3: Implement `cronToLocalLabel`**

In `dashboard/lib/bug-scout-schedule.ts`, after the `PRESET_COSTS` constant, add:

```typescript
/**
 * Render a schedule preset's run time in `timeZone`, alongside the
 * canonical UTC time. GitHub Actions crons are always UTC; this is a
 * display-only conversion. `timeZone` is an IANA zone — pass the value of
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` from the browser.
 * The `off` preset has no time, so its label is returned unchanged.
 */
export function cronToLocalLabel(preset: SchedulePreset, timeZone: string): string {
  if (preset === 'off') return PRESET_LABELS.off;

  const cron = PRESET_TO_CRON[preset]; // 'min hour dom mon dow'
  const [minStr, hourStr] = cron.split(' ');

  // Anchor on a known Monday (2024-01-01 is a Monday) at the cron's UTC
  // hour. The weekly preset fires on Monday UTC; formatting this anchor's
  // weekday in the target zone yields the correct local weekday, even
  // when the conversion crosses midnight.
  const anchor = new Date(Date.UTC(2024, 0, 1, Number(hourStr), Number(minStr)));

  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(anchor);

  const tzAbbr =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(anchor)
      .find((p) => p.type === 'timeZoneName')?.value ?? timeZone;

  const utc = `${hourStr.padStart(2, '0')}:${minStr.padStart(2, '0')} UTC`;

  if (preset === 'weekly') {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
    }).format(anchor);
    return `Weekly — ${weekday} ${time} ${tzAbbr} · Mon ${utc}`;
  }
  const kind = preset === 'daily' ? 'Daily' : 'Weekdays';
  return `${kind} — ${time} ${tzAbbr} · ${utc}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run __tests__/lib/bug-scout-schedule.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Wire the timezone label into the schedule form**

In `dashboard/components/bug-scout-schedule-form.tsx`, the `<Select>` currently renders each option as `{PRESET_LABELS[p]} — {PRESET_COSTS[p]}`. Replace the label source with the timezone-aware label.

Add the import (extend the existing import from `@/lib/bug-scout-schedule`):

```typescript
import {
  PRESET_LABELS,
  PRESET_COSTS,
  SCHEDULE_PRESETS,
  cronToLocalLabel,
  type SchedulePreset,
} from '@/lib/bug-scout-schedule';
```

Inside the `BugScoutScheduleForm` component body (it is a `'use client'` component), compute the viewer timezone once:

```typescript
  // Browser timezone. `Intl` is always present in supported browsers;
  // the `|| 'UTC'` is a defensive fallback that degrades to the existing
  // UTC-only labels rather than throwing.
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
```

Then in the `SCHEDULE_PRESETS.map(...)` that renders `<SelectItem>`s, change the displayed label:

```tsx
            {SCHEDULE_PRESETS.map((p) => (
              <SelectItem key={p} value={p}>
                {cronToLocalLabel(p, timeZone)} — {PRESET_COSTS[p]}
              </SelectItem>
            ))}
```

`PRESET_LABELS` stays imported — it is still the canonical fallback used inside `cronToLocalLabel` for the `off` case.

- [ ] **Step 6: Verify typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/bug-scout-schedule.ts dashboard/__tests__/lib/bug-scout-schedule.test.ts dashboard/components/bug-scout-schedule-form.tsx
git commit -m "feat(dashboard): show bug-scout schedule in the viewer's local timezone"
```

---

## Task 2: `triggerBugScoutScan` server action

**Files:**
- Modify: `dashboard/lib/actions.ts`
- Modify: `dashboard/__tests__/lib/actions.test.ts`

- [ ] **Step 1: Write the failing test**

In `dashboard/__tests__/lib/actions.test.ts`, add this `describe` block after the existing `describe('triggerCleanupScan', ...)` block:

```typescript
describe('triggerBugScoutScan', () => {
  it("dispatches dev-agent-bug-scout.yml on the repo's default branch", async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'main' } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});

    const { triggerBugScoutScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    await triggerBugScoutScan(fd);

    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        workflow_id: 'dev-agent-bug-scout.yml',
        ref: 'main',
        inputs: {},
      }),
    );
  });

  it('dispatches on the actual default branch, not a hardcoded main', async () => {
    mockOctokit.repos.get.mockResolvedValueOnce({ data: { default_branch: 'develop' } });
    mockOctokit.actions.createWorkflowDispatch.mockResolvedValueOnce({});

    const { triggerBugScoutScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    await triggerBugScoutScan(fd);

    expect(mockOctokit.actions.createWorkflowDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'develop' }),
    );
  });

  it('refuses without write permission', async () => {
    mockOctokit.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({
      data: { permission: 'read' },
    });
    const { triggerBugScoutScan } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    await expect(triggerBugScoutScan(fd)).rejects.toThrow(/lacks write/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run __tests__/lib/actions.test.ts -t "triggerBugScoutScan"`
Expected: FAIL — `triggerBugScoutScan` is not exported.

- [ ] **Step 3: Implement `triggerBugScoutScan`**

In `dashboard/lib/actions.ts`, add this function immediately after `triggerCleanupScan`:

```typescript
/**
 * Server Action: fire a one-shot bug-scout run — dispatches the bug-scout
 * workflow on the consumer repo, independent of its cron schedule.
 * Mirrors `triggerCleanupScan`; only the workflow file name differs.
 *
 * Cost ~$0.30–1.00 per scan.
 *
 * Form fields:
 *  - `repo` — `owner/name`
 *
 * @throws Error on bad input
 * @throws ForbiddenError if user lacks write perm on the target repo
 */
export async function triggerBugScoutScan(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = (formData.get('repo') as string)?.trim() ?? '';
  if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
  const [owner, repo] = repoFull.split('/');
  await assertWritePermission(octokit, owner, repo, session_username);

  // Read default branch from the repo rather than trusting form input —
  // same as triggerCleanupScan / setBugScoutSchedule.
  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: 'dev-agent-bug-scout.yml',
    ref: default_branch,
    inputs: {},
  });

  void session_username;

  revalidatePath(`/repos/${encodeURIComponent(repoFull)}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run __tests__/lib/actions.test.ts -t "triggerBugScoutScan"`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/actions.ts dashboard/__tests__/lib/actions.test.ts
git commit -m "feat(dashboard): triggerBugScoutScan server action for on-demand bug-scout"
```

---

## Task 3: `lib/scan-run.ts` — scan-status types + `interpretScanRun`

**Files:**
- Create: `dashboard/lib/scan-run.ts`
- Create: `dashboard/__tests__/lib/scan-run.test.ts`

- [ ] **Step 1: Write the failing test**

Create `dashboard/__tests__/lib/scan-run.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { interpretScanRun } from '@/lib/scan-run';

const SINCE = 1_000_000_000_000; // fixed dispatch timestamp (ms)

describe('interpretScanRun', () => {
  it('reports error when the lookup failed', () => {
    expect(interpretScanRun({ error: 'boom' }, SINCE)).toEqual({
      kind: 'error',
      message: 'boom',
    });
  });

  it('reports queued when there is no run yet', () => {
    const result = { status: null, conclusion: null, html_url: null, created_at: null };
    expect(interpretScanRun(result, SINCE)).toEqual({ kind: 'queued' });
  });

  it('reports queued when the latest run predates this dispatch', () => {
    const stale = new Date(SINCE - 5 * 60_000).toISOString();
    const result = {
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://x',
      created_at: stale,
    };
    expect(interpretScanRun(result, SINCE)).toEqual({ kind: 'queued' });
  });

  it('reports running for an in-progress run created after dispatch', () => {
    const result = {
      status: 'in_progress',
      conclusion: null,
      html_url: 'https://run',
      created_at: new Date(SINCE + 2_000).toISOString(),
    };
    expect(interpretScanRun(result, SINCE)).toEqual({
      kind: 'running',
      runUrl: 'https://run',
    });
  });

  it('reports done+ok for a completed successful run', () => {
    const result = {
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://run',
      created_at: new Date(SINCE + 2_000).toISOString(),
    };
    expect(interpretScanRun(result, SINCE)).toEqual({
      kind: 'done',
      ok: true,
      runUrl: 'https://run',
    });
  });

  it('reports done+not-ok for a completed failed run', () => {
    const result = {
      status: 'completed',
      conclusion: 'startup_failure',
      html_url: 'https://run',
      created_at: new Date(SINCE + 2_000).toISOString(),
    };
    expect(interpretScanRun(result, SINCE)).toEqual({
      kind: 'done',
      ok: false,
      runUrl: 'https://run',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run __tests__/lib/scan-run.test.ts`
Expected: FAIL — `@/lib/scan-run` does not exist.

- [ ] **Step 3: Implement `lib/scan-run.ts`**

Create `dashboard/lib/scan-run.ts`:

```typescript
/**
 * Shared types + pure decision logic for surfacing scout-run status in
 * the dashboard. `getLatestScanRun` (lib/actions.ts) produces a
 * `ScanRunStatus`; `interpretScanRun` turns it into a `ScanPhase` the
 * `ScanRunStatus` component renders. Kept framework-free so the decision
 * is unit-testable without a DOM.
 */

/** Latest-run snapshot returned by the `getLatestScanRun` server action. */
export type ScanRunStatus = {
  /** queued | in_progress | completed — or null when the repo has no runs. */
  status: string | null;
  /** success | failure | startup_failure | ... — null until completed. */
  conclusion: string | null;
  html_url: string | null;
  created_at: string | null;
};

/** What the UI should show for an in-flight scan. */
export type ScanPhase =
  | { kind: 'queued' }
  | { kind: 'running'; runUrl: string | null }
  | { kind: 'done'; ok: boolean; runUrl: string | null }
  | { kind: 'error'; message: string };

/** 60s of slack absorbs clock skew between the browser and GitHub. */
const SKEW_MS = 60_000;

/**
 * Classify the latest-run lookup for a scan dispatched at `since` (ms).
 * A run whose `created_at` predates `since - SKEW_MS` is treated as a
 * previous run — our dispatch hasn't registered yet → `queued`.
 */
export function interpretScanRun(
  result: ScanRunStatus | { error: string },
  since: number,
): ScanPhase {
  if ('error' in result) return { kind: 'error', message: result.error };

  const created = result.created_at ? Date.parse(result.created_at) : 0;
  if (!result.status || created < since - SKEW_MS) {
    return { kind: 'queued' };
  }
  if (result.status !== 'completed') {
    return { kind: 'running', runUrl: result.html_url };
  }
  return {
    kind: 'done',
    ok: result.conclusion === 'success',
    runUrl: result.html_url,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run __tests__/lib/scan-run.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/scan-run.ts dashboard/__tests__/lib/scan-run.test.ts
git commit -m "feat(dashboard): scan-run status types + interpretScanRun helper"
```

---

## Task 4: `getLatestScanRun` server action

**Files:**
- Modify: `dashboard/lib/actions.ts`
- Modify: `dashboard/__tests__/lib/actions.test.ts`

- [ ] **Step 1: Add `listWorkflowRuns` to the test mock**

In `dashboard/__tests__/lib/actions.test.ts`, the `mockOctokit.actions` object lists the Octokit `actions` methods used by the suite. Add `listWorkflowRuns` to it:

```typescript
  actions: {
    createWorkflowDispatch: vi.fn(),
    getRepoPublicKey: vi.fn(),
    createOrUpdateRepoSecret: vi.fn(),
    cancelWorkflowRun: vi.fn(),
    listWorkflowRuns: vi.fn(),
  },
```

- [ ] **Step 2: Write the failing test**

In `dashboard/__tests__/lib/actions.test.ts`, add this `describe` block after the `triggerBugScoutScan` block from Task 2:

```typescript
describe('getLatestScanRun', () => {
  it('returns the latest run fields for a workflow', async () => {
    mockOctokit.actions.listWorkflowRuns.mockResolvedValueOnce({
      data: {
        workflow_runs: [
          {
            status: 'in_progress',
            conclusion: null,
            html_url: 'https://github.com/q/r/actions/runs/1',
            created_at: '2026-05-18T00:00:00Z',
          },
        ],
      },
    });

    const { getLatestScanRun } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'dev-agent-bug-scout.yml');
    const result = await getLatestScanRun(fd);

    expect(result).toEqual({
      status: 'in_progress',
      conclusion: null,
      html_url: 'https://github.com/q/r/actions/runs/1',
      created_at: '2026-05-18T00:00:00Z',
    });
    expect(mockOctokit.actions.listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'q',
        repo: 'r',
        workflow_id: 'dev-agent-bug-scout.yml',
        per_page: 1,
      }),
    );
  });

  it('returns all-null when the workflow has no runs', async () => {
    mockOctokit.actions.listWorkflowRuns.mockResolvedValueOnce({
      data: { workflow_runs: [] },
    });
    const { getLatestScanRun } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'dev-agent-bug-scout.yml');
    expect(await getLatestScanRun(fd)).toEqual({
      status: null,
      conclusion: null,
      html_url: null,
      created_at: null,
    });
  });

  it('returns { error } instead of throwing when the API call fails', async () => {
    mockOctokit.actions.listWorkflowRuns.mockRejectedValueOnce(
      new Error('GitHub API 500'),
    );
    const { getLatestScanRun } = await import('@/lib/actions');
    const fd = new FormData();
    fd.append('repo', 'q/r');
    fd.append('workflow', 'dev-agent-bug-scout.yml');
    expect(await getLatestScanRun(fd)).toEqual({
      error: expect.stringContaining('GitHub API 500'),
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd dashboard && npx vitest run __tests__/lib/actions.test.ts -t "getLatestScanRun"`
Expected: FAIL — `getLatestScanRun` is not exported.

- [ ] **Step 4: Implement `getLatestScanRun`**

In `dashboard/lib/actions.ts`, add the import for the shared type near the other `./` imports at the top of the file:

```typescript
import type { ScanRunStatus } from './scan-run';
```

Then add this function immediately after `triggerBugScoutScan`:

```typescript
/**
 * Server Action (read-only): return the most recent workflow run for a
 * scout workflow on a repo, so the dashboard can show scan status inline
 * instead of sending the user to GitHub's Actions tab.
 *
 * No write-permission gate — listing runs is a read, and the user
 * already has dashboard read access to the repo. Returns `{ error }`
 * (does not throw) on failure so production's Server Components mask
 * can't hide the cause — same contract as `redispatchPhase`.
 *
 * Form fields:
 *  - `repo`     — `owner/name`
 *  - `workflow` — workflow file name (e.g. `dev-agent-bug-scout.yml`)
 */
export async function getLatestScanRun(
  formData: FormData,
): Promise<ScanRunStatus | { error: string }> {
  try {
    const octokit = await getOctokit();
    const repoFull = ((formData.get('repo') as string | null) ?? '').trim();
    const workflow = ((formData.get('workflow') as string | null) ?? '').trim();
    if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
    if (!workflow) throw new Error('workflow is required');
    const [owner, repo] = repoFull.split('/');

    const resp = await octokit.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflow,
      per_page: 1,
    });
    const run = resp.data.workflow_runs[0];
    if (!run) {
      return { status: null, conclusion: null, html_url: null, created_at: null };
    }
    return {
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      html_url: run.html_url ?? null,
      created_at: run.created_at ?? null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[getLatestScanRun] failed', { message });
    return { error: message };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd dashboard && npx vitest run __tests__/lib/actions.test.ts -t "getLatestScanRun"`
Expected: PASS — 3 tests green.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/actions.ts dashboard/__tests__/lib/actions.test.ts
git commit -m "feat(dashboard): getLatestScanRun action for in-app scan status"
```

---

## Task 5: `scan-run-status.tsx` polling component

**Files:**
- Create: `dashboard/components/scan-run-status.tsx`

- [ ] **Step 1: Implement the component**

Create `dashboard/components/scan-run-status.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { getLatestScanRun } from '@/lib/actions';
import { interpretScanRun, type ScanPhase } from '@/lib/scan-run';

type Props = {
  /** `owner/name`. */
  repo: string;
  /** Workflow file name, e.g. `dev-agent-bug-scout.yml`. */
  workflow: string;
  /** ms timestamp when the scan was dispatched in this session. */
  since: number;
  /** Repo-scoped proposals URL where findings will appear. */
  proposalsHref: string;
};

const POLL_MS = 10_000;

/**
 * Polls `getLatestScanRun` after a scan is dispatched and shows status
 * inline — Queued → Running → Completed/Failed — so the user never has
 * to leave the dashboard for GitHub's Actions tab. Polling stops once
 * the run reaches a terminal state or the lookup errors.
 */
export function ScanRunStatus({ repo, workflow, since, proposalsHref }: Props) {
  const [phase, setPhase] = useState<ScanPhase>({ kind: 'queued' });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      const fd = new FormData();
      fd.append('repo', repo);
      fd.append('workflow', workflow);
      const result = await getLatestScanRun(fd);
      if (cancelled) return;
      const next = interpretScanRun(result, since);
      setPhase(next);
      // Keep polling only while the run is not yet terminal and the
      // lookup is healthy.
      if (next.kind === 'queued' || next.kind === 'running') {
        timer = setTimeout(poll, POLL_MS);
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repo, workflow, since]);

  if (phase.kind === 'error') {
    return (
      <span className="text-xs text-destructive">
        Couldn&apos;t read scan status: {phase.message}
      </span>
    );
  }
  if (phase.kind === 'queued') {
    return <span className="text-xs text-muted-foreground">Scan queued…</span>;
  }
  if (phase.kind === 'running') {
    return <span className="text-xs text-muted-foreground">Scan running…</span>;
  }
  // done
  if (phase.ok) {
    return (
      <span className="text-xs text-muted-foreground">
        Scan complete.{' '}
        <a href={proposalsHref} className="underline">
          View findings
        </a>
      </span>
    );
  }
  return (
    <span className="text-xs text-destructive">
      Scan run failed.{' '}
      {phase.runUrl ? (
        <a
          href={phase.runUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="underline"
        >
          View run log
        </a>
      ) : null}
    </span>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/components/scan-run-status.tsx
git commit -m "feat(dashboard): ScanRunStatus polling component"
```

---

## Task 6: Wire in-app status into the three scan surfaces + "Run bug-scout now"

**Files:**
- Modify: `dashboard/components/scan-with-pm-button.tsx`
- Modify: `dashboard/components/scan-cleanup-button.tsx`
- Modify: `dashboard/components/bug-scout-schedule-form.tsx`

- [ ] **Step 1: Update `scan-with-pm-button.tsx`**

In `dashboard/components/scan-with-pm-button.tsx`, add the import:

```typescript
import { ScanRunStatus } from '@/components/scan-run-status';
```

The component already has `const [dispatchedAt, setDispatchedAt] = useState<number | null>(null)` and sets it on a successful dispatch. Replace the post-dispatch message block (the JSX that currently renders `"Scan dispatched. Watch the Actions tab on GitHub for live progress…"`) with the live status component:

```tsx
        {dispatchedAt ? (
          <ScanRunStatus
            repo={repo}
            workflow="dev-agent-unfinished-work-scout.yml"
            since={dispatchedAt}
            proposalsHref={`/proposals?repo=${encodeURIComponent(repo)}`}
          />
        ) : null}
```

Leave the `error` rendering and the button itself unchanged.

- [ ] **Step 2: Update `scan-cleanup-button.tsx`**

In `dashboard/components/scan-cleanup-button.tsx`, add the same import:

```typescript
import { ScanRunStatus } from '@/components/scan-run-status';
```

Replace the post-dispatch "Scan dispatched. Watch the Actions tab…" JSX block with:

```tsx
        {dispatchedAt ? (
          <ScanRunStatus
            repo={repo}
            workflow="dev-agent-cleanup-scout.yml"
            since={dispatchedAt}
            proposalsHref={`/proposals?repo=${encodeURIComponent(repo)}`}
          />
        ) : null}
```

- [ ] **Step 3: Add the "Run bug-scout now" button to `bug-scout-schedule-form.tsx`**

In `dashboard/components/bug-scout-schedule-form.tsx`, add imports:

```typescript
import { setBugScoutSchedule, triggerBugScoutScan } from '@/lib/actions';
import { ScanRunStatus } from '@/components/scan-run-status';
```

(The `setBugScoutSchedule` import already exists — extend it to include `triggerBugScoutScan`.)

Inside the `BugScoutScheduleForm` component, add state + a handler alongside the existing schedule-save state:

```typescript
  const [scanPending, startScanTransition] = useTransition();
  const [scanDispatchedAt, setScanDispatchedAt] = useState<number | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const onRunNow = () => {
    setScanError(null);
    setScanDispatchedAt(null);
    startScanTransition(async () => {
      try {
        const fd = new FormData();
        fd.append('repo', repo);
        await triggerBugScoutScan(fd);
        setScanDispatchedAt(Date.now());
      } catch (err) {
        setScanError(err instanceof Error ? err.message : String(err));
      }
    });
  };
```

Then, in the rendered form (after the "Save schedule" controls, still inside the same container), add the run-now control:

```tsx
      <div className="flex items-center gap-3 border-t border-border pt-3">
        <Button type="button" onClick={onRunNow} disabled={scanPending} size="sm" variant="outline">
          {scanPending ? 'Dispatching…' : 'Run bug-scout now'}
        </Button>
        <span className="text-xs text-muted-foreground">
          One-off scan, independent of the schedule. ~$0.30–1.00 per run.
        </span>
      </div>
      {scanDispatchedAt ? (
        <ScanRunStatus
          repo={repo}
          workflow="dev-agent-bug-scout.yml"
          since={scanDispatchedAt}
          proposalsHref={`/proposals?repo=${encodeURIComponent(repo)}`}
        />
      ) : null}
      {scanError ? <span className="text-xs text-destructive">{scanError}</span> : null}
```

`useState` and `useTransition` are already imported in this file (the schedule-save flow uses them) — no new React imports needed.

- [ ] **Step 4: Verify typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/scan-with-pm-button.tsx dashboard/components/scan-cleanup-button.tsx dashboard/components/bug-scout-schedule-form.tsx
git commit -m "feat(dashboard): in-app scan status + Run bug-scout now button"
```

---

## Task 7: Repo-scoped proposals navigation

**Files:**
- Modify: `dashboard/app/proposals/page.tsx`
- Modify: `dashboard/app/repos/[name]/page.tsx`

- [ ] **Step 1: Accept `?repo=` in the proposals page**

In `dashboard/app/proposals/page.tsx`, widen the `searchParams` type and resolve a scoped repo. Change the component signature:

```typescript
export default async function ProposalsPage(props: {
  searchParams: Promise<{ show_snoozed?: string; repo?: string }>;
}) {
  const octokit = await getOctokit();
  const repos = wiredRepos(await listAllowedRepos(octokit));
  const { show_snoozed, repo: repoParam } = await props.searchParams;
  const showSnoozed = show_snoozed === '1';

  // When `?repo=owner/name` matches a wired repo, scope the whole page to
  // it: scouts run for one repo (fast) and only its proposals show. A
  // `repo` param that doesn't match a wired repo falls back to the
  // all-repos view with a notice rather than erroring.
  const scopedRepo = repoParam
    ? repos.find((r) => `${r.owner}/${r.name}` === repoParam)
    : undefined;
  const scopedRepos = scopedRepo ? [scopedRepo] : repos;
  const repoParamUnmatched = Boolean(repoParam) && !scopedRepo;
```

- [ ] **Step 2: Use `scopedRepos` for the scout + snooze calls**

In the same file, the `Promise.all` currently calls `runAllScouts(octokit, repos)` and `loadSnoozeMap(octokit, repos)`. Change both to `scopedRepos`:

```typescript
  const [proposals, snoozeMap] = await Promise.all([
    runAllScouts(octokit, scopedRepos),
    loadSnoozeMap(octokit, scopedRepos),
  ]);
```

- [ ] **Step 3: Make the header reflect the scope**

In the same file, replace the page heading + intro paragraph (the `<h1>Proposals</h1>` and the `<p>` describing "scanned across your N wired-up repos") with a scope-aware version:

```tsx
      <h1 className="mb-2 text-2xl font-semibold">
        {scopedRepo ? `Proposals · ${scopedRepo.owner}/${scopedRepo.name}` : 'Proposals'}
      </h1>
      {repoParamUnmatched ? (
        <p className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <code>{repoParam}</code> isn&apos;t a wired-up repo — showing all repos instead.
        </p>
      ) : null}
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        {scopedRepo ? (
          <>
            What the PM agent thinks you should consider doing next in{' '}
            <code>{scopedRepo.owner}/{scopedRepo.name}</code>.{' '}
            <Link href="/proposals" className="underline">View all repos</Link>.
          </>
        ) : (
          <>
            What the PM agent thinks you should consider doing next, scanned across your{' '}
            {repos.length} wired-up {repos.length === 1 ? 'repo' : 'repos'}.
          </>
        )}
      </p>
```

This replaces the existing `<h1>` + `<p>` only. Leave the rest of the page (empty-state, carry-over / new-idea sections, snoozed section) unchanged — those already render off `active` / `snoozed`, which now derive from `scopedRepos`.

- [ ] **Step 4: Point the repo workspace "See all" link at the scoped view**

In `dashboard/app/repos/[name]/page.tsx`, the Band 3 "PM proposes" section has `<Link href="/proposals" className="text-sm underline">See all</Link>`. Change the `href` to the repo-scoped URL. The page already has `name` (the decoded `owner/name` string) in scope:

```tsx
          <Link href={`/proposals?repo=${encodeURIComponent(name)}`} className="text-sm underline">
            See all
          </Link>
```

- [ ] **Step 5: Verify typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: PASS — no type errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard/app/proposals/page.tsx dashboard/app/repos/[name]/page.tsx
git commit -m "feat(dashboard): repo-scoped proposals view via ?repo= param"
```

---

## Self-Review

**1. Spec coverage:**
- Spec Feature 1 (timezone labels) → Task 1. ✓
- Spec Feature 2 (Run bug-scout now) → Task 2 (action) + Task 6 Step 3 (button). ✓
- Spec Feature 3 (repo-scoped proposals) → Task 7. ✓
- Spec Feature 4 (in-app scan status) → Task 3 (helper) + Task 4 (action) + Task 5 (component) + Task 6 Steps 1–2 (wiring). ✓
- Spec's shared `scan-run-status` component → Task 5, used by all three buttons in Task 6. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Every code step shows complete code. Test steps show full test bodies.

**3. Type consistency:** `ScanRunStatus` is defined once in `lib/scan-run.ts` (Task 3) and imported by `getLatestScanRun` (Task 4) and consumed by `interpretScanRun`. `ScanPhase` defined in Task 3, consumed by the component in Task 5. `cronToLocalLabel(preset, timeZone)` signature is consistent between Task 1 Step 3 (definition) and Step 5 (call). `triggerBugScoutScan` / `getLatestScanRun` signatures match between definition (Tasks 2, 4) and use (Task 6, Task 5). `proposalsHref` prop name consistent across Task 5 and all Task 6 call sites.

**Notes for the implementer:**
- The scan buttons (`scan-with-pm-button.tsx`, `scan-cleanup-button.tsx`) already hold a `dispatchedAt` state set on successful dispatch — Task 6 only swaps what renders when it is set. Read each file before editing to match its exact existing JSX.
- After all tasks, run the full dashboard suite: `cd dashboard && npx vitest run && npx tsc --noEmit`.
