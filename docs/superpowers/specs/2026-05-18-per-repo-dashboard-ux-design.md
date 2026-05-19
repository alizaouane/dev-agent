# Per-Repo Dashboard UX Bundle — Design

**Date:** 2026-05-18
**Status:** Approved — ready for implementation plan
**Scope:** Dashboard only (`dashboard/`). Four related changes that make the dashboard easier to use one repo at a time.

---

## Context

Four usability problems surfaced while working in the dashboard:

1. The bug-scout schedule selector shows cron times in **UTC only**. A Singapore-based user has to do the +8 conversion in their head.
2. Bug-scout can only run on its cron — there is **no on-demand trigger**, unlike the "Scan with PM" and "Cleanup scan" buttons.
3. From a repo workspace, the "PM proposes → See all" link jumps to the **global `/proposals`** page, which runs scouts across *every* wired repo. It is slow and shows proposals for unrelated repos — the user loses their single-repo focus.
4. The scan buttons ("Scan with PM", "Cleanup scan"), after dispatching, tell the user to **"watch the Actions tab on GitHub"** — forcing a context switch out of the dashboard, with no status surfaced in-app.

All four are dashboard-only and mostly mirror patterns that already exist in the codebase.

---

## Feature 1 — Timezone-aware bug-scout schedule labels

**Behavior.** The schedule `<Select>` shows each preset's run time in the viewer's local timezone alongside UTC. Examples for a viewer in `Asia/Singapore`:

- `daily` → `Daily — 17:00 SGT · 09:00 UTC`
- `weekdays` → `Weekdays — 17:00 SGT · 09:00 UTC`
- `weekly` → `Weekly — Mon 17:00 SGT · 09:00 UTC`
- `off` → `Off (manual only)` (unchanged — no time)

The cron strings are **not** changed — GitHub Actions requires UTC crons. This is display-only.

**Design.**
- `bug-scout-schedule-form.tsx` is a client component, so it reads the browser timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone` and the abbreviation/offset via `Intl.DateTimeFormat`.
- A pure helper `cronToLocalLabel(preset, timeZone)` lives in `lib/bug-scout-schedule.ts` (so it is unit-testable without a DOM). It resolves the preset's UTC cron internally, computes the local hour:minute and — for `weekly` — the local weekday, and returns the display string. It handles the day-of-week shift when the UTC→local conversion crosses midnight (correct for any timezone, not just SGT).
- `PRESET_LABELS` stays as the UTC-canonical fallback (used server-side / in tests where no browser timezone exists). The form computes the timezone-aware label client-side and falls back to `PRESET_LABELS` if `Intl` is unavailable.

**Files:** `lib/bug-scout-schedule.ts` (add `cronToLocalLabel`), `components/bug-scout-schedule-form.tsx` (use it).

**Tests:** unit tests for `cronToLocalLabel` — SGT (UTC+8, same-day), a UTC-negative zone where `weekly` shifts to the previous weekday, and `off`.

---

## Feature 2 — "Run bug-scout now" button

**Behavior.** A "Run bug-scout now" button in the Bug-scout schedule card fires an immediate scan, independent of the cron. Disabled with a short post-click cooldown to prevent accidental double-fire of a paid run; shows a cost note (`~$0.30–1.00 per scan`).

**Design.**
- New server action `triggerBugScoutScan(formData)` in `lib/actions.ts`, mirroring the existing `triggerCleanupScan` exactly: `assertWritePermission` → resolve the repo's default branch via `octokit.repos.get` → `octokit.actions.createWorkflowDispatch({ workflow_id: 'dev-agent-bug-scout.yml', ref: default_branch, inputs: {} })` → `revalidatePath`. The bug-scout workflow already declares a `workflow_dispatch` trigger.
- The button is part of the bug-scout schedule card, rendered only when the bug-scout workflow is installed (`scheduleSnapshot` is non-null on the repo page). It uses the shared scan-status behavior from Feature 4.

**Files:** `lib/actions.ts` (add `triggerBugScoutScan`), `components/bug-scout-schedule-form.tsx` (add the button).

**Tests:** action test mirroring the `triggerCleanupScan` tests — happy path dispatches `dev-agent-bug-scout.yml` on the resolved default branch; refuses without write permission.

---

## Feature 3 — Repo-scoped proposals navigation

**Behavior.** From a repo workspace, "See all" opens the proposals page **scoped to that repo**: only that repo is scouted, and the page header reads `Proposals · <owner>/<name>`. The global all-repos `/proposals` view stays reachable from the top nav.

**Design.**
- `app/proposals/page.tsx` already takes `searchParams`. Add an optional `repo` param (`?repo=owner/name`).
  - When `repo` is set and matches a wired repo: scope `repos` to `[thatRepo]` before calling `runAllScouts` — this fixes both the slowness (one repo instead of all) and the cross-repo noise. Header shows `Proposals · owner/name` with a link back to the repo workspace and a "View all repos" link to unscoped `/proposals`.
  - When `repo` is set but not a wired repo (typo, un-wired): render a small notice and fall back to the global view rather than erroring.
  - When `repo` is absent: current behavior unchanged (all wired repos).
- `app/repos/[name]/page.tsx` Band 3 "PM proposes": change the `See all` link from `/proposals` to `/proposals?repo=<encoded owner/name>`.

**Files:** `app/proposals/page.tsx` (accept + apply `repo`), `app/repos/[name]/page.tsx` (scoped link).

**Tests:** the proposals page is a server component with external calls — covered by the existing dashboard E2E smoke pattern rather than a unit test. The plan will add an E2E assertion that `/proposals?repo=` shows the scoped header and only that repo's proposals.

---

## Feature 4 — In-app scan status

**Behavior.** After any scan button dispatches (Scan with PM, Cleanup scan, Run bug-scout), status is shown **inline in the dashboard** — `Queued → Running → Completed` / `Failed` — with no instruction to leave for GitHub. On completion the component links to the repo-scoped `/proposals?repo=` view (Feature 3) where findings appear, and to the GitHub run for logs (optional, not required).

**Design.**
- New server action `getLatestScanRun(formData)` in `lib/actions.ts`: given `repo` + `workflow` (the workflow file name), calls `octokit.actions.listWorkflowRuns({ owner, repo, workflow_id, per_page: 1 })` and returns `{ status, conclusion, html_url, created_at }` (or `null` if no runs). Read-only; returns `{ error }` on failure (the established prod-mask-resistant pattern).
- A shared client hook/component `useScanRunStatus` encapsulates: after dispatch, record the dispatch timestamp; poll `getLatestScanRun` every ~10s; treat the latest run as "this scan" once its `created_at` is at/after the dispatch time (a `workflow_dispatch` call returns no run id, so timestamp correlation is the pragmatic link); stop polling when the run reaches a terminal `conclusion`; render the status line.
- `scan-with-pm-button.tsx`, `scan-cleanup-button.tsx`, and the Feature 2 bug-scout button all use this shared status component, replacing the "watch the Actions tab" copy.

**Files:** `lib/actions.ts` (add `getLatestScanRun`), new `components/scan-run-status.tsx` (shared status component + polling), `components/scan-with-pm-button.tsx` + `components/scan-cleanup-button.tsx` + `components/bug-scout-schedule-form.tsx` (use it).

**Tests:** action test for `getLatestScanRun` (returns the latest run's fields; `null` when none; `{ error }` on API failure). The polling component's terminal-state logic gets a unit test with a mocked action.

---

## Out of scope

- Changing when scans actually run (cron values stay UTC-anchored).
- A global "current repo" context/persistence system — Feature 3's scoped header + scoped link is enough to keep focus.
- Live-streaming workflow logs into the dashboard — Feature 4 shows run *status*, not logs; a link to the GitHub run covers deep debugging.
- Consumer-side override UI and other unrelated dashboard areas.

---

## File summary

| File | Change |
|---|---|
| `dashboard/lib/bug-scout-schedule.ts` | add `cronToLocalLabel` |
| `dashboard/components/bug-scout-schedule-form.tsx` | timezone labels + "Run bug-scout now" button |
| `dashboard/lib/actions.ts` | add `triggerBugScoutScan`, `getLatestScanRun` |
| `dashboard/components/scan-run-status.tsx` | new — shared in-app status + polling |
| `dashboard/components/scan-with-pm-button.tsx` | use `scan-run-status`, drop "check GitHub" copy |
| `dashboard/components/scan-cleanup-button.tsx` | use `scan-run-status`, drop "check GitHub" copy |
| `dashboard/app/proposals/page.tsx` | accept `?repo=`, scope scouts + header |
| `dashboard/app/repos/[name]/page.tsx` | "See all" links to `/proposals?repo=` |

All changes mirror existing patterns (`triggerCleanupScan`, `ScanCleanupButton`, the `{ error }` server-action contract). No new abstractions beyond the shared `scan-run-status` component, which removes duplication across three buttons.
