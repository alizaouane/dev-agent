# Bug-scout agent

**Date:** 2026-05-04
**Owner:** ali.zaouane@hotmail.com
**Status:** Implemented (PR #51, shipped under engine v0.5.x).
**Engine version:** Adds the `phase-bug-scout.yml` reusable workflow + dashboard surface; doesn't change any existing engine workflow.

---

## Context

**Problem.** The dev-agent's existing scout sources are deterministic — they read GitHub state (plans, issues, specs). They surface what *the team has explicitly written down*. They don't find bugs the team didn't know it had.

A first attempt (#49, closed) detected recurring CI failures as a "bug signal." That's a runtime signal, not a code-scanning agent. The user clarified: they want an LLM agent that **reads the codebase regularly** for security vulnerabilities, broken logic, and likely-bug code smells.

**Intended outcome.** A daily scheduled scan that runs Claude over the consumer's codebase, files real findings as GitHub issues, and surfaces them on the dashboard's `/proposals` page distinguishably from feature requests. Each finding is actionable: file path + line + suggested fix.

---

## Goals

- **Daily cadence by default.** Cron set in the consumer's wrapper workflow; user can loosen if cost matters more than freshness.
- **Read-only.** The agent must not mutate the repo. Tools restricted to `Bash Read Glob Grep TodoWrite`.
- **Real bugs only.** Three categories ranked by severity (security > broken_logic > code_smell). Not findings: style, naming, missing comments, lint-catchable items.
- **Structured findings.** JSON schema with `severity`, `category`, `file`, `line`, `title`, `description`, `suggested_fix`. The workflow parses it and files one issue per finding.
- **Distinguishable surfacing.** Findings appear under their own `bug_scout_finding` source on `/proposals`, sorted by severity, with severity / category labels visible.
- **Idempotent.** Re-running the scan doesn't create duplicate issues — the workflow checks for an existing open issue with the same title before creating a new one.
- **Snooze-friendly.** Like every other proposal source, findings can be snoozed 7d on the dashboard if the user has decided "not now."
- **Cost-bounded.** ~$0.30–$1.00 per scan; cap of 20 findings per scan to control noise.

## Non-Goals

- **Auto-fix.** The agent doesn't propose PR-level fixes; that's the implement workflow's job. A bug-scout finding becomes a `state:proposed` issue; if the user wants it fixed, they kick off the implement phase from there (manually or via the PM chat).
- **External dependency scanning.** `npm audit` / `pip-audit` etc. are deterministic tools the user can wire separately. Bug-scout focuses on what an LLM reading the code can find.
- **Continuous (per-commit) scanning.** Daily is the right cadence — per-commit would be expensive AND noisy. The carry-over nature of the queue means findings persist until acted on, and at daily cadence the freshest signal lands fast without flooding CI.

---

## Architecture

Three pieces:

### 1. Reusable workflow: `.github/workflows/phase-bug-scout.yml`

Engine-side, called by consumer wrappers. Inputs:
- `config_path` (default `.dev-agent.yml`) — directory containing this is the agent's working directory.
- `focus_paths` (CSV globs) — prioritize these. Empty means scan judgmentally.
- `ignore_paths` (CSV globs) — never scan these. Defaults skip `node_modules`, `dist`, `build`, `.next`, `coverage`.
- `invocation_mode: live | stub`.

Steps:
1. Checkout, set up Node, `npm ci`.
2. Convert `.dev-agent.yml` to JSON for jq.
3. Render the system prompt with `consumer_root`, `primary_language` (auto-detected from commands), test/typecheck/lint commands, focus + ignore paths.
4. Build the agent prompt (system + invocation context).
5. Invoke `anthropics/claude-code-action@v1` with claude-sonnet-4-6, max-turns 30, allowed tools `Bash Read Glob Grep TodoWrite`. Show full output for debugging.
6. Parse the agent's JSON output from `execution_file` (last `result` event, awk between ```json fences).
7. For each finding: build a structured issue body, check for an existing duplicate by title, file the new issue with labels `kind:bug-scout`, `state:proposed`, `severity:<level>`, `bug-category:<cat>`.

### 2. System prompt: `prompts/bug-scout.md`

Persona: senior engineer + security reviewer. Discipline-heavy:
- Read code; don't run automated tools and copy their output.
- Be specific (file + line + suggested fix mandatory).
- Be ruthless about false positives (<80% confidence → omit).
- Cap at 20 findings; emit highest-severity 20 if you'd exceed.
- Don't propose feature work — bugs only.

Emits a single fenced ```json document as the final message:

```json
{
  "findings": [
    {
      "severity": "high" | "medium" | "low",
      "category": "security" | "broken_logic" | "code_smell",
      "file": "<repo-relative path>",
      "line": <int or null>,
      "title": "<concrete one-liner, max 80 chars>",
      "description": "<2-4 sentences>",
      "suggested_fix": "<1-2 sentences>"
    }
  ],
  "summary": "<1-3 line plain text>",
  "scanned_files_estimate": <int>
}
```

### 3. Dashboard surface: `dashboard/lib/scout/bug-findings.ts`

Lists open issues in each wired-up repo with labels `kind:bug-scout,state:proposed`. Maps each to a `Proposal` with `source: 'bug_scout_finding'`, `group: 'carry_over'`. Sort: severity tier first (high → medium → low), oldest within tier (you've ignored these the longest).

Rendered on `/proposals` under the carry-over section with the existing Discuss-with-PM and Snooze-7d affordances. The `severity:*` label is parsed and surfaced.

### 4. Consumer wrapper: `examples/web-app-template/.github/workflows/dev-agent-bug-scout.yml`

Drops in via wire-up. Schedules the cron at `0 9 * * *` (daily 09:00 UTC) and exposes `workflow_dispatch` for ad-hoc scans with optional focus / ignore paths. Delegates to the reusable `phase-bug-scout.yml` pinned at `@v1`.

---

## Cost model

| Component | Cost |
|---|---|
| One scan (claude-sonnet-4-6, ~30 turns reading code) | $0.30–$1.00 |
| Default cadence (daily, ~30/month) | $9–$30 / month / repo |
| Manual dispatch | One scan worth of tokens per click |

The cost is on the consumer repo's Anthropic key (auto-pushed during wire-up by Phase 3.0.5). At ~$10–$30/month per repo this is the most expensive scout source by an order of magnitude — the user can loosen the cron to `0 9 * * 1-5` (weekdays only, ~$7–$20) or `0 9 * * 1` (weekly, ~$1–$4) by editing the wrapper.

---

## Acceptance criteria

- [x] Daily cron scans the consumer's repo and files findings as `kind:bug-scout` + `state:proposed` issues.
- [x] Manual dispatch via the wrapper's `workflow_dispatch` works with optional focus / ignore overrides.
- [x] The agent has read-only tool access (cannot mutate the repo even if the prompt told it to).
- [x] Re-running the scan doesn't create duplicate open issues for the same title.
- [x] Findings appear on `/proposals` under the `bug_scout_finding` source, sorted by severity then age.
- [x] Findings carry severity / category as labels for filtering / future automation.
- [x] Wire-up template ships with the bug-scout cron pre-installed (drift test enforces).
- [x] 7 dashboard tests cover the surface; engine has prompt drift coverage; both typechecks + Next build clean.

## Out of scope (future enhancements)

- Compare findings across scans to flag *new* bugs vs ones the user has been ignoring (would need persistent storage).
- Surface the agent's `summary` + `scanned_files_estimate` somewhere in the UI (currently lives only in workflow logs).
- Per-finding "False positive" feedback loop that updates the prompt / pm.md to avoid re-flagging.
- Integration with `npm audit` / similar deterministic scanners (orthogonal — would land as separate scout sources).
