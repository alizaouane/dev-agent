# PM via Claude Code — `/develop` end-to-end through skills

**Date:** 2026-05-26
**Owner:** ali.zaouane@hotmail.com
**Status:** Approved (brainstorm complete; ready for plan)
**Supersedes (partially):** [2026-05-04 PM agent dashboard v2](./2026-05-04-pm-agent-dashboard-v2.md) — the dashboard's PM chat (`/intent` + `/api/pm-chat`) is retired. The PM persona, `.dev-agent/pm.md`, proposals queue, and approval gates are unchanged.

---

## Context

**Problem.** Today the dashboard's PM chat ([dashboard/app/api/pm-chat/route.ts](../../../dashboard/app/api/pm-chat/route.ts) + [dashboard/components/pm-chat.tsx](../../../dashboard/components/pm-chat.tsx)) runs on the Vercel AI SDK with seven hand-rolled tools. It cannot invoke Claude Code skills because skills live on the user's local filesystem (`~/.claude/`) and the dashboard is hosted. The user's complaint is twofold:

1. **"Not user-friendly."** A single textarea streaming plain markdown is the wrong surface for brainstorming + spec writing. No structured Q&A, no multi-choice prompts, no checklist tracking, no plan-vs-design separation, no spec file output. The actual skill methodologies (`superpowers:brainstorming`, `superpowers:writing-plans`) do exactly this and produce on-disk artifacts.
2. **"Doesn't use Claude Code."** The user lives in Claude Code daily. Re-implementing the brainstorming methodology inside the dashboard means rebuilding what superpowers already does well — server-side, in a textarea, with worse ergonomics.

**The two pivots that resolve this:**

- The PM moves from "dashboard chat" to "Claude Code slash command." The user is the primary PM operator, and the user lives in Claude Code.
- Spec + plan become **first-class on-disk artifacts** committed to the consumer repo, not prose embedded in issue bodies. The dashboard's role narrows to proposals, approvals, and engine orchestration.

**Intended outcome.** A single `/develop` command in Claude Code that runs PM evaluation → spec brainstorming → plan writing → handoff to the dashboard, using the user's installed superpowers skills. The dashboard surfaces the resulting issue with `state:spec-ready` and the existing approve-and-implement flow takes over.

---

## Goals

- **Claude Code as the PM surface.** All thinking work (PM evaluation, spec brainstorming, plan writing) runs in Claude Code via skills.
- **Dashboard owns coordination.** Proposals queue, "what should I do next?", approval gates, status, cost, activity — unchanged. Phone-from-bed approval still works.
- **Single command for the full flow.** `/develop` chains PM → brainstorm → plan → handoff. No multi-command choreography for the common case.
- **Artifacts on disk.** Spec lands in `docs/superpowers/specs/`, plan in `docs/plans/`, both in the **consumer** repo. Issue body links to them.
- **Resumable.** Closing the laptop mid-brainstorm doesn't lose work — superpowers skills write incrementally; restarting picks up where you left off.
- **Backward-compatible engine.** The implement workflow (`phase-implement.yml`) reads spec from a linked file but falls back to issue body if no link is present, so in-flight features mid-migration keep working.

## Non-Goals

- **Multi-user PM in Claude Code.** Single-user (you). Multi-tenant brainstorming is not a target.
- **Replacing the engine's pipeline workflows.** `phase-implement.yml`, `phase-staging-deploy.yml`, `phase-promote-to-prod.yml` are untouched except for the spec-from-file read mentioned above.
- **Persistent dashboard-side brainstorm state.** No more localStorage drafts for the chat — Claude Code's session state replaces it.
- **A general-purpose audience for in-dashboard brainstorm.** The `/intent` page is retired, not preserved as a "Lite mode" fallback. Future broader-audience needs can re-introduce it as a separate spec.

---

## Architecture

`/develop` is a Claude Code slash command (in the dev-agent plugin's `commands/` directory) that orchestrates four phases. Each phase reads context, invokes a skill or persona, writes artifacts, then hands off to the next.

```
┌───────────────────────────────────────────────────────────────────────┐
│  /develop [pitch | --from-issue <#> | (interactive)]                 │
└───────────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
  Phase 1: PM eval         Phase 2: Spec brainstorm   Phase 3: Plan writing
  • Loads pm.md             • Invokes                  • Invokes
    pipeline,                 superpowers:               superpowers:
    SESSION_LOG               brainstorming              writing-plans
  • Persona from              seeded with the          • Spec doc as input
    prompts/pm.md             agreed scope             • Plan doc to
  • Pushes back,            • Spec doc to                docs/plans/
    scopes,                   docs/superpowers/
    "Agreed scope"            specs/
                                  │
                                  ▼
                          Phase 4: Handoff
                          • Commit spec + plan
                            to consumer repo
                          • Create issue with
                            state:spec-ready
                          • Link spec + plan
                            in body
                                  │
                                  ▼
                          Dashboard sees issue,
                          existing approve-and-
                          start flow runs.
```

Each phase is structured so you can re-enter at any point (`/develop --resume`, `/develop --from-spec <path>`) without re-doing the previous phase.

---

## Slash command surface

One command, four invocation modes:

| Invocation | What it does |
|---|---|
| `/develop <pitch>` | Full flow. Starts at Phase 1 with the pitch as the seed. |
| `/develop --from-issue <#>` | Starts at Phase 1 with the GitHub issue's title + body as the seed. Used when starting from a proposal the dashboard surfaced. |
| `/develop` | Interactive. Lists pending proposals (`gh issue list --label state:proposed`), asks you to pick one or pitch fresh. |
| `/develop --resume` | Re-enters the most recent in-flight brainstorm based on the latest non-committed spec draft in `docs/superpowers/specs/`. |

**Why evolve `/develop` instead of adding `/pm`:** the README already documents `/develop` as the Gate 1 entry point. The PM persona is the *opening turn* of `/develop`, not a separate command. Two commands for "start a feature" is friction; users would ask "which do I use?"

**Repo selection.** The command auto-detects the consumer repo from `cwd` if `.dev-agent.yml` is present in the working tree. Otherwise it asks (or accepts `--repo owner/name`). For non-cloned repos, see "Consumer repo not cloned locally" below.

---

## Phase details

### Phase 1 — PM evaluation

Loads the same context the current dashboard chat loads, via `gh` CLI calls:

- `.dev-agent/pm.md` (frontmatter goals + free-form body)
- Current in-flight pipeline (open issues with `state:scoping|spec-ready|implementing|pr-review`)
- Recent `SESSION_LOG.md` entries (top N — start with 10)
- The PM persona prompt from `prompts/pm.md`

The Claude Code agent runs the persona conversation in the terminal. The user can pitch, push back, ask "what's in flight?", get scope guidance. Same behavior as today's dashboard chat, but with full terminal UX (multi-line input, scrollback, copy-paste of file references, real conversation history).

**Exit condition:** the PM emits an `## Agreed scope` section. That section becomes the seed for Phase 2.

### Phase 2 — Spec brainstorming

`/develop` automatically invokes `superpowers:brainstorming` once Phase 1 hits "Agreed scope." The skill is seeded with:

- The agreed scope from Phase 1
- The pitch / source issue
- The repo context already loaded in Phase 1

The brainstorming skill drives its own checklist (clarifying questions one at a time, propose 2-3 approaches, present design sections, get approval) and writes the spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.

**Exit condition:** the brainstorming skill writes + commits the spec, completes its self-review loop, and the user approves the written spec.

### Phase 3 — Plan writing

Brainstorming's defined terminal state is "invoke writing-plans." `/develop` honors that by invoking `superpowers:writing-plans` with the spec as input. The skill produces `docs/plans/YYYY-MM-DD-<topic>-plan.md`.

**Skill-handoff conflict.** `superpowers:writing-plans` ends with its own "Execution Handoff" prompt (subagent-driven vs inline) and starts executing the plan locally if the user picks either option. That is the **wrong** terminal state inside `/develop`: dev-agent's engine implements the plan via the consumer's GitHub Actions, not via local Claude Code. The `/develop` command instructs the orchestrator to ignore the writing-plans execution prompt and proceed directly to Phase 4 once the plan is committed.

**Exit condition:** the plan is written and committed. No local execution kicks off.

### Phase 4 — Handoff

The `/develop` command:

1. Confirms spec + plan are committed to the consumer repo (default branch unless the repo policy requires a PR — see "Spec/plan branch policy" below).
2. Creates a GitHub issue on the consumer repo via `gh issue create`:
   - **Title:** the feature title from the spec doc's H1.
   - **Body:** `Spec: <link to spec file>`, `Plan: <link to plan file>`, plus the spec's first paragraph as a TL;DR.
   - **Labels:** `state:spec-ready`. If `--from-issue <#>` was used, copy the source issue's `kind:*` label (e.g. `kind:feature`, `kind:bug`). Otherwise default to `kind:feature`.
3. Prints the issue URL and stops. The user can now go to the dashboard (or wait for the proposal queue to refresh) and tap "Approve and start implementation" — same UI as today.

---

## Artifact storage

| Artifact | Path | Owner | Lifecycle |
|---|---|---|---|
| PM persona prompt | `prompts/pm.md` (dev-agent repo) | dev-agent maintainer | Edited when persona evolves |
| `/develop` command | `commands/develop.md` (dev-agent repo) | dev-agent maintainer | Edited when phases evolve |
| PM memory | `.dev-agent/pm.md` (consumer repo) | User; PM proposes updates | Per-feature edits via PR |
| Spec doc | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (consumer repo) | brainstorming skill | Committed at end of Phase 2 |
| Plan doc | `docs/plans/YYYY-MM-DD-<topic>-plan.md` (consumer repo) | writing-plans skill | Committed at end of Phase 3 |
| GitHub issue | Consumer repo, labeled `state:spec-ready` | `/develop` Phase 4 | Created at end of Phase 4 |
| Implementation branch | `feat/dev-agent-issue-<n>` (consumer repo) | `phase-implement.yml` | Created when user approves the issue |

The **consumer repo** is the single source of truth for spec + plan + state. dev-agent's role is to provide the command, the persona, and the engine.

### Spec/plan branch policy

**Default:** commit spec + plan directly to the consumer repo's default branch. They are documentation, not code; they don't require code review.

**Optional (per consumer repo via `.dev-agent.yml`):** `spec_plan_via_pr: true` makes `/develop` commit to a `dev-agent/spec-<topic>` branch and open a PR for the spec + plan. The handoff issue is filed only after the PR merges. Slower but adds a review checkpoint for consumers that want it.

Start with default-branch commits. The PR option is a v1.1 feature unless a consumer asks for it.

---

## Dashboard ↔ Claude Code bridge

Three handoff directions, all using simple primitives:

### 1. Dashboard → Claude Code (start from proposal)

On `/proposals` and `/next`, each proposal card gets a **"Brainstorm in Claude Code"** button. Clicking it copies a one-liner to the clipboard:

```
/develop --from-issue 123
```

Plus a toast: "Paste into Claude Code." No deeplink, no URL handler registration, no OS-specific glue. Copy-paste works everywhere Claude Code does.

**Why not a deeplink (`claude://...`):** deeplinks require URL-handler registration that varies by OS, brittle on Linux/headless, and there's no benefit over a single line on the clipboard. Revisit if Claude Code ships a stable deeplink scheme.

### 2. Claude Code → Dashboard (after spec/plan ready)

`/develop` Phase 4 creates a GitHub issue with `state:spec-ready`. The dashboard's existing repo watcher (`listAllowedRepos` + per-page issue fetches) picks it up on the next page load. **No new dashboard endpoint, no webhook, no polling job needed** — the existing data path already surfaces all `state:*` issues.

### 3. Claude Code → Dashboard (mid-brainstorm pause)

Closing the laptop mid-brainstorm doesn't lose work:

- The brainstorming skill writes the spec incrementally to disk.
- Re-running `/develop --resume` reads the latest non-committed spec draft in `docs/superpowers/specs/` and re-enters at the right phase.
- No dashboard state to sync — the spec file is the state.

---

## Migration: retiring the dashboard PM chat

The current `/intent` page and `/api/pm-chat` route are removed in one migration step:

1. **Remove the route.** Delete [dashboard/app/api/pm-chat/route.ts](../../../dashboard/app/api/pm-chat/route.ts), [dashboard/components/pm-chat.tsx](../../../dashboard/components/pm-chat.tsx), [dashboard/lib/pm-tools.ts](../../../dashboard/lib/pm-tools.ts), [dashboard/lib/pm-chat-draft.ts](../../../dashboard/lib/pm-chat-draft.ts), [dashboard/lib/pm-md-update.ts](../../../dashboard/lib/pm-md-update.ts), and their tests.
2. **Replace `/intent`.** The `/intent` route becomes a static page: a one-paragraph explainer ("Brainstorming happens in Claude Code now") + a code block showing the `/develop` command + a link to install instructions if `claude` isn't installed.
3. **Drop `applyPmMdUpdate`.** The PM persona, now invoked via Claude Code, can write `pm.md` updates directly via the local filesystem or via `gh api` — no dashboard PR flow needed. Remove the server action, the `## pm.md update` parser in the chat component (already gone with the chat), and the apply-PR plumbing in [dashboard/lib/actions.ts](../../../dashboard/lib/actions.ts). If a CLI-less workflow becomes needed later, re-introduce as a separate spec.
4. **Keep `approveAndStart` server action.** The "Approve and start implementation" button on `/proposals` and `/features/[issue]` is unchanged. It reads the issue body, dispatches the implement workflow. The body now contains spec + plan *links* instead of the full spec prose, so:
5. **Update `phase-implement.yml`** to read the linked spec/plan files when present, fall back to issue body when not. Backward-compatible for in-flight features that were filed under the old flow.

**Mid-migration:** in-flight features filed via the old dashboard chat still implement correctly (their issue body has the embedded spec; `phase-implement.yml` falls back). New features go through `/develop`. No big-bang cutover.

---

## Engine changes

Minimal. Only `phase-implement.yml` changes:

**Today:**

```yaml
- name: Extract spec from issue body
  run: echo "${{ github.event.issue.body }}" > /tmp/spec.md
```

**New:**

```yaml
- name: Resolve spec + plan paths
  id: resolve
  run: |
    # If the issue body contains "Spec: <path>" links, fetch those files.
    # Otherwise fall back to the issue body itself (legacy features).
    # Output spec_path and plan_path, or spec_inline=true.
```

The downstream `claude-code-action@v1` invocation references the resolved paths so the implementer has spec + plan as separate files (richer than today's single-prose-blob).

No other engine changes. `phase-staging-deploy.yml`, `phase-promote-to-prod.yml`, the scout phases, the verification pillars — all untouched.

---

## Edge cases

**Consumer repo not cloned locally.** Phase 1 needs `pm.md`, pipeline, SESSION_LOG. The command auto-detects:

- If `cwd` contains `.dev-agent.yml`, read files from `cwd` directly.
- Otherwise, use `gh api` to fetch from the default branch. Slower (one round-trip per file) but doesn't require a local clone.

For Phases 2-4, a local clone is needed because `superpowers:brainstorming` and `superpowers:writing-plans` write files. If no clone, the command offers to `gh repo clone` into a `~/.dev-agent/clones/<owner>-<name>/` directory and uses that.

**Two specs in the same direction.** The PM persona's existing carry-over-check behavior covers this: when Phase 1 loads the pipeline + recent SESSION_LOG, it sees the duplicate and pushes back ("there's already a spec for X in flight; finish that first or explain what's different"). Same behavior as today.

**Spec/plan written but never approved.** If the user exits before Phase 3 completes, the spec file may already be committed (brainstorming skill commits at end of Phase 2). In that case:

- No handoff issue is filed (Phase 4 never ran). The spec is an orphan draft in `docs/superpowers/specs/`.
- `/develop --resume` picks it up on next invocation and continues at Phase 3.
- If the user wants to abandon, they delete the spec file manually (or via a future `/develop --abandon <topic>` — v1.1).

No `state:draft` issue label needed for v1, because no issue exists until Phase 4 succeeds. This keeps the dashboard's `state:spec-ready` invariant clean (every issue dev-agent surfaces at this state has both spec + plan ready).

**Multiple consumer repos with brainstorms in flight.** Each gets its own spec/plan file (dated, topic-named, no collision). The dashboard's existing per-repo views handle the rest.

**Brainstorming skill version drift.** `/develop` invokes whatever version of `superpowers:brainstorming` is installed in the user's Claude Code. If the skill changes its output format, the spec file path convention (`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`) should stay stable so the engine's spec-path resolver keeps working. Document a tested superpowers version in [README.md](../../../README.md) under "Install" so the user knows which version `/develop` was validated against.

---

## Open questions for the plan phase

- **Command implementation language.** `commands/*.md` are prompt files Claude Code reads as slash-command definitions. The orchestration logic (auto-chaining Phase 1 → 2 → 3 → 4) is prompt instructions, not code. Should the prompt include explicit "now invoke `superpowers:brainstorming`" steps, or rely on the model to chain naturally? Lean toward explicit; the plan should specify the prompt structure.
- **Where does Phase 4's GitHub issue creation actually run?** A bash command via the slash command's tools (`gh issue create`), or a dedicated MCP tool? Bash is simpler and reuses `gh` auth.
- **`/intent` removal sequencing.** Remove in one PR vs. add `/develop` first, deprecate `/intent` (with a banner), then remove. Lean toward the first since you're the only user.

---

## Testing strategy

- **Manual end-to-end on a real consumer repo.** Run `/develop "add X feature"` on `caliente-booking-app` or `social-media-content`, verify spec + plan land, issue gets filed, dashboard sees it, approve-and-start triggers the engine.
- **Unit tests for the engine's spec-path resolver.** Mock issue bodies (linked vs inline), assert correct resolution.
- **Snapshot the `/develop` prompt.** Regression-guard against accidental changes to the orchestration instructions.
- **Smoke test the migration.** Verify a pre-migration in-flight feature (with spec inline in the issue body) still implements correctly under the new resolver.

No new CI surface; reuse the existing test runner.

---

## Out of scope (defer)

- Deeplink / URL-handler for "Open in Claude Code"
- Voice / mobile-side brainstorming
- Multi-user PM with shared `.dev-agent/pm.md`
- Spec/plan via PR (v1.1, gated by `.dev-agent.yml` flag)
- A "lite" in-dashboard brainstorm for non-Claude-Code users
- Auto-running scouts from the dashboard with handoff into `/develop --from-issue`
