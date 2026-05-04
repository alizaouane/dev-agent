# dev-agent Dashboard v2 — PM agent + proactive proposals

**Date:** 2026-05-04
**Owner:** ali.zaouane@hotmail.com
**Status:** Implemented (PRs #33–#51, shipped under engine v0.5.0).
**Supersedes:** [2026-05-03 dashboard v1 design](./2026-05-03-dev-agent-dashboard-design.md) — dashboard v1 was a viewer; v2 makes the dashboard the primary surface and adds a conversational PM agent that proposes work proactively.
**Engine version:** unchanged from v0.4.0; this is purely a dashboard-layer evolution.

> Dashboard v1 was a passive viewer over the engine's GitHub-issue state. The user observed that the product still felt like "a dev tool with a dashboard bolted on" because every flow started in the terminal (`/develop <url>` slash command). v2 turns the dashboard into the place where work *starts*, and adds a PM-persona agent that surfaces work proactively from the user's repos.

---

## Context

**Problem.** Two real frictions surfaced after v1 shipped:

1. **The terminal entry point was a deal-breaker.** Even a fully working pipeline doesn't feel like a product when step 0 is "open Claude Code, run a slash command." Phone-from-bed approval doesn't compose with a CLI prerequisite.
2. **The user had to file every issue themselves.** v1's pipeline reacted to issues but never proposed any. The user kept saying "what should I work on?" and the dashboard's only answer was the inbox of *already-filed* work.

**Intended outcome.** A web dashboard where: (a) the user can pitch a feature in 1–3 sentences and have the PM agent push back, scope it, and dispatch the implement workflow — without ever opening a terminal; and (b) the dashboard surfaces work the agent thinks the user should consider — both carry-over commitments (unfinished plans, dangling specs) and net-new ideas (untriaged issues, competitor moves, agent-found bugs).

The terminal `/develop` slash command remains as a power-user fallback but is no longer the primary path.

---

## Goals

- **Dashboard-first.** Every common flow has a UI entry point. Terminal is optional.
- **PM agent owns proposals + intake.** A single conversational agent persona handles both proactive scout-driven proposals AND user-pitched ideas. Same prompt, same memory.
- **Persistent PM memory in the consumer repo.** `.dev-agent/pm.md` (frontmatter + free-form) lets the user encode goals, things to avoid, and recent decisions. The PM reads it on every interaction; it can also propose updates after meaningful chats.
- **Proposals queue with snooze.** A `/proposals` page enumerating findings from every scout source, grouped into carry-over vs new-idea. Each proposal supports "Discuss with PM" (handoff to the chat) and "Snooze 7d" (decided not-now).
- **Single-pick recommendation.** A `/next` page that has the PM rank the queue and pick one thing with reasoning + effort + risk.
- **Goal-aligned ranking.** PM's prioritization is grounded in `pm.md` goals + active pipeline. Re-proposing recently-rejected items is forbidden.
- **One-click onboarding.** No more "open the consumer repo, paste this, paste that." `/repos` lists every accessible GitHub repo and a "Wire up" button drops the config + workflows + `pm.md` directly to the default branch (no PR review noise).
- **One Anthropic key, every repo.** The dashboard auto-pushes its own `ANTHROPIC_API_KEY` (encrypted via libsodium sealed box) into each consumer repo's Actions secrets when wiring up. Set once on Vercel; flows everywhere.

## Non-Goals (v2 scope)

- Replacing the engine's pipeline workflows. v2 is dashboard + PM only; the implement / staging-deploy / promote-to-prod workflows are unchanged from v0.4.0.
- Persistent multi-device chat state. localStorage handles "I refreshed my tab"; cross-device sync is deferred.
- Server-side proposal / recommendation persistence. The dashboard is stateless beyond an in-memory cache; cold starts re-derive from GitHub + pm.md.
- Charting / analytics surfaces beyond what v1 already had (`/cost`, `/activity`). Those didn't change.

---

## Architecture

The dashboard is the same Next.js 15 App-Router app as v1, evolved. Three new architectural primitives:

1. **PM persona** — a system prompt at `prompts/pm.md` (engine-side) with an embedded copy at `dashboard/lib/pm-prompt.ts` (Vercel can't reach `../prompts/`). Renders with per-repo context: `consumer_root`, `pm_notes_body`, `goals`, `avoid`, `recent_decisions`, `current_pipeline`, `request`. Used by both the streaming chat (`/intent`) and the non-streaming recommendation (`/next`).

2. **`.dev-agent/pm.md`** — the PM's persistent memory in the consumer repo. Zod-validated frontmatter (`goals`, `avoid`, `recent_decisions`, `competitors`, `last_updated`) plus a free-form markdown body. Read by the PM at runtime; updates proposed by the PM during chat are surfaced as a one-click PR.

3. **Scout layer** — modular sources under `dashboard/lib/scout/` that each produce `Proposal`s tagged with a `ProposalSource`. Aggregated by `runAllScouts(octokit, wiredRepos)`. New sources slot in by adding a file, an entry in `ProposalSource` / `SOURCE_TO_GROUP`, and a `SOURCE_LABEL` entry on the page.

4. **In-memory caches** — proposal-snooze map (`scout/snooze.ts`), recommendation TTL cache (`lib/next-cache.ts`). Single-user-shaped, cold-start eviction acceptable. Multi-tenant later.

Routing surface (added on top of v1):

```
/repos               — repos index with wire-up button (was missing in v1)
/intent              — was a one-shot form; now a streaming PM chat
/proposals           — new: PM's proposal queue
/next                — new: PM's single-pick recommendation
/api/pm-chat         — new: streaming Route Handler for the chat
```

Existing v1 routes (`/`, `/pipeline`, `/cost`, `/activity`, `/repos/[name]`, `/features/[issue]`) retain their shapes; `/repos/[name]` was missing the actual index page and now has one.

---

## Repo discovery + onboarding (v2.0)

**Spec:** `/repos` enumerates every GitHub repo the authenticated user can see, partitioned into "Wired up" (has `.dev-agent.yml` at the default branch) and "Available to wire up" (everything else accessible). The wire-up button calls a server action that:

1. Verifies `write` permission on the target repo.
2. Pushes the dashboard's `ANTHROPIC_API_KEY` into the consumer repo's Actions secrets via libsodium sealed-box encryption (GitHub never sees plaintext). Failures are non-fatal — the PR body explains.
3. Commits four files **directly to the default branch** (no PR): `.dev-agent.yml`, `.github/workflows/dev-agent.yml`, `.github/workflows/dev-agent-bug-scout.yml`, `.dev-agent/pm.md`.
4. Redirects back to `/repos`.

**Discovery policy:**
- Personal repos: filter by `ALLOWED_GH_USERNAMES` if set, else allow.
- Org repos: filter by `ALLOWED_GH_ORGS` if set, else allow (so a user admitted via `ALLOWED_GH_USERNAMES` who works primarily in org-owned repos isn't invisible).
- Repos appear with a `wired_up: boolean` flag — empty `.dev-agent.yml` lookup → `false`. Pipeline / cost / activity views filter to wired only via `wiredRepos()`.

**Why direct-commit, not PR:** single-user reviewing their own two-config-file changes is friction without value. The diff lives in git history regardless. Branch-protected default branches will 422 — the inline error surfaces; user can relax protection or paste manually.

---

## In-browser PM chat (v2.1)

**Spec:** `/intent` is a streaming chat with the PM persona. The user picks a wired-up repo, types a 1–3 sentence pitch, and the PM evaluates it.

**Streaming.** Vercel AI SDK v6 (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/react`) over a Next.js Route Handler at `/api/pm-chat`. Each turn re-fetches the selected repo's `pm.md` + active pipeline so the PM's context is always current; chat history travels in the request body.

**Model.** `claude-opus-4-7`. The PM's reasoning is the highest-value place for the strongest model.

**Convergence.** The PM is prompted to end with a `## Agreed scope` section when the user has converged on something. The dashboard parses that section (tolerant of heading variations: `### Agreed scope`, `Agreed Scope:`, `Agreed scope —`) and exposes an "Approve and start" button. Clicking it:

1. Files a GitHub issue with the agreed scope as the body and labels `kind:user-intent`, `state:implementing`.
2. Dispatches the consumer's `dev-agent.yml` workflow with `phase=implement`.
3. Redirects to the dashboard's feature page.

The implement workflow uses the issue body as the spec when no `docs/specs/<slug>.md` is linked — this path was already validated in v1's drill issues.

**Persistence (v2.5).** Conversation state survives page reloads via localStorage (`dev-agent:pm-chat:draft:v1`). Messages, selected repo, title input, and textarea draft are all persisted. On approve-and-start, the draft is cleared optimistically; on action failure, restored. A "Clear conversation" button drops the draft explicitly. Multi-device sync is deferred.

**PM proposes pm.md updates (v2.6).** When the PM agrees on a meaningful decision (a new goal worth tracking, a rejection pattern that should become an `avoid` entry), it emits a `## pm.md update` block followed by a fenced markdown block with the FULL replacement file. The dashboard parses the fence, surfaces an "Apply (opens PR)" button next to the chat, and a click opens a PR replacing `.dev-agent/pm.md` with the new content. The user reviews the diff in the PR before merge.

**URL-prefilled chat.** `/intent?prefill=<text>&repo=<owner/name>` seeds the input + repo. Used by `/proposals` and other surfaces to drop the user into the chat with a specific pitch.

---

## Proposals queue (v2.3 + v2.6)

**Spec:** `/proposals` aggregates every scout source across every wired-up repo into a single page, grouped by:

- **Carry-over commitments** (highest leverage — finishing what's already in motion):
  - `unfinished_plan` — unchecked `- [ ]` items in `docs/plans/*.md`
  - `spec_drift` — specs in `docs/specs/` whose code has unresolved `TODO(<slug>)` / `FIXME(<slug>)` markers
  - `pending_spec` — specs with no tracking issue (open or closed) — approved but unimplemented
  - `bug_scout_finding` — issues filed by the bug-scout agent (security / broken_logic / code_smell)
- **New ideas:**
  - `untriaged_issue` — open issues with no `state:*` label that never entered the pipeline
  - `competitor_watch` — competitors declared in `pm.md` frontmatter, surfaced as "review them" prompts

Each proposal has:
- A direct link to the underlying GitHub artifact.
- A **Discuss with PM** button → `/intent?prefill=<pitch>&repo=<r>`, kicks off a brainstorm with that proposal as the pitch.
- A **Snooze 7d** button → in-memory map keyed by `username::proposal_id`, hides the proposal for 7 days. Per-user, cold-start evicts. Re-snooze if it matters again. Permanent dismissal happens via the underlying artifact (close the issue, check the box, etc.) or via PM-proposed `pm.md` `recent_decisions`.
- A `?show_snoozed=1` toggle reveals a Snoozed section with **Un-snooze** buttons.

**Source-specific surfacing notes:**
- `bug_scout_finding`: filters by labels `kind:bug-scout,state:proposed`. Sorted by severity (high > medium > low) then by age within tier (oldest first).
- `pending_spec`: filters out specs whose slug appears in any open or closed issue's title/body (heuristic for "in flight or shipped"). Errs toward surfacing on search-API failure.
- `competitor_watch`: minimal-by-design — emits one proposal per `competitors` entry in `pm.md`, with the URL. Real LLM-backed competitor analysis happens in the PM chat when the user clicks Discuss; no per-load fetch/analysis (would put $0.05+ on every page load).

---

## /next: single-pick recommendation (v2.4 + v2.5)

**Spec:** `/next` calls the PM in `request: recommend_next` mode and renders a markdown card:

```
### Recommendation
> Do **<title>** (`<repo>`).

### Why
<one or two sentences referencing a goal or carry-over commitment>

### Effort
<concrete estimate>

### Watch out for
<single risk or trade-off>
```

**Inputs to the PM call:**
- Aggregated `pm.md` content from all wired-up repos (each line tagged with `[repo]` so the PM can cross-reference goals).
- The full proposal queue (formatted with carry-over above new-ideas).
- The active pipeline (in-flight issues by state).

**Cost.** ~$0.05–$0.15 per call (claude-opus-4-7). Cached 30 minutes, keyed by `username::sortedProposalIds`. Cache invalidates automatically when the proposal queue changes; "Regenerate (uses tokens)" button forces a fresh call when the user wants one before TTL.

**Empty/error states.** No wired repos → CTA to `/repos`. `ANTHROPIC_API_KEY` unset → amber banner pointing at Vercel env settings. PM call fails → surfaces the error inline; recommendation hidden.

---

## PM persona contract (v2.1, refined through 2.6)

`prompts/pm.md` defines the persona used by both the chat and `/next`. Highlights:

- **Conversational, opinionated, cite reasoning.** Pushes back when the user's pitch conflicts with `pm.md` goals or in-flight work.
- **Six proposal sources ranked by default priority.** Carry-over commitments (1–3) above new ideas (4–6).
- **Four invocation modes.** `evaluate_idea`, `prioritize_queue`, `recommend_next`, `address_question`.
- **Discipline:** don't write code or specs (upstream of those); don't re-propose recently-rejected items; surface trade-offs honestly; propose `pm.md` updates after meaningful decisions; be conversational not formal.
- **Output format conventions:**
  - `## Agreed scope` block when the chat converges on something to build (parsed by the Approve-and-start button).
  - `## pm.md update` + fenced ` ```markdown ` block when the PM wants to propose a memory update (parsed by the Apply button).

---

## Acceptance criteria

- [x] **/repos** lists wired + available repos; wire-up button drops 4 files directly on default branch + pushes `ANTHROPIC_API_KEY` secret.
- [x] **/intent** streams PM chat; Approve-and-start button activates on `## Agreed scope`; chat survives page reloads via localStorage; `## pm.md update` blocks render an Apply button.
- [x] **/proposals** aggregates 6 scout sources, grouped carry-over / new-idea, with Discuss-with-PM and Snooze-7d affordances; "Show snoozed" toggle.
- [x] **/next** renders PM's single-pick recommendation; cached 30 min; "Regenerate" button bypasses cache.
- [x] All scout sources have unit tests; the cache helpers, draft helpers, and PM extractors have unit tests; the wire-up template files have a drift detector against `examples/web-app-template/`.
- [x] No new database; GitHub issues + `pm.md` are the only persistent state.
- [x] All Anthropic calls cap at known costs; cost is documented per-feature in this spec.

## Out of scope (deferred enhancements)

- Multi-device chat state sync (server-backed draft store).
- Persistent snooze across cold starts (label-based or pm.md-list-based).
- Real-time `/proposals` updates (SSE).
- Per-load competitor URL fetching + LLM analysis (current minimum is "go review them" with the chat doing real analysis on demand).
- Stale-blocked-issue scout source (declared in `ProposalSource` but not yet implemented).
