# Dashboard UX Redesign — Two-Layer Surface + Verification Visibility

**Status:** Design approved 2026-05-09. Awaiting implementation plan.
**Author:** ali (with Claude Code, brainstorming skill)
**Branch context:** drafted on `feat/verification-pillar4-apply-audit`; design lands separately, not coupled to that branch's verification work.

## Problem

The dev-agent dashboard at `dev-agent.qualiency.com` exists, has many surfaces (Inbox, Repos, Proposals, Pipeline, Cost, Activity, Intent, Features), and a working PM-chat brainstorm flow. Despite that, the creator (and primary user) has three structural complaints:

1. **Orientation:** "I don't understand how to use this tool." The home page is an inbox-only list with no narrative; the nav has 7 peer items with no hierarchy; nothing tells you what to do next.
2. **Per-repo visibility:** "I can't visualize each repo separately, including its work status." `/repos/[name]` exists but is thin; per-repo state (in-flight features, proposals, recent shipments, cost, verification posture) is scattered across global tabs.
3. **Verification invisibility:** "All the dev we did to make this tool industry-standard, I can't see it." The verification pillars (Gate B reviewers, EvidenceBundle, Pillar 4 syntax audit, Pillar 5 risk audit, Pillar 7 smoke) are engine-internal — they produce GitHub artifacts but the dashboard doesn't surface their outcomes anywhere.

The user's primary scenario when these complaints surface is **"I want to start new work"** — the entry point for that scenario is muddled despite the PM-chat being technically wired up.

## Goal

Redesign the dashboard so:
- The home answers "what's going on?" at a glance and tells you what to do next.
- Per-repo workspace answers "everything about this repo on one page."
- Verification pillars become visible artifacts (per-feature badges, per-feature evidence drill-down, aggregate metrics) — not engine-internal magic.
- Starting new work is the most obvious action from any surface.

## Non-goals

- Real-time / streaming updates (page-load fetch is fine; SSE is a v2 conversation).
- Mobile layout polish (desktop focus; mobile responsive enough not to break).
- Theming / dark-mode tweaks.
- Per-user preferences for hiding/reordering bands.
- Changes to the PM chat internals (`/intent`, `pm-chat.tsx`) — entry density goes up, behaviour doesn't change.
- Changes to scout sources, proposal categorization, snooze logic — preserved.
- Changes to the verification engine itself — pillars keep producing the same artifacts; we just *read* them differently.
- Auth, repo allowlist, GitHub OAuth — unchanged here. (Cost-exposure hardening is a separate spec.)

## Approach (selected)

**Two-layer redesign + cross-cutting verification visibility.**

Two distinct daily surfaces:
- **`/` — Global home (command center)** — what's going on across all wired repos, what needs you, what shipped recently with verification context, top proposals, repo summary cards.
- **`/repos/[name]` — Per-repo workspace** — single rich page for one repo: in-flight, proposals, recently shipped + verification, cost, settings, pre-scoped brainstorm.

Existing pages (`/proposals`, `/pipeline`, `/cost`, `/activity`, `/features/[issue]`, `/intent`) survive as drill-downs, reachable from Home / Repo Workspace bands. Nav collapses from 7 peer items to 3 primary (Home · Repos · Brainstorm) plus a secondary group.

Verification surfacing is the cross-cutting third leg: per-feature badges (one component, eight surfaces), per-feature evidence tab on `/features/[issue]`, and aggregate metrics on Home + Repo Workspace.

(Two alternates were considered and rejected: a workspace-switcher with one shared layout, and a minimal "top-strip summary + repo workspace upgrade." The two-layer redesign is the only option that fully addresses all three of the user's complaints.)

---

## Information architecture

### Primary nav (3 items)

- **Home** (`/`)
- **Repos** (`/repos`, with `/repos/[name]` as the workspace)
- **Brainstorm** (`/intent`)

### Secondary nav (smaller, grouped)

- Proposals (`/proposals`)
- Pipeline (`/pipeline`)
- Activity (`/activity`)
- Cost (`/cost`)

### Feature detail

- `/features/[issue]` — gains a Verification tab (see Section: Verification surfacing).

### Why

The two questions you actually have when opening the dashboard are "what's going on?" and "what about *this* repo?" Each gets a dedicated surface; everything else is reference. Drill-downs survive for power use but stop being daily entry points.

---

## Global home (`/`)

A vertical stack of seven bands. Order matches how you'd narrate a status report: pressing → happening → done → queued → posture → repos.

### Band 1 — Hero / orientation

A header line scaled to wired-up state:
- **Empty:** "Welcome to dev-agent" + "Wire up your first repo" CTA (preserved from current welcome screen).
- **Wired:** "Good morning. dev-agent is watching N repos. M things need you, K in motion."

Plus a primary **Brainstorm new work** button (large, right side).

### Band 2 — Needs you now

Items at gates awaiting human action, sourced from existing `needsActionFilter` in `lib/pipeline.ts`. Each row: repo · feature title · gate · age · one-click action (Approve / Review PR / View). Caps at ~5 with "see all" link to `/pipeline`. Empty state: "Nothing waiting on you — nice."

### Band 3 — In motion

Features currently being implemented across all repos (workflow runs in progress, branches with open work). Each row: repo · feature · current step · live progress indicator · cancel link. Caps at ~5; "see all" → `/pipeline`. Empty: "No active runs."

### Band 4 — Recently shipped

Last ~7 days of merged features, **with verification chip strip inline** per row. Click → `/features/[issue]`. This is one of two places where verification work becomes visible.

### Band 5 — PM proposes

Top 3–5 active proposals (existing scout output), carry-over before new ideas. Source label · repo · title · "Discuss with PM" link. "See all (N)" → `/proposals`.

### Band 6 — Verification posture (last 7d)

Numeric strip showing what the verification machinery actually did in the last week:

> "Last 7 days: 12 features shipped · 3 audits caught issues fixed pre-merge · 2 risk-flagged for re-review · 1 smoke check failed → resolved · $4.20 spent"

Each metric clickable → drill-down filtered view. This is the second visibility surface for verification work.

### Band 7 — Repo summary cards

Grid of cards, one per wired repo. Card content: name · in-flight count · proposals count · last-shipped age · cost-7d · click → `/repos/[name]`.

### Layout

- Bands 1–3 above the fold; 4–7 below.
- Each band has a defined empty / loading state — no sea of "nothing here."

---

## Per-repo workspace (`/repos/[name]`)

Same band logic as Home, scoped to one repo and richer. The page you keep open while working on a specific project.

### Band 1 — Repo header

- Name, GitHub link, default branch.
- Wired-up state: "Wired ✓ · Last activity 2h ago"
- `.dev-agent.yml` config rendered as compact pills: `cost cap: $5 · model: opus-4.7 · scout sources: issues, plans · blocked paths: 3`
- Edit-config link → opens the file in GitHub.
- Right side: **Brainstorm new work on `<repo>`** button → `/intent?repo=…`.

### Band 2 — In flight on this repo

Richer than the Home version. Each row expands inline (no navigation) to show: gate timeline, live run log link, branch, latest commit, verification chips that have run so far. Click into → `/features/[issue]` for full detail.

### Band 3 — PM proposes for this repo

This repo's slice of `/proposals`. Same carry-over-then-new-ideas grouping, same Discuss/Snooze/Resolve actions. Empty: "PM doesn't see anything pressing for this repo right now. Last scout: 4h ago. Run scout now."

### Band 4 — Recently shipped on this repo

Last ~14 days of merged features, with verification chip strip per row. Same pattern as Home Band 4 but no repo column.

### Band 5 — Verification posture for this repo

Per-repo version of Home Band 6. Aggregate metrics scoped to this repo, plus a small panel listing **which pillars are configured for this repo** (some are universal, some opt-in via `.dev-agent.yml`). User sees at a glance "this repo has Pillar 4 audit and Pillar 7 smoke enabled, Pillar 5 risk-audit not yet."

**Source for "configured pillars":** read from the consumer repo's `.dev-agent.yml` (workflow opt-ins) and from the presence of corresponding workflow files in `.github/workflows/` (universal pillars are always on; opt-in ones surface based on config keys). The implementation plan picks the exact field names; the aggregator exposes a `configuredPillars(repo)` helper.

### Band 6 — Cost (this repo, last 30d)

Tiny chart + total + trend. Click → `/cost?repo=…`.

### Band 7 — Settings & links

Footer-style band: link to `.dev-agent.yml`, link to `pm.md`, link to `SESSION_LOG.md`, link to repo on GitHub, "Unwire this repo" with confirm.

### Layout

- Bands 1–4 above the fold; 5–7 below.
- Band 5 is designed for extension: adding a new pillar's status is a row-append, not a rewrite.
- Repo workspace reachable two ways: nav `/repos` → click card, or Home Band 7 → click card. Same destination.

---

## Verification surfacing

Three layers turn engine-internal pillars into things the user can see.

### Layer 1 — Per-feature verification badges

Standard chip strip rendered next to any feature title across the dashboard. One chip per pillar that ran; outcome encoded by colour + icon:

- `✓ Gate B (3 reviewers)` — green
- `✓ Audit (Pillar 4)` — green
- `⚠ Audit (Pillar 4) — 2 issues fixed` — amber, click → diff
- `⚠ Risk (Pillar 5) — re-review queued` — amber
- `✓ Smoke (Pillar 7)` — green
- `✗ Smoke (Pillar 7) — failed` — red, click → log

Pillars that didn't run for a given feature are omitted (not shown as grey).

The chip strip is **one component** (`<VerificationBadges>`) fed by a normalized `VerificationOutcome[]` per feature. Adding Pillar 8/9/10 later means appending a chip definition.

### Layer 2 — Per-feature evidence drill-down (`/features/[issue]`)

The per-feature page gets a new **Verification** tab/section:

- **Gate timeline** — Gate 1 (spec) → Gate 2 (PR) → Gate 3 (promote), with timestamps and approver.
- **Pillar outcomes** — one expandable card per pillar that ran, with: outcome, what was checked, links to artifacts (EvidenceBundle JSON, audit diffs, risk-flag report, smoke logs, reviewer transcripts).
- **Evidence bundle download** — single link to the frozen Pillar 2 EvidenceBundle for this feature.
- **Cost breakdown** — per-pillar token spend.

**Deep-linking:** verification badges anywhere in the dashboard link to `/features/[issue]?tab=verification&pillar=<id>` so clicking a chip lands the user on the right tab with the right pillar card expanded. The implementation plan picks the exact param names.

When something feels wrong about a shipped feature, this page is the proof surface for the verification system.

### Layer 3 — Aggregate metrics (Home Band 6 + Repo Band 5)

The numeric strip described above, backed by a new module `lib/verification/aggregate.ts`. The aggregator walks GitHub artifacts produced by each pillar (gate-pass labels, audit comments, risk-flag artifacts, smoke logs in workflow runs) and produces a normalized rollup keyed by (repo, time window). Cached 30 min keyed on input hash, mirroring the proposals categorization pattern.

### Where verification chips appear (full inventory)

- Home Band 4 (Recently shipped) — chip strip per row
- Home Band 6 (Verification posture) — aggregate strip
- Repo Workspace Band 2 (In flight) — chip strip per row, grows as pillars complete
- Repo Workspace Band 4 (Recently shipped) — chip strip per row
- Repo Workspace Band 5 (Verification posture) — aggregate + configured-pillars list
- `/features/[issue]` detail — full Verification tab
- `/pipeline` rows — chip strip per card
- `/activity` rows — chip strip where relevant

One component, eight surfaces.

---

## Brainstorm entry points

Make starting new work obvious from every surface; pre-scope context whenever possible so the PM chat doesn't start cold.

- **Global "Brainstorm new work"** — Home Band 1 hero CTA + persistent header button (replaces today's "Brainstorm with PM" header button, same destination, more visible). No repo pre-selected; PM helps you pick.
- **Repo-scoped "Brainstorm on `<repo>`"** — Repo Workspace Band 1 button. → `/intent?repo=<owner>/<name>`.
- **Proposal-driven "Discuss with PM"** — already exists on `/proposals`; preserved.
- **In-flight "Discuss with PM"** — new, on each in-flight feature card across Home Band 3, Repo Workspace Band 2, Pipeline. Pre-loads chat with the existing spec + ask "what should change?". Useful for refining scope mid-build.

The PM chat itself doesn't change — only its entry density goes up.

---

## Onboarding & empty states

The orientation gap isn't fixable by adding a tutorial — it's fixable by making the dashboard speak at every junction.

### Empty-state copy (each band tells you what would put something there)

- **Home Band 2 (Needs you)** empty: "Nothing waiting on you — nice."
- **Home Band 3 (In motion)** empty: "No active runs. Start one with **Brainstorm new work** or pick from **PM proposes** below."
- **Home Band 4 (Recently shipped)** empty: "No features shipped in the last 7 days. Once a feature merges, it lands here with verification badges."
- **Home Band 5 (PM proposes)** empty: "PM has nothing to suggest. Either you're caught up, or no scout sources are wired yet — see [Repo Workspace → Settings] to enable issues / plans / etc."
- **Home Band 6 (Verification posture)** empty: "No verification activity yet — runs will populate this once you ship a feature."
- **Repo Workspace, fresh wire-up:** one-time **Set up checklist** panel: ✓ wired · ☐ pm.md present · ☐ scout sources configured · ☐ first proposal generated · ☐ first feature shipped. Each unchecked item links to the action.
- **No wired repos at all:** keep current welcome screen, expand to a 3-step start guide.

### Persistent help affordance

A **`?` help button** in the header opens a slide-over panel with:
- 30-second "what dev-agent does" pitch.
- The 3 things to do today (top in-flight items + one suggested next action).
- Link to user docs (existing `docs/`) and to a future dashboard tour.

Opt-in only — not a modal that interrupts you.

---

## Component & file changes

### New modules

- **`lib/verification/types.ts`** — `VerificationOutcome`, `VerificationRollup`, `PillarStatus`. Single source of truth for what a "verification result" looks like.
- **`lib/verification/aggregate.ts`** — the verification aggregator. Reads gate-pass labels, audit comments, risk-flag artifacts, smoke-run logs from each pillar; returns `VerificationOutcome[]` per feature and `VerificationRollup` per (repo, window). Cached 30 min keyed on input hash.
- **`lib/dashboard/home-bands.ts`** — server-side data loader for Home; one async function per band so they can `Promise.all`.
- **`lib/dashboard/repo-workspace.ts`** — same pattern for the per-repo workspace.

### New components

- **`components/verification-badges.tsx`** — chip strip; the eight-surface component.
- **`components/feature-card.tsx`** — unified row used in Home Band 2/3/4 and Repo Workspace Band 2/4. Composes title + repo + age + verification badges + actions.
- **`components/repo-card.tsx`** — Home Band 7 grid card.
- **`components/verification-posture-strip.tsx`** — Home Band 6 / Repo Workspace Band 5 numeric strip.
- **`components/setup-checklist.tsx`** — Repo Workspace fresh-wire-up panel.
- **`components/help-panel.tsx`** — header `?` slide-over.
- **`components/empty-state.tsx`** — reusable empty-state component (icon + title + body + optional CTA).

### Modified files

- **`dashboard/app/page.tsx`** — rebuilt as the 7-band Home.
- **`dashboard/app/repos/[name]/page.tsx`** — rebuilt as the 7-band Repo Workspace.
- **`dashboard/app/features/[issue]/page.tsx`** — adds the Verification tab.
- **`dashboard/components/nav-header.tsx`** — collapses to 3 primary + secondary; promotes "Brainstorm new work" button; adds `?` help affordance.
- **`dashboard/components/inbox-list.tsx`** — refactored into / consumed by the *Needs you* band.
- **`dashboard/components/feature-detail.tsx`** — receives the new Verification tab.

### Existing pages preserved unchanged

`/proposals`, `/pipeline`, `/cost`, `/activity`, `/intent` — current behaviour preserved. Become reference drill-downs from Home / Workspace bands. Only nav placement changes.

---

## Build sequence (rough phasing)

Each step ships independently with its own verify gate. Detailed sequencing is the implementation plan's job; this is the architectural ordering.

1. **Verification aggregator + types** — no UI yet. Define `VerificationOutcome` / `VerificationRollup`, build `lib/verification/aggregate.ts`, write tests against fixtures of real gate/audit/smoke artifacts. *Verify: aggregator returns correct rollup for a known set of features.*
2. **`<VerificationBadges>` + `<FeatureCard>` + `<EmptyState>` components** — pure UI, fed by aggregator output. Stand them up in isolation. *Verify: tests render expected output for known `VerificationOutcome[]`.*
3. **Home redesign (7 bands)** — rebuild `app/page.tsx`. *Verify: home renders all bands with realistic data; empty states correct.*
4. **Repo workspace redesign (7 bands)** — rebuild `app/repos/[name]/page.tsx`. *Verify: workspace shows all bands with this repo's data.*
5. **Feature detail Verification tab** — extend `app/features/[issue]/page.tsx`. *Verify: clicking any verification badge from any surface lands on the right tab with the right pillar expanded.*
6. **Nav simplification + help panel + setup checklist** — header redesign and orientation surfaces. *Verify: nav has 3 primary items, help panel opens, fresh-wired repo shows checklist.*

Steps 1–2 are foundational and unblock 3–6 in parallel.

---

## Sub-task: verification aggregator design

`lib/verification/aggregate.ts` is small but its data contract is load-bearing for everything else. The implementation plan must define `VerificationOutcome` and `VerificationRollup` first, before any UI work begins.

`VerificationOutcome` (per-feature) needs at minimum:
- `feature_id` (issue number)
- `pillar` (enum: gate_b, audit_p4, risk_p5, smoke_p7, evidence_p2, …)
- `status` (enum: passed, blocked, advisory, failed, not_run)
- `summary` (one-line human-readable)
- `details_url` (link to the source artifact: PR comment, action log, file)
- `cost_usd` (optional, where measurable)

`VerificationRollup` (per repo + window) aggregates `VerificationOutcome[]` into the numeric strip's metrics. Exact shape is the implementation plan's first decision.

---

## Open questions

- (None blocking implementation. Aggregator data shape is decided in the plan as the first task.)

## Related work

- Industry-grade verification initiative (`feat/industry-grade-verification` — produces the verification artifacts this design surfaces).
- Cost-exposure hardening — separate spec to be written; covers `ALLOWED_GH_USERNAMES` audit, per-day token cap, rate-limiting on Anthropic-spending endpoints, Anthropic console spend cap.
