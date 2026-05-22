# Events scraper + per-repo Overrides panel — Design

**Date:** 2026-05-22
**Status:** Approved — ready for implementation plan
**Scope:** Materialize the `<!-- dev-agent:event:b64 <base64> -->` anchors shipped in PRs #96/#97/#98 into queryable events and surface them in the dashboard's repo workspace.

---

## Context

PRs #96 (engine `/swarm-override`), #97 (consumer-side `/swarm-override`), and #98 (engine backport) all post audit comments carrying a hidden machine-parseable anchor:

```text
<!-- dev-agent:event:b64 <base64-encoded JSON> -->
```

The decoded JSON matches `lib/events.ts`'s `override.applied` event shape (`ts`, `run_id`, `issue`, `phase`, `payload.{override_type, actor, reason}`). Today the anchors are durable but inert — no tooling reads them. This spec ships the reader half so operators can see override history in the dashboard.

## Goal

When an operator opens a repo workspace page (`/repos/<name>`), a new **Overrides** card lists the last N `/swarm-override` invocations on that repo's PRs — timestamp, PR #, actor, reason — with a click-through to the source PR comment. Hits are cached server-side with the same TTL pattern verification posture uses.

A CLI shell (`lib/cli/events-scrape.ts`) provides the same materialization out-of-band so operators can dump `.dev-agent/events/<pr>.jsonl` for offline analysis if they want — same pure-helpers, different I/O.

## Non-goals

- **Committing `.dev-agent/events/<pr>.jsonl` back to the repo.** The dashboard cache makes commit-back unnecessary for the in-app view. CLI users who want files get them via the CLI.
- **Cross-repo aggregation in the UI.** The Overrides panel is per-repo, matching the repo workspace page model. A global "all overrides" view is out of scope.
- **Surfacing non-override events.** The anchor schema accommodates `cost.snapshot`, `cost.threshold.crossed`, etc. — but cost-watchdog events go to `.dev-agent/events/global.jsonl` via direct `emit()`, not via the PR-comment anchor pattern. This spec scopes to override events that go through the anchor pipe.
- **Backfilling pre-anchor overrides.** PRs that closed before the anchor shipped have no data to scrape; the panel will show whatever exists from the cutover forward.

## Architecture

Three layers, matching the cost-watchdog shape:

### 1. Pure-TS helpers — `lib/events-scrape.ts`

No I/O, no octokit, no `fs`. Three exported functions:

- `extractAnchors(commentBody: string): string[]` — regex-matches every `<!-- dev-agent:event:b64 (?<b64>[A-Za-z0-9+/=]+) -->` in the body. Returns the raw base64 payloads. Handles multiple anchors per comment (rare but possible if a comment is edited).
- `decodeAnchor(b64: string): DevAgentEvent | null` — base64-decodes and JSON-parses. Returns `null` on malformed input (truncated b64, invalid JSON, missing required fields). Validates the shape against `DevAgentEvent` from `lib/events.ts`.
- `summarizeOverride(event: DevAgentEvent): OverrideSummary | null` — narrows to the override-applied shape, extracting `{ ts, issue, actor, reason, override_type }`. Returns `null` for other event types.

Unit-testable in isolation.

### 2. Dashboard server-side loader — `dashboard/lib/dashboard/override-events.ts`

```ts
export interface OverrideEvent {
  ts: string;           // ISO-8601
  pr_number: number;
  actor: string;
  reason: string;
  source_comment_url: string;  // GitHub html_url for click-through
}

export async function loadOverrideEvents(
  octokit: Octokit,
  repo: { owner: string; name: string },
  opts?: { limit?: number; windowDays?: number },
): Promise<OverrideEvent[]>;
```

**Behavior.** Lists PRs from the last `windowDays` (default 90) via `octokit.paginate(octokit.pulls.list, { state: 'all' })`. For each PR, paginates `issues.listComments`, runs `extractAnchors` over each body, decodes via `decodeAnchor`, narrows via `summarizeOverride`, attaches the comment's `html_url` for click-through, and sorts by `ts` descending. Returns at most `limit` (default 10) results.

**Cache.** Hits a sibling of `dashboard/lib/verification/cache.ts` — same 30-min TTL, same hashed-key pattern, keyed by `repo + windowDays + limit`. Repeated visits to the repo workspace within 30 minutes don't re-paginate.

**Failure modes.**
- `octokit.pulls.list` 404 → `[]` (repo not visible to the token; UI shows the empty state).
- Anchor present but malformed → silently skipped (the extractor + decoder return `null`; the panel doesn't surface the corruption to operators).
- Network failure → propagates up; the page-level error handler renders the empty card with a "couldn't load" notice (same pattern as the verification posture rollup).

### 3. Dashboard UI — `dashboard/components/override-events-panel.tsx`

A server component that takes the loaded `OverrideEvent[]` and renders:

- **Header:** "Recent overrides" + an info tooltip explaining the audit-anchor source.
- **Empty state** (if `events.length === 0`): "No `/swarm-override` activity on this repo in the last 90 days." Matches `EmptyState` styling on the page.
- **List** of up to 10 rows:
  - **Timestamp** (relative — "2 hours ago", "3 days ago"; absolute on hover via `<time title="...">`)
  - **PR #** (linked to the PR on GitHub)
  - **Actor** (linked to their GitHub profile)
  - **Reason** (truncated to 80 chars with `…` ellipsis; full text on hover)
  - **Source link** (small "view audit comment" link to the `html_url`)

No client-side state; the panel re-loads on page refresh. The cache handles redundant fetches.

### 4. Wire into the repo workspace page

In `dashboard/app/repos/[name]/page.tsx`, add a new band between the existing **Band 5 — Verification posture** and **Band 6 — Cost**. The new band fetches via `loadOverrideEvents(octokit, repo)` and renders `<OverrideEventsPanel />` with the result.

The fetch is awaited alongside the existing `loadRepoWorkspace` call. If the page is already on the critical path, the override fetch piggybacks on the existing 30-min cache TTL.

### 5. CLI shell — `lib/cli/events-scrape.ts`

For operators who want JSONL on disk (offline audit, eval pipelines, etc.):

```bash
# In a repo's checkout:
GH_TOKEN=... GITHUB_REPOSITORY=owner/name npx tsx lib/cli/events-scrape.ts --out .dev-agent/events/
```

Walks the same data the dashboard loader does and writes one JSONL line per event to `<out-dir>/<pr-number>.jsonl`. Reuses the pure helpers; the CLI is a thin shell over `loadOverrideEvents`-equivalent logic.

The CLI is not invoked from any cron — manual operator use. Adding a cron is v1.1+ if anyone wants persisted history.

## Files

| File | Change |
|---|---|
| `lib/events-scrape.ts` | new — pure helpers (extract, decode, summarize) |
| `lib/cli/events-scrape.ts` | new — CLI shell |
| `package.json` | add `"events-scrape": "tsx lib/cli/events-scrape.ts"` |
| `tests/unit/events-scrape.test.ts` | new — pure-helper unit tests |
| `dashboard/lib/dashboard/override-events.ts` | new — server-side loader + cache |
| `dashboard/__tests__/lib/dashboard/override-events.test.ts` | new — loader tests with mocked octokit |
| `dashboard/components/override-events-panel.tsx` | new — UI component |
| `dashboard/__tests__/components/override-events-panel.test.tsx` | new — component render test |
| `dashboard/app/repos/[name]/page.tsx` | add fetch + panel under the new band |

No changes to:
- `lib/events.ts` (the writer side is already shipped via `emit()`)
- Any phase workflow (the override workflows already emit anchors)
- The orchestrator
- `INSTALLABLE_WORKFLOWS` (this is a reader, not a workflow)

## Testing

### Pure helpers (`tests/unit/events-scrape.test.ts`)

1. `extractAnchors` finds a single anchor in a body.
2. `extractAnchors` finds multiple anchors (e.g., a comment edited to fix a typo, both versions present).
3. `extractAnchors` ignores text that looks similar but isn't the anchor (e.g., `<!-- dev-agent:event ... -->` without `:b64`, or `<!-- something else:b64 ... -->`).
4. `decodeAnchor` round-trips a valid base64-encoded `override.applied` event.
5. `decodeAnchor` returns `null` for non-base64 input.
6. `decodeAnchor` returns `null` for base64 input that decodes to invalid JSON.
7. `decodeAnchor` returns `null` for valid JSON missing required fields (e.g., no `event` key).
8. `summarizeOverride` narrows a valid `override.applied` event correctly.
9. `summarizeOverride` returns `null` for other event types (`cost.snapshot`, etc.) — even though those don't currently come through anchors, the narrower should be strict.

### Dashboard loader (`dashboard/__tests__/lib/dashboard/override-events.test.ts`)

Mocked octokit returns a fixture set of PRs + comments. The loader returns the expected `OverrideEvent[]` with proper sorting, the cache key is stable across calls, and the second call within 30 minutes returns the cached value (no octokit calls).

### Dashboard component (`dashboard/__tests__/components/override-events-panel.test.tsx`)

Renders the panel with a fixture array; asserts the timestamp formatter, PR/actor links, and reason-truncation. Empty-state render is also tested.

## Rollout

The scraper has no rollout concerns — it's purely additive, has no schema impact, doesn't change any workflow, and doesn't require operator action. Drops onto the repo workspace page as a new card on next deploy. Repos without `/swarm-override` activity show the empty state.

The CLI is opt-in (manual invocation). Documented in a one-paragraph addition to the swarm-review enforcement runbook covering the JSONL output format.

## Out of scope

- Persistent storage of events (Supabase, etc.) — v1.1 if data volume warrants.
- Surfacing non-override event types (cost snapshots, threshold crossings) — needs separate routing because those don't use the PR-comment anchor pipe.
- Inline per-PR override badges in the pipeline view — additive future work; the current per-repo card already gives operators what they need.
- Cross-repo "all overrides" admin view — same justification.
