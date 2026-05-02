# dev-agent Phase 1b — Plugin Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan is sub-plan 1b of 4.** Per the spec at `docs/specs/2026-05-02-dev-agent-design.md`, Phase 1 is split into four sub-plans. Plan 1a (Foundation) is shipped at tag `v0.1.0-alpha.1`. This plan (1b) adds the **Claude Code plugin surface** — the manifest, slash commands, internal skills, and prompt templates that make `claude plugin install /path/to/dev-agent` succeed and the user-facing slash commands runnable. Plans 1c (reusable GH workflows + synthetic test consumer) and 1d (end-to-end validation + `v0.1.0` final tag) follow.

**Goal:** End state — `claude plugin install /Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent` succeeds; the 8 slash commands are listed by `/help` (or equivalent surface) and runnable in any Claude Code session; the 4 internal skills are loadable; the 7 prompt templates exist and pass structural validation; tag `v0.1.0-alpha.2` cut. Workflows that some commands trigger (`phase-implement`, `phase-rollback`, etc.) remain stubbed — they ship in Plan 1c.

**Architecture:** A single Claude Code plugin distributed alongside the reusable GitHub workflows in this repo. The plugin manifest at `.claude-plugin/plugin.json` declares paths to commands and skills (root-relative). Slash commands in `commands/*.md` are user-invokable thin entry points; internal skills in `skills/<name>/SKILL.md` carry the heavy logic (orchestrator state machine, scout adapters, drift-check, notify fan-out wrapping `lib/notify.ts`). Prompt templates in `prompts/*.md` are passed as system/user prompts to the API by the workflows in Plan 1c. Existing `lib/` code (parse-config, telemetry, notify) is reused by the skills.

**Tech Stack:** Markdown + YAML frontmatter for commands/skills/prompts; existing TypeScript stack (zod, js-yaml, vitest) for validation tests; Bash inside slash commands for read-side actions (`gh`, `git`).

**Spec deviation note:** The spec says the plugin manifest lives at `.claude/plugin.json`. Per current Claude Code docs (https://code.claude.com/docs/en/plugins-reference.md), the canonical path is `.claude-plugin/plugin.json`. This plan uses the correct path. The spec will be amended in a follow-up doc-only commit (out of scope for 1b execution; tracked as a footnote here so reviewers don't flag it as drift).

---

## Plan series overview (recap, with status)

| Sub-plan | Goal | Status |
|---|---|---|
| 1a | Foundation: schema/, lib/, sample config, repo CI | ✅ shipped (`v0.1.0-alpha.1`) |
| **1b (this plan)** | Plugin surface: manifest, 8 commands, 4 skills, 7 prompts | in progress |
| 1c | Reusable GH workflows + synthetic test consumer | pending |
| 1d | End-to-end validation + `v0.1.0` release | pending |

---

## File structure (Plan 1b)

**Create:**

| File | Responsibility |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest: name, version, description, paths to commands/skills |
| `commands/dev-agent-init.md` | One-time consumer-repo bootstrap (config + workflow wrappers + labels) |
| `commands/develop.md` | Create issue → spec brainstorm → relabel `state:spec-ready` |
| `commands/proposals.md` | List open `kind:scout-proposal` issues |
| `commands/status.md` | Tabular view of in-flight features |
| `commands/approve.md` | Advance state at one of the 3 gates (with optional `--promote`) |
| `commands/abandon.md` | Close PR + archive spec + relabel `state:abandoned` |
| `commands/rollback.md` | Trigger `phase-rollback.yml` (workflow stubbed in 1c) |
| `commands/digest.md` | Trigger scout to run now (scout stubbed in 1b, real in 1c+) |
| `skills/orchestrator/SKILL.md` | State-machine reference + transition rules |
| `skills/scout/SKILL.md` | Scout source adapters + digest format (stub for 1b) |
| `skills/drift-check/SKILL.md` | Diff-vs-spec scope check guidance |
| `skills/notify/SKILL.md` | 4-channel fan-out wrapping `lib/notify.ts` |
| `prompts/implement.md` | System prompt for `phase-implement` |
| `prompts/staging-deploy.md` | System prompt for `phase-staging-deploy` |
| `prompts/promote-to-prod.md` | System prompt for `phase-promote-to-prod` |
| `prompts/smoke-verify.md` | System prompt for `phase-smoke-verify` |
| `prompts/rollback.md` | System prompt for `phase-rollback` |
| `prompts/scout-digest.md` | System prompt for daily scout digest generation |
| `prompts/drift-check.md` | System prompt for diff-vs-spec drift detection |
| `lib/plugin-files.ts` | Helper: enumerate expected plugin files (used by tests) |
| `tests/unit/plugin-manifest.test.ts` | Validates `.claude-plugin/plugin.json` shape |
| `tests/unit/commands.test.ts` | Validates 8 commands exist with required frontmatter |
| `tests/unit/skills.test.ts` | Validates 4 skill SKILL.md files exist with required frontmatter |
| `tests/unit/prompts.test.ts` | Validates 7 prompt templates exist with required template variables |

**Modify:**

| File | Change |
|---|---|
| `package.json` | Bump version to `0.1.0-alpha.2` |
| `README.md` | Replace install placeholder with real `claude plugin install` instructions and command index |

---

## Conventions used across all command/skill/prompt files

**Slash command frontmatter (commands/*.md):**

```yaml
---
description: <one-line summary shown in /help>
argument-hint: <example args, optional>
allowed-tools: <space-separated tool names; preauthorized>
---
```

**Internal skill frontmatter (skills/*/SKILL.md):**

```yaml
---
name: <skill-name-kebab>
description: <when-to-use sentence; helps Claude pick the right skill>
user-invocable: false   # internal skills not invoked directly by user
---
```

**Prompt template (prompts/*.md):**

Plain markdown with `{{variable}}` placeholders for runtime substitution by the workflow. Each prompt's first H1 is the role label (e.g., `# Implementation Agent`) and includes a fenced "Inputs" block listing required variables.

---

## Task 1: Plugin manifest at `.claude-plugin/plugin.json`

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `lib/plugin-files.ts`
- Create: `tests/unit/plugin-manifest.test.ts`

- [ ] **Step 1: Create the manifest**

`/Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/.claude-plugin/plugin.json`:

```json
{
  "name": "dev-agent",
  "version": "0.1.0-alpha.2",
  "description": "Portable agentic feature-development orchestrator: drop intent → spec → PR → staging → prod, with bounded human gates.",
  "author": {
    "name": "Ali Zaouane",
    "url": "https://github.com/alizaouane"
  },
  "repository": "https://github.com/alizaouane/dev-agent",
  "homepage": "https://github.com/alizaouane/dev-agent#readme",
  "license": "UNLICENSED",
  "keywords": ["agentic", "ci-cd", "github-actions", "automation", "devops", "claude-code"],
  "commands": "./commands/",
  "skills": "./skills/"
}
```

Notes:
- `version` is hard-pinned to keep manifest in lock-step with `package.json` and the git tag. Consumer repos pin to `@v0` major-line via the GH workflow `uses:` syntax.
- `commands` and `skills` are root-relative. Only `plugin.json` lives under `.claude-plugin/` — everything else is at repo root per the spec's directory layout.
- No `agents` or `hooks` fields — not needed in 1b. Add later if a need surfaces.

- [ ] **Step 2: Create `lib/plugin-files.ts` (single source of truth for expected files)**

`/Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/lib/plugin-files.ts`:

```ts
export const EXPECTED_COMMANDS = [
  'dev-agent-init',
  'develop',
  'proposals',
  'status',
  'approve',
  'abandon',
  'rollback',
  'digest',
] as const;

export const EXPECTED_SKILLS = [
  'orchestrator',
  'scout',
  'drift-check',
  'notify',
] as const;

export const EXPECTED_PROMPTS = [
  'implement',
  'staging-deploy',
  'promote-to-prod',
  'smoke-verify',
  'rollback',
  'scout-digest',
  'drift-check',
] as const;

export type ExpectedCommand = (typeof EXPECTED_COMMANDS)[number];
export type ExpectedSkill = (typeof EXPECTED_SKILLS)[number];
export type ExpectedPrompt = (typeof EXPECTED_PROMPTS)[number];
```

- [ ] **Step 3: Write the manifest test**

`/Users/alizaouane/Documents/Qualiency/Software\ Dev/dev-agent/tests/unit/plugin-manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifestPath = resolve(__dirname, '../../.claude-plugin/plugin.json');

describe('.claude-plugin/plugin.json', () => {
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as Record<string, unknown>;

  it('parses as JSON', () => {
    expect(manifest).toBeDefined();
    expect(typeof manifest).toBe('object');
  });

  it('has name "dev-agent"', () => {
    expect(manifest.name).toBe('dev-agent');
  });

  it('has a semver-shaped version', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it('declares commands and skills paths', () => {
    expect(manifest.commands).toBe('./commands/');
    expect(manifest.skills).toBe('./skills/');
  });

  it('has a non-empty description', () => {
    expect(typeof manifest.description).toBe('string');
    expect((manifest.description as string).length).toBeGreaterThan(20);
  });

  it('manifest version matches package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/unit/plugin-manifest.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json lib/plugin-files.ts tests/unit/plugin-manifest.test.ts
git commit -m "feat: .claude-plugin/plugin.json + plugin-files registry"
```

---

## Task 2: Slash command — `dev-agent-init`

**Files:**
- Create: `commands/dev-agent-init.md`

- [ ] **Step 1: Author the command**

`commands/dev-agent-init.md`:

```markdown
---
description: One-time bootstrap of dev-agent in a fresh consumer repo (creates .dev-agent.yml, 6 GH workflow wrappers, and canonical state labels)
argument-hint: "(no args)"
allowed-tools: Read Write Bash Glob Grep
---

# /dev-agent-init

Bootstraps the current repo as a dev-agent consumer.

## What this does

1. **Detects stack** by reading `package.json`, `supabase/config.toml`, `next.config.*`, `tsconfig.json`, etc., to infer reasonable defaults for `commands.test`, `commands.build`, `commands.typecheck`, and the staging-vs-no-staging branch model.
2. **Generates `.dev-agent.yml`** at the repo root, merging the inferred values over `schema/defaults.yml` (loaded from the installed plugin). Preserves any existing `.dev-agent.yml` — never overwrites.
3. **Drops 6 thin GitHub workflow wrappers** under `.github/workflows/dev-agent-*.yml`. Each is a 3–5 line `uses: alizaouane/dev-agent/.github/workflows/phase-<X>.yml@v1` reference with the issue number / config path passed through.
4. **Creates the canonical label vocabulary** via `gh label create` — 12 state labels, 4 kind labels, 4 priority labels (per `schema/label-vocabulary.yml`).
5. **Opens a PR titled "chore: dev-agent onboarding"** for human review of the generated config + wrappers before merge.

## Steps

1. Confirm we are at a git repo root: `git rev-parse --show-toplevel`. Bail if not, or if not on a clean working tree.
2. Refuse if `.dev-agent.yml` already exists, unless invoked with `--force` (suggest the user run `/develop` instead).
3. Read stack hints; build a starter config in memory.
4. Write `.dev-agent.yml` and the 6 wrappers.
5. Run `gh label create` for each canonical label (idempotent: skip on `already exists`).
6. Open the onboarding PR via `gh pr create`.

## What this does NOT do

- Does not install the plugin (the user does that with `claude plugin install`).
- Does not bypass the human review gate — the generated PR is the gate.
- Does not modify any source code or existing workflows.

## Failure modes

- Working tree dirty → abort with a message; tell the user to commit/stash first.
- `gh` CLI missing or not authenticated → abort with the install/auth command.
- Existing `.dev-agent.yml` without `--force` → abort, suggest `/develop` for the next feature.

## Implementation note

This command implementation is an MD-only entry point in Plan 1b. The actual stack-detection + config-templating logic is invoked via a follow-up TypeScript helper (planned in 1c) and the per-stack templates ship there. Until 1c lands, running this command emits a "stub: not yet wired" message and exits with code 0.
```

- [ ] **Step 2: Commit**

```bash
git add commands/dev-agent-init.md
git commit -m "feat: /dev-agent-init slash command (entry point; logic in 1c)"
```

---

## Task 3: Slash command — `develop`

**Files:**
- Create: `commands/develop.md`

- [ ] **Step 1: Author the command**

`commands/develop.md`:

```markdown
---
description: Start a new feature — creates GH issue, runs spec brainstorm with Opus, writes spec file, relabels state:spec-ready
argument-hint: "<intent> | <issue-url> | (empty to pick from /proposals)"
allowed-tools: Read Write Bash Glob Grep
---

# /develop

Kicks off a new feature in the dev-agent state machine.

## Argument forms

- `/develop "<intent>"` — free-form intent. Creates a fresh GH issue.
- `/develop <issue-url>` — re-uses an existing issue (must currently carry `state:proposed` or `state:scoping`).
- `/develop` — opens an interactive picker over open `kind:scout-proposal` issues (delegates to `/proposals`).

## What this does

1. **Creates or adopts the issue** with the right kind/state labels.
2. **Loads `.dev-agent.yml`** to determine `artifacts.specs_dir`, `cost_caps.spec_brainstorm`, and `models.spec_brainstorm` (default: `claude-opus-4-7`).
3. **Runs the spec brainstorm phase** — invokes the `superpowers:brainstorming` skill against the intent, then `superpowers:writing-specs` to produce the spec file at `<specs_dir>/<YYYY-MM-DD>-<slug>.md`.
4. **Posts a telemetry comment** on the issue (model, duration, tokens, cost; format defined by `lib/telemetry.ts`).
5. **Transitions the issue** to `state:spec-ready` and links to the spec file from the issue body.

This is **Gate 1**. The user reviews the spec, then runs `/approve <issue#>` to advance to `state:implementing`.

## Steps

1. Parse argument; resolve to an issue number (creating one if needed).
2. Load `.dev-agent.yml`; resolve spec_dir, model, cost cap.
3. Invoke `superpowers:brainstorming` against the intent (passes through user reviewer chat).
4. Once aligned, invoke `superpowers:writing-specs` to write the spec.
5. Comment telemetry; relabel; close-loop.

## Cost cap behavior

If the brainstorm phase hits `cost_caps.spec_brainstorm` (tokens or dollars), abort with `state:blocked` and a comment summarizing what's been captured so far. User can resume with `/develop <issue-url>`.

## Failure modes

- No `.dev-agent.yml` → tell user to run `/dev-agent-init`.
- `gh` not authenticated → bail with the auth command.
- Brainstorm cost cap hit → label `state:blocked`, post comment, exit non-zero.

## Implementation note

The brainstorm + writing-specs invocations are stubbed in 1b — the command writes a placeholder spec and applies `state:spec-ready` without actually invoking the model. The real model invocation wires up in 1c when the workflow side is built. The slash command structure, argument parsing, label transitions, and `gh` interactions are all live in 1b.
```

- [ ] **Step 2: Commit**

```bash
git add commands/develop.md
git commit -m "feat: /develop slash command (Gate 1 entry point)"
```

---

## Task 4: Slash command — `proposals`

**Files:**
- Create: `commands/proposals.md`

- [ ] **Step 1: Author the command**

`commands/proposals.md`:

```markdown
---
description: List open scout-proposed features; lets you triage (accept → develop, reject → suppress)
argument-hint: "(no args)"
allowed-tools: Read Bash Grep
---

# /proposals

Shows all open `kind:scout-proposal` issues in the current repo so you can triage them.

## Output format

A table:

```
#  TITLE                                             AGE   PRIORITY   SOURCE
142  add Stripe webhook idempotency check            2d    p2         supabase_logs
137  drop unused stripe_test_mode column             5d    p3         codebase_audit
```

## Triage actions

- **Accept** → run `/develop <issue-url>` to start scoping.
- **Reject** → close the issue with comment `reject: <reason>`. The scout's suppression logic (`scout.suppression.track_rejections`) records this and suppresses similar future proposals after `suppress_after_n_rejects` hits.
- **Defer** → leave open; will appear in the next digest.

## Steps

1. `gh issue list --label kind:scout-proposal --state open --limit 50 --json number,title,createdAt,labels` to fetch.
2. Render the table; pull `priority:*` and source label off `labels`.
3. (Future) Allow inline triage via numbered selection — out of scope for 1b.

## Failure modes

- No open proposals → emit "No open proposals. Try `/digest` to run scout now." and exit.

## Implementation note

In 1b, this command is fully functional for the read side (`gh` enumeration). The scout that *populates* these proposals ships in 1c (or later). Until then, the list will typically be empty.
```

- [ ] **Step 2: Commit**

```bash
git add commands/proposals.md
git commit -m "feat: /proposals slash command (triage scout proposals)"
```

---

## Task 5: Slash command — `status`

**Files:**
- Create: `commands/status.md`

- [ ] **Step 1: Author the command**

`commands/status.md`:

```markdown
---
description: Tabular view of in-flight dev-agent features (state, age, cost, blockers)
argument-hint: "[--all] [--state=<label>]"
allowed-tools: Read Bash Grep
---

# /status

Shows the current dev-agent feature pipeline in this repo.

## Default output

By default, shows non-terminal states (everything except `state:done`, `state:abandoned`, `state:rolled-back`). Pass `--all` to include those, or `--state=<label>` to filter.

```
#    TITLE                                        STATE                    AGE    COST    BLOCKERS
142  add Stripe webhook idempotency check         state:pr-review          1d     $2.31   —
139  fix booking calendar timezone bug            state:staging-deployed    3h     $1.07   —
137  drop unused stripe_test_mode column          state:blocked            6h     $0.84   drift: 3 files outside spec
```

## Steps

1. `gh issue list --label state:* --json number,title,labels,createdAt,comments`. Filter to non-terminal states.
2. For each issue: extract latest telemetry comment (look for `🤖 Phase:` marker), pull cost.
3. Render the table.
4. If `artifacts.status_file` is configured and exists, also emit "Status file: <path>" footer.

## Failure modes

- No `.dev-agent.yml` → bail with a hint to run `/dev-agent-init`.
- No matching issues → emit "No active features." and exit.

## Implementation note

Fully functional in 1b — relies only on `gh` + lib/parse-config.
```

- [ ] **Step 2: Commit**

```bash
git add commands/status.md
git commit -m "feat: /status slash command (in-flight pipeline view)"
```

---

## Task 6: Slash command — `approve`

**Files:**
- Create: `commands/approve.md`

- [ ] **Step 1: Author the command**

`commands/approve.md`:

```markdown
---
description: Advance an issue past one of the 3 dev-agent gates (spec-ready → implementing → ready-to-promote → promoting)
argument-hint: "<issue#> [--promote]"
allowed-tools: Read Bash Grep
---

# /approve

Advances a feature issue to the next state. This is the human-in-the-loop confirmation at one of the three gates.

## Gate transitions

| Current state | Action | Result |
|---|---|---|
| `state:spec-ready` | `/approve <issue#>` | → `state:implementing` (triggers `phase-implement.yml`) |
| `state:pr-review` | `/approve <issue#>` (after PR is merged manually) | → `state:staging-deployed` (triggers `phase-staging-deploy.yml`) |
| `state:ready-to-promote` | `/approve <issue#> --promote` | → `state:promoting` (triggers `phase-promote-to-prod.yml`) |

## Steps

1. Parse `<issue#>` and optional `--promote` flag.
2. Read current state label from the issue.
3. Validate the transition is legal (per the table). Bail with a clear error if not.
4. Apply label change via `gh issue edit`. The label-change webhook triggers the corresponding phase workflow.
5. Comment on the issue: "🛂 Approved at <gate-name> by <gh-user> at <ISO-timestamp>."

## Safety

- Rejects `--promote` without `<issue#>` to prevent accidental promotion.
- Rejects approval when state is one of `state:blocked`, `state:abandoned`, `state:rolled-back`, `state:done` — emits "issue not in a gateable state."
- Idempotent: re-running on an already-advanced issue is a no-op with a comment.

## Failure modes

- Bad transition → abort, no labels touched.
- `gh` auth missing → bail.

## Implementation note

Fully wired in 1b — labels are applied. The downstream workflows (`phase-implement.yml`, etc.) are stubbed in 1c, so the label flip will fire workflows that are stub-no-ops until 1c.
```

- [ ] **Step 2: Commit**

```bash
git add commands/approve.md
git commit -m "feat: /approve slash command (gate-advance with --promote)"
```

---

## Task 7: Slash command — `abandon`

**Files:**
- Create: `commands/abandon.md`

- [ ] **Step 1: Author the command**

`commands/abandon.md`:

```markdown
---
description: Abandon an in-flight feature (closes PR if any, archives spec, relabels state:abandoned)
argument-hint: "<issue#> [--reason=<text>]"
allowed-tools: Read Write Bash
---

# /abandon

Cleanly cancels an in-flight feature. Use when an intent is no longer valid (requirement changed, duplicate, etc.).

## Steps

1. Parse `<issue#>` and optional `--reason`.
2. If a linked PR exists (look for `Linked: #<pr>` in issue body or branch named `feature/<slug>` with an open PR), close it with comment "abandoned by /abandon (issue #<issue#>)".
3. If a linked spec file exists at `<artifacts.specs_dir>/<file>.md`, move it to `<artifacts.specs_dir>/abandoned/<file>.md` (creating the directory if needed). Preserves audit trail.
4. Apply `state:abandoned` label, remove all other `state:*` labels.
5. Post a closure comment on the issue: "Abandoned by <gh-user> at <ISO-timestamp>. Reason: <reason or 'unspecified'>."
6. Close the issue.

## Safety

- Always asks for confirmation if the issue currently has `state:promoting` or `state:staging-deployed` (real changes are live; user may want `/rollback` instead).
- Refuses if `state:done` (already shipped).

## Failure modes

- Missing `gh` → bail.
- Missing spec dir → still closes issue, comments "no spec file to archive" warning.

## Implementation note

Fully functional in 1b — read-only-to-shared-state operations.
```

- [ ] **Step 2: Commit**

```bash
git add commands/abandon.md
git commit -m "feat: /abandon slash command (clean cancellation)"
```

---

## Task 8: Slash command — `rollback`

**Files:**
- Create: `commands/rollback.md`

- [ ] **Step 1: Author the command**

`commands/rollback.md`:

```markdown
---
description: Trigger phase-rollback workflow against a shipped feature (reverts merge, redeploys, runs paired _rollback.sql)
argument-hint: "<issue#>"
allowed-tools: Read Bash
---

# /rollback

Reverts a shipped feature. Hooks into the consumer's `phase-rollback.yml` workflow.

## What the workflow does (handled in Plan 1c)

1. Find merge commit via PR linked from the issue.
2. `git revert -m 1 <merge-sha>` → push to staging branch (or default if no staging).
3. Open a release PR for the revert.
4. After merge: redeploy artifacts via consumer's deploy skills.
5. Run paired `_rollback.sql` migrations if any.
6. Run prod smoke.
7. Relabel `state:rolled-back`, comment timeline.

## Steps (in this slash command)

1. Validate `<issue#>` exists and is in `state:done` or `state:promoting` or `state:staging-deployed`. Reject otherwise.
2. Confirm via prompt: "Rollback issue #<n> ('<title>')? This will revert the merge commit and redeploy. [y/N]"
3. On confirmation, dispatch the workflow: `gh workflow run phase-rollback.yml -f issue_number=<n>`.
4. Comment on issue: "🔁 Rollback initiated by <gh-user> at <ISO-timestamp>."
5. Watch the run via `gh run watch` until terminal status; report.

## Failure modes

- Issue not in a rollback-eligible state → reject with the eligible list.
- No `phase-rollback.yml` workflow registered in this repo (consumer hasn't onboarded properly) → tell the user to run `/dev-agent-init`.
- Workflow dispatch fails → surface the `gh` error.

## Implementation note

Slash command structure live in 1b. The dispatched workflow `phase-rollback.yml` is stubbed in 1c. Triggering it before 1c will fail with a clear "workflow not found" message — that's acceptable because consumers cannot meaningfully use rollback before workflows ship.
```

- [ ] **Step 2: Commit**

```bash
git add commands/rollback.md
git commit -m "feat: /rollback slash command (dispatch + watch)"
```

---

## Task 9: Slash command — `digest`

**Files:**
- Create: `commands/digest.md`

- [ ] **Step 1: Author the command**

`commands/digest.md`:

```markdown
---
description: Trigger scout to run now (out-of-cycle digest generation)
argument-hint: "(no args)"
allowed-tools: Read Bash
---

# /digest

Forces the scout to run immediately rather than waiting for its scheduled cron. Useful for testing or after a config change.

## Steps

1. Read `.dev-agent.yml`; check `scout.enabled` is `true`. Bail with a message otherwise.
2. Dispatch the scout workflow: `gh workflow run dev-agent-scout.yml` (the wrapper that calls the plugin's scout job).
3. Watch the run; report the digest issue URL when posted.

## Output

On success: prints the URL of the new digest issue (`kind:scout-digest`).

## Failure modes

- `scout.enabled: false` → bail.
- No scout workflow wired in consumer → tell user to run `/dev-agent-init`.

## Implementation note

Slash command live in 1b. The scout itself (source adapters, digest generation, suppression learning) is stubbed in `skills/scout/SKILL.md` and runs as a real workflow in Plan 1c.
```

- [ ] **Step 2: Commit**

```bash
git add commands/digest.md
git commit -m "feat: /digest slash command (out-of-cycle scout trigger)"
```

---

## Task 10: Tests for all 8 commands

**Files:**
- Create: `tests/unit/commands.test.ts`

- [ ] **Step 1: Write the test**

`tests/unit/commands.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { EXPECTED_COMMANDS } from '../../lib/plugin-files';

const commandsDir = resolve(__dirname, '../../commands');

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter found');
  return { frontmatter: yaml.load(match[1]) as Record<string, unknown>, body: match[2] };
}

describe('commands/', () => {
  for (const name of EXPECTED_COMMANDS) {
    describe(`/${name}`, () => {
      const path = resolve(commandsDir, `${name}.md`);

      it('file exists', () => {
        expect(existsSync(path)).toBe(true);
      });

      it('has parseable YAML frontmatter', () => {
        const raw = readFileSync(path, 'utf8');
        expect(() => splitFrontmatter(raw)).not.toThrow();
      });

      it('has a non-empty description in frontmatter', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(typeof frontmatter.description).toBe('string');
        expect((frontmatter.description as string).length).toBeGreaterThan(10);
      });

      it('has an allowed-tools field listing at least one tool', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(typeof frontmatter['allowed-tools']).toBe('string');
        expect((frontmatter['allowed-tools'] as string).trim().length).toBeGreaterThan(0);
      });

      it('body starts with an H1 matching the command name', () => {
        const raw = readFileSync(path, 'utf8');
        const { body } = splitFrontmatter(raw);
        const firstHeading = body.split('\n').find((l) => l.startsWith('# '));
        expect(firstHeading).toBeDefined();
        expect((firstHeading as string).toLowerCase()).toContain(name);
      });
    });
  }

  it('contains exactly the expected 8 commands (no extras)', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const files = fs
      .readdirSync(commandsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(files).toEqual([...EXPECTED_COMMANDS].sort());
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/unit/commands.test.ts`
Expected: 41 passing (5 per command × 8 + 1 set check).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/commands.test.ts
git commit -m "test: validate 8 slash commands have correct frontmatter + structure"
```

---

## Task 11: Internal skill — `orchestrator`

**Files:**
- Create: `skills/orchestrator/SKILL.md`

- [ ] **Step 1: Author the skill**

`skills/orchestrator/SKILL.md`:

```markdown
---
name: orchestrator
description: Use to advance a dev-agent feature issue through its state machine — knows the canonical state transitions, gate semantics, and which workflow runs at each transition.
user-invocable: false
---

# orchestrator

Internal skill that encodes the dev-agent state machine. Slash commands and reusable workflows call into this skill to know "what is the legal next state?" and "what side effects fire on transition?"

## State machine (canonical)

```
state:proposed (kind:scout-proposal only)
  → user accept via /proposals
  → state:scoping
state:scoping
  → /develop runs spec brainstorm
  → state:spec-ready    ◄── GATE 1
state:spec-ready
  → /approve <n>
  → state:implementing  → fires phase-implement.yml
state:implementing
  → workflow opens PR
  → state:pr-review     ◄── GATE 2
state:pr-review
  → user merges PR + /approve <n>
  → state:staging-deployed → fires phase-staging-deploy.yml
state:staging-deployed
  → smoke passes (auto)
  → state:ready-to-promote ◄── GATE 3
state:ready-to-promote
  → /approve <n> --promote
  → state:promoting → fires phase-promote-to-prod.yml
state:promoting
  → prod smoke passes
  → state:done (issue closed)
```

Failure / off-ramp states (reachable from any `*ing` state):

- `state:blocked` — set by phase workflow on cap hit, drift violation, ambiguous failure.
- `state:abandoned` — set by `/abandon`.
- `state:rolled-back` — set by `phase-rollback.yml` on completion.

## Hotfix path

If `.dev-agent.yml.hotfix.enabled = true` and issue carries `kind:hotfix`:
- `/develop` skips spec gate (when `hotfix.skip_spec: true`), goes straight to `state:implementing`.
- Drift check still applies unless `hotfix.skip_drift_check: true`.

## Transition table (consumed programmatically)

| From | Trigger | To | Side effect |
|---|---|---|---|
| `state:proposed` | `/proposals` accept | `state:scoping` | comment on issue |
| `state:scoping` | `/develop` (auto) | `state:spec-ready` | spec written; telemetry comment |
| `state:spec-ready` | `/approve` | `state:implementing` | dispatch `phase-implement.yml` |
| `state:implementing` | workflow PR open (auto) | `state:pr-review` | PR opened; comment with PR link |
| `state:pr-review` | `/approve` (PR must be merged) | `state:staging-deployed` | dispatch `phase-staging-deploy.yml` |
| `state:staging-deployed` | smoke pass (auto) | `state:ready-to-promote` | telemetry comment |
| `state:ready-to-promote` | `/approve --promote` | `state:promoting` | dispatch `phase-promote-to-prod.yml` |
| `state:promoting` | prod smoke pass (auto) | `state:done` | issue closed; final telemetry |

## Files this skill cooperates with

- `lib/parse-config.ts` — reads `.dev-agent.yml`
- `lib/telemetry.ts` — formats per-phase comments
- `skills/notify/SKILL.md` — fan-out at every transition
- `skills/drift-check/SKILL.md` — pre-PR drift gate

## How callers use this skill

Slash commands and workflows do not directly include this file's content — they rely on the *registry* it documents. The actual transition enforcement is implemented in TypeScript (planned for Plan 1c — `lib/orchestrator.ts`) using the table above as a single source of truth. Until then, this SKILL.md serves as the canonical reference for human implementers and reviewers.
```

- [ ] **Step 2: Commit**

```bash
git add skills/orchestrator/SKILL.md
git commit -m "feat: skills/orchestrator — state machine reference"
```

---

## Task 12: Internal skill — `scout`

**Files:**
- Create: `skills/scout/SKILL.md`

- [ ] **Step 1: Author the skill**

`skills/scout/SKILL.md`:

```markdown
---
name: scout
description: Use to discover candidate features by polling configured sources (GH issues, Vercel logs, Supabase logs, codebase audit, competitive feeds). Generates a daily digest issue with deduplication and rejection-suppression.
user-invocable: false
---

# scout

Internal skill that powers the daily proactive feature-discovery loop.

## Inputs (from `.dev-agent.yml.scout`)

```yaml
scout:
  enabled: true
  cron: "0 9 * * *"
  sources:
    - { kind: github_issues }
    - { kind: vercel_logs, project: "<vercel-project>" }
    - { kind: supabase_logs, project_ids: ["<id>", ...] }
    - { kind: codebase_audit, pitfalls_path: CLAUDE.md, max_age_days: 30 }
    - { kind: competitive, feeds: ["<rss-url>", ...] }
  suppression:
    track_rejections: true
    suppress_after_n_rejects: 3
```

## Behavior

1. **Per-source adapters** (each handled by a small TS module under `lib/scout/<kind>.ts` — implemented in Plan 1c):
   - `github_issues`: enumerate open issues with `triage` or `bug` labels not yet referenced from a spec.
   - `vercel_logs`: top errors from `vc logs --since=24h` filtered to non-trivial paths.
   - `supabase_logs`: project-specific error categories from the Supabase API.
   - `codebase_audit`: TODO/FIXME/HACK older than `max_age_days`, plus pitfalls_path entries that match recent diffs.
   - `competitive`: RSS items mentioning project keywords.

2. **Deduplication** — hash the title + first 200 chars of body; skip anything seen in the last 30 days.

3. **Suppression** — for each candidate, check if N similar (cosine ≥ 0.85 via Haiku embedding) candidates have been rejected via `/proposals`. If yes, suppress.

4. **Digest construction** — pick top 3–7 candidates by score (recency × severity × novelty). Render markdown table with `priority:p<N>` suggestions.

5. **Issue creation** — open one issue per surviving candidate with `kind:scout-proposal` + suggested priority + source label, plus a single `kind:scout-digest` summary issue linking them.

## Cost cap

Reads `cost_caps.scout_digest`. Default model: `claude-haiku-4-5`. Hits cap → emit partial digest, comment "truncated due to cost cap", exit 0.

## Implementation status

In Plan 1b, this SKILL.md exists as the contract. The TS adapters in `lib/scout/` and the workflow `dev-agent-scout.yml` ship in Plan 1c.
```

- [ ] **Step 2: Commit**

```bash
git add skills/scout/SKILL.md
git commit -m "feat: skills/scout — source adapters + digest contract"
```

---

## Task 13: Internal skill — `drift-check`

**Files:**
- Create: `skills/drift-check/SKILL.md`

- [ ] **Step 1: Author the skill**

`skills/drift-check/SKILL.md`:

```markdown
---
name: drift-check
description: Use after implementation to detect scope drift — compares the actual diff against the spec's declared scope and flags out-of-scope changes (excluding configured trivial-cleanup categories).
user-invocable: false
---

# drift-check

Diff-vs-spec scope detector. Runs after the implementation phase produces a branch but before the PR is opened.

## Inputs

- `<spec>` — path to spec file at `<artifacts.specs_dir>/<file>.md`
- `<base-ref>` — the branch this work is based on (typically `main`)
- `<head-ref>` — the implementation branch
- `<config>` — the parsed `.dev-agent.yml` (for `guardrails.scope_creep_thresholds` and `trivial_cleanup_categories`)

## Behavior

1. Compute `git diff --name-only <base>...<head>` → set of changed files.
2. Parse the spec file; extract its "Critical files" or "Files modified" section. Compute the **declared scope** = set of file paths/globs the spec says will change.
3. Bucket each changed file into:
   - **In scope** — matches a glob in declared scope.
   - **Trivial cleanup** — single-line/whitespace-only changes, or matches a category in `guardrails.trivial_cleanup_categories` (formatting, import-sort, dead-code-removal, comment-fix). Allowed.
   - **Out of scope** — anything else.
4. Compute `loc_outside_spec_scope` = sum of `+` lines in out-of-scope files.
5. Apply thresholds from `guardrails.scope_creep_thresholds`:
   - `files_outside_spec_scope > 0` and not all trivial → fail.
   - `loc_outside_spec_scope > <threshold>` → fail.
6. On fail: emit a structured report (markdown), label the issue `state:blocked`, post the report as a comment.
7. On pass: emit "drift-check: clean" line for the telemetry comment.

## Output format (markdown report posted to issue)

```markdown
## drift-check: scope creep detected

Spec declared scope: 4 files
- src/auth/middleware.ts
- src/auth/session.ts
- tests/auth/middleware.test.ts
- docs/runbooks/auth.md

Out-of-scope changes:
- `src/payments/refund.ts` (+47 lines) — not declared
- `src/components/Header.tsx` (+12 lines) — not declared, not trivial

Trivial cleanup (allowed): 2 files (formatting, import-sort)

Action: state:blocked. Either narrow the diff or amend the spec and re-run.
```

## Cost

Uses `models.drift_detection` (default: `claude-haiku-4-5`) for the spec-parsing step. Pure-mechanical line counting is local TS, no model. Typical cost: <$0.05 per check.

## Implementation status

The TS implementation lives in Plan 1c (`lib/drift-check.ts` + invocation from `phase-implement.yml`). This SKILL.md is the contract.
```

- [ ] **Step 2: Commit**

```bash
git add skills/drift-check/SKILL.md
git commit -m "feat: skills/drift-check — scope-creep detector contract"
```

---

## Task 14: Internal skill — `notify`

**Files:**
- Create: `skills/notify/SKILL.md`

- [ ] **Step 1: Author the skill**

`skills/notify/SKILL.md`:

```markdown
---
name: notify
description: Use to fan out gate-transition notifications across push (ntfy/pushover/slack), email (resend), GitHub issue comment, and the project status file. Wraps lib/notify.ts.
user-invocable: false
---

# notify

Wraps `lib/notify.ts` so phase workflows have a one-call notification primitive.

## Inputs

```ts
type NotifyPayload = {
  issueNumber: number;
  gate: 'spec-ready' | 'pr-review' | 'ready-to-promote' | 'done' | 'blocked' | 'rolled-back';
  title: string;
  summary: string;       // 1–3 lines, plain markdown
  cost?: number;         // dollars; included in body if present
  artifacts?: { label: string; url: string }[];
};
```

## Channels (configured via `notifications:` in `.dev-agent.yml`)

| Channel | When | How |
|---|---|---|
| GitHub issue comment | always | `gh issue comment <n> --body` |
| Status file | always | append/upsert section in `<artifacts.status_file>` |
| Push | if `notifications.push` configured | HTTP POST to ntfy.sh / pushover / slack-webhook |
| Email | if `notifications.email` configured | Resend API; secret name from `notifications.email.secret_name` |

## Behavior

1. Always emits the issue comment + status-file update synchronously; failures here propagate (these are the "always-on" channels).
2. Push + email are best-effort; failures log a warning to stderr but don't fail the workflow.
3. All payloads honor `models.notification` (default `claude-haiku-4-5`) only when generating the summary text — when the caller already has summary text, no model call.

## Failure modes

- Missing `gh` CLI auth → fail loud (issue comment is the canonical channel).
- Resend API key secret missing while email is configured → log a warning, skip email, continue.

## Implementation status

`lib/notify.ts` is shipped in Plan 1a with full unit tests (3 test cases, HTTP mocks). This SKILL.md documents the contract that workflows in Plan 1c will consume.
```

- [ ] **Step 2: Commit**

```bash
git add skills/notify/SKILL.md
git commit -m "feat: skills/notify — 4-channel fan-out contract"
```

---

## Task 15: Tests for all 4 skills

**Files:**
- Create: `tests/unit/skills.test.ts`

- [ ] **Step 1: Write the test**

`tests/unit/skills.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { EXPECTED_SKILLS } from '../../lib/plugin-files';

const skillsDir = resolve(__dirname, '../../skills');

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter found');
  return { frontmatter: yaml.load(match[1]) as Record<string, unknown>, body: match[2] };
}

describe('skills/', () => {
  for (const name of EXPECTED_SKILLS) {
    describe(`/${name}`, () => {
      const path = resolve(skillsDir, name, 'SKILL.md');

      it('SKILL.md exists', () => {
        expect(existsSync(path)).toBe(true);
      });

      it('has frontmatter with name matching directory', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(frontmatter.name).toBe(name);
      });

      it('has a description that says when to use it', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(typeof frontmatter.description).toBe('string');
        expect((frontmatter.description as string).length).toBeGreaterThan(30);
      });

      it('has user-invocable: false (internal skill)', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(frontmatter['user-invocable']).toBe(false);
      });

      it('body has at least one H2 section', () => {
        const raw = readFileSync(path, 'utf8');
        const { body } = splitFrontmatter(raw);
        expect(body.split('\n').some((l) => l.startsWith('## '))).toBe(true);
      });
    });
  }

  it('contains exactly the expected 4 skills (no extras)', () => {
    const dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual([...EXPECTED_SKILLS].sort());
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/unit/skills.test.ts`
Expected: 21 passing (5 per skill × 4 + 1 set check).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/skills.test.ts
git commit -m "test: validate 4 internal skills have correct frontmatter + structure"
```

---

## Task 16: Prompt template — `implement.md`

**Files:**
- Create: `prompts/implement.md`

- [ ] **Step 1: Author the prompt**

`prompts/implement.md`:

```markdown
# Implementation Agent

You are the implementation agent for a dev-agent feature. You receive an approved spec, write code in a feature branch, run the test suite, and stop short of opening the PR (the workflow opens the PR after you finish).

## Inputs

- `{{spec_path}}` — path to the spec file (read it in full before writing any code)
- `{{branch_name}}` — feature branch already created and checked out
- `{{commands.test}}` — test command to run after each change
- `{{commands.typecheck}}` — typecheck command to run after each change
- `{{commands.lint}}` — lint command (optional, run if present)
- `{{guardrails.blocked_paths}}` — paths you must NOT modify
- `{{guardrails.require_explicit_unlock}}` — paths you may only modify if the spec explicitly mentions them
- `{{guardrails.max_files_changed}}` / `{{guardrails.max_lines_changed}}` — hard caps; abort if you'd exceed them

## Required output

Once you finish, emit a single JSON line on stdout:

```json
{
  "files_changed": <int>,
  "lines_added": <int>,
  "lines_removed": <int>,
  "tests_added": <int>,
  "tests_passing": <bool>,
  "typecheck_passing": <bool>,
  "lint_passing": <bool|null>,
  "summary": "<1-3 line plain-text summary>"
}
```

The workflow parses this line; anything else printed before it is captured as the implementation log.

## Discipline

- Read the entire spec before touching code.
- Touch only files the spec declares (matching `{{guardrails.blocked_paths}}` is a hard fail; matching `{{guardrails.require_explicit_unlock}}` requires the spec to explicitly mention the path).
- Run typecheck + tests after each meaningful change. Don't batch.
- Use TDD where the spec implies behavior changes.
- Never skip pre-commit hooks (`--no-verify`).
- Do not push or open a PR — the workflow handles that.

## Cost cap

This phase is bounded by `cost_caps.implement` from `.dev-agent.yml`. If you approach 80% of the cap, prefer breaking the work mid-flight (commit what's done, leave a TODO with context) over hard-aborting.

## Failure modes

- Cannot satisfy spec without modifying a `blocked_path` → abort, emit `tests_passing: false`, summary: "blocked: <path> required but locked".
- Test failures you cannot diagnose after 3 attempts → emit `tests_passing: false`, summary describing root-cause hypothesis. The workflow escalates to ambiguous-failure model.
- Cap hit → emit current state, partial summary, exit.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/implement.md
git commit -m "feat: prompts/implement — implementation-agent system prompt"
```

---

## Task 17: Prompt template — `staging-deploy.md`

**Files:**
- Create: `prompts/staging-deploy.md`

- [ ] **Step 1: Author the prompt**

`prompts/staging-deploy.md`:

```markdown
# Staging Deploy Agent

You execute the staging deploy after a PR has been merged. Chain the consumer's `deploy_skills.staging` skills in declared order, capture their output, and report.

## Inputs

- `{{deploy_skills.staging}}` — ordered list of skill names to invoke
- `{{branches.staging}}` — the staging branch (or null if no staging-first repo)
- `{{commands.test}}` — smoke tests to run after deploy
- `{{merge_sha}}` — the SHA that just merged into staging (or main, if no staging branch)

## Required output

```json
{
  "deploys_completed": <int>,
  "smoke_passing": <bool>,
  "deploy_artifacts": [{ "label": "<name>", "url": "<url>" }, ...],
  "summary": "<1-3 line summary>"
}
```

## Discipline

- Run skills in declared order; abort the chain on first failure.
- Capture each skill's stdout/stderr; surface them in the workflow log.
- After all skills succeed, run `{{commands.test}}` against the staging environment for smoke verification.
- If `branches.staging` is null (no staging-first repo), this phase is a no-op — emit empty deploys list, smoke_passing: true.

## Failure modes

- A deploy skill fails → abort chain, emit `deploys_completed: <i>` (count up to failure), `smoke_passing: false`, summary with skill name and exit code.
- Smoke fails → emit `deploys_completed: <total>`, `smoke_passing: false`, summary with failing test names.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/staging-deploy.md
git commit -m "feat: prompts/staging-deploy — staging-deploy agent system prompt"
```

---

## Task 18: Prompt template — `promote-to-prod.md`

**Files:**
- Create: `prompts/promote-to-prod.md`

- [ ] **Step 1: Author the prompt**

`prompts/promote-to-prod.md`:

```markdown
# Promote-to-Prod Agent

You execute the prod promotion after staging smoke is green and the user has issued `/approve --promote`. Chain the consumer's `deploy_skills.prod` skills, run prod smoke, report.

## Inputs

- `{{deploy_skills.prod}}` — ordered list of skill names
- `{{branches.release_target}}` — typically `main`
- `{{commands.test}}` — smoke tests against prod
- `{{merge_sha}}` — the SHA being promoted

## Required output

```json
{
  "promotes_completed": <int>,
  "prod_smoke_passing": <bool>,
  "prod_artifacts": [{ "label": "<name>", "url": "<url>" }, ...],
  "summary": "<1-3 line summary>"
}
```

## Discipline

- Run skills in declared order; abort on first failure (this is prod — fail-fast).
- After all skills succeed, run `{{commands.test}}` with `--target=prod` (or whatever the consumer's smoke is) for prod smoke.
- On success, emit transition to `state:done` and close the issue.
- On any failure, emit `state:blocked` and propose `/rollback`.

## Failure modes

- Deploy skill fails → emit `prod_smoke_passing: false`, summary names the failing skill. The issue is labeled `state:blocked`. **Do NOT auto-rollback** — that's a human decision via `/rollback`.
- Prod smoke fails → same as above.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/promote-to-prod.md
git commit -m "feat: prompts/promote-to-prod — prod-promote agent system prompt"
```

---

## Task 19: Prompt template — `smoke-verify.md`

**Files:**
- Create: `prompts/smoke-verify.md`

- [ ] **Step 1: Author the prompt**

`prompts/smoke-verify.md`:

```markdown
# Smoke Verify Agent

You analyze the output of a freshly-run smoke test suite. Decide whether to advance the issue to `state:ready-to-promote` (staging smoke) or `state:done` (prod smoke), or to `state:blocked`.

## Inputs

- `{{smoke_phase}}` — `"staging"` or `"prod"`
- `{{smoke_output}}` — captured stdout/stderr from the smoke run
- `{{smoke_exit_code}}` — process exit code
- `{{issue_number}}` — the dev-agent issue number

## Required output

```json
{
  "verdict": "pass" | "fail" | "ambiguous",
  "next_state": "<label name>",
  "blockers": [{ "test": "<name>", "reason": "<why>" }, ...],
  "summary": "<1-3 line summary>"
}
```

## Discipline

- `exit_code == 0` and no test failures in output → verdict: `pass`.
- `exit_code != 0` with clear test failure markers → verdict: `fail`, list each failed test in `blockers`.
- Ambiguous output (network errors, timeouts, mixed signals) → verdict: `ambiguous`. The workflow escalates to the `ambiguous_failure` model (Opus) for re-analysis.
- `next_state`: pass+staging → `state:ready-to-promote`; pass+prod → `state:done`; fail → `state:blocked`; ambiguous → leave at current state, escalate.

## Cost

Uses `models.smoke_analysis` (default `claude-haiku-4-5`). Cheap by design.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/smoke-verify.md
git commit -m "feat: prompts/smoke-verify — smoke-output classifier system prompt"
```

---

## Task 20: Prompt template — `rollback.md`

**Files:**
- Create: `prompts/rollback.md`

- [ ] **Step 1: Author the prompt**

`prompts/rollback.md`:

```markdown
# Rollback Agent

You execute a rollback against a shipped feature. Find the merge commit, revert it, redeploy prior artifacts, run paired `_rollback.sql` migrations if any, then run prod smoke.

## Inputs

- `{{issue_number}}` — the issue tied to the feature being reverted
- `{{merged_pr}}` — PR number whose merge commit you'll revert
- `{{branches.staging}}` / `{{branches.release_target}}` — branch names
- `{{deploy_skills.staging}}` / `{{deploy_skills.prod}}` — for redeploy of prior version
- `{{commands.test}}` — smoke tests

## Required output

```json
{
  "revert_pr_number": <int>,
  "redeploys_completed": <int>,
  "rollback_sql_run": <int>,
  "post_rollback_smoke_passing": <bool>,
  "summary": "<1-3 line summary>"
}
```

## Steps

1. Identify merge commit: `gh pr view {{merged_pr}} --json mergeCommit --jq .mergeCommit.oid`.
2. Create a revert commit: `git revert -m 1 <merge-sha>` on a branch named `revert/<original-branch>`.
3. Push the revert branch and open a PR titled "revert: <original PR title>" targeting `{{branches.staging}}` (or `release_target` if no staging).
4. After the revert PR is merged, redeploy via `deploy_skills.staging` (or `prod` if no staging-first).
5. Run paired `_rollback.sql` migrations if the original PR added any `*.sql` files under `supabase/migrations/` (or analogous path). Use `scaffold_skills.migration` config to find the rollback file.
6. Run `{{commands.test}}` for post-rollback smoke.
7. Emit the result JSON.

## Discipline

- **Never force-push.** Always go through a revert PR.
- **Never skip the smoke.** A rollback that itself breaks prod is worst-case.
- If `_rollback.sql` is missing for a migration that ran, escalate (set `state:blocked` with note "missing rollback SQL"). Do not attempt manual schema rollback.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/rollback.md
git commit -m "feat: prompts/rollback — rollback agent system prompt"
```

---

## Task 21: Prompt template — `scout-digest.md`

**Files:**
- Create: `prompts/scout-digest.md`

- [ ] **Step 1: Author the prompt**

`prompts/scout-digest.md`:

```markdown
# Scout Digest Agent

You produce the daily scout digest from raw candidates collected by the source adapters.

## Inputs

- `{{candidates}}` — list of `{ source, title, body, evidence_url, severity_hint, novelty_score }`
- `{{rejection_log}}` — recent rejections (titles + reasons) for suppression
- `{{config.scout.suppression}}` — `{ track_rejections, suppress_after_n_rejects }`

## Required output

A JSON array of digest entries:

```json
[
  {
    "title": "<8-10 word imperative>",
    "kind": "bug|tech-debt|feature|hygiene",
    "priority": "p0|p1|p2|p3",
    "source": "<adapter kind>",
    "evidence_url": "<url|null>",
    "rationale": "<2-3 sentence why-now>",
    "estimated_loc": "<small|medium|large>"
  },
  ...
]
```

Plus a single summary issue body in markdown.

## Discipline

- 3 ≤ entries ≤ 7. If <3 candidates after suppression, emit "no actionable items" and return empty array.
- Drop any candidate that is similar (cosine ≥ 0.85 via Haiku embedding) to ≥ N rejections, where N = `suppress_after_n_rejects`.
- Prioritize: p0 = active prod bug, p1 = recurring user pain, p2 = obvious tech debt, p3 = minor hygiene.
- Each entry must include `evidence_url` unless source is `codebase_audit` or `competitive`.

## Cost

Uses `models.scout` (default `claude-haiku-4-5`). Bounded by `cost_caps.scout_digest`.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/scout-digest.md
git commit -m "feat: prompts/scout-digest — daily scout digest generator system prompt"
```

---

## Task 22: Prompt template — `drift-check.md`

**Files:**
- Create: `prompts/drift-check.md`

- [ ] **Step 1: Author the prompt**

`prompts/drift-check.md`:

```markdown
# Drift-Check Agent

You compare the actual diff against the spec's declared scope and decide whether the implementation has crept beyond what was approved.

## Inputs

- `{{spec_text}}` — full content of the spec file
- `{{diff_summary}}` — `git diff --stat <base>...<head>` output
- `{{out_of_scope_files}}` — pre-computed list of files not in declared scope (from local TS step)
- `{{config.guardrails}}` — `scope_creep_thresholds` and `trivial_cleanup_categories`

## Required output

```json
{
  "verdict": "clean" | "scope_creep" | "needs_review",
  "out_of_scope_files": [
    { "path": "<path>", "added_lines": <int>, "trivial": <bool>, "reason": "<short>" },
    ...
  ],
  "trivial_files": [{ "path": "<path>", "category": "<formatting|import-sort|...>" }, ...],
  "summary": "<markdown comment to post on the issue>"
}
```

## Decision rules

- All out-of-scope files are trivial (per `trivial_cleanup_categories`) → verdict: `clean`.
- Some out-of-scope files are non-trivial AND `loc_outside_spec_scope <= scope_creep_thresholds.loc_outside_spec_scope` → verdict: `needs_review` (workflow continues but human gets a heads-up).
- Some out-of-scope files are non-trivial AND `loc_outside_spec_scope > scope_creep_thresholds.loc_outside_spec_scope` OR `files_outside_spec_scope > scope_creep_thresholds.files_outside_spec_scope` → verdict: `scope_creep`. The workflow labels `state:blocked`.

## Cost

Uses `models.drift_detection` (default `claude-haiku-4-5`). The bulk of the work is local file-list arithmetic — the model is invoked only for the categorization of "is this trivial?" calls on edge cases.
```

- [ ] **Step 2: Commit**

```bash
git add prompts/drift-check.md
git commit -m "feat: prompts/drift-check — drift detector system prompt"
```

---

## Task 23: Tests for all 7 prompt templates

**Files:**
- Create: `tests/unit/prompts.test.ts`

- [ ] **Step 1: Write the test**

`tests/unit/prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPECTED_PROMPTS } from '../../lib/plugin-files';

const promptsDir = resolve(__dirname, '../../prompts');

describe('prompts/', () => {
  for (const name of EXPECTED_PROMPTS) {
    describe(`${name}.md`, () => {
      const path = resolve(promptsDir, `${name}.md`);

      it('file exists', () => {
        expect(existsSync(path)).toBe(true);
      });

      it('starts with an H1 role label', () => {
        const raw = readFileSync(path, 'utf8');
        const firstLine = raw.split('\n')[0];
        expect(firstLine).toMatch(/^# /);
      });

      it('has an "Inputs" section listing template variables', () => {
        const raw = readFileSync(path, 'utf8');
        expect(raw).toMatch(/##? Inputs/i);
        expect(raw).toMatch(/\{\{[a-z_.]+\}\}/);
      });

      it('has a "Required output" or output-format section', () => {
        const raw = readFileSync(path, 'utf8');
        expect(raw).toMatch(/##? Required output|##? Output format/i);
      });
    });
  }

  it('contains exactly the expected 7 prompts (no extras)', () => {
    const files = readdirSync(promptsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(files).toEqual([...EXPECTED_PROMPTS].sort());
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- tests/unit/prompts.test.ts`
Expected: 29 passing (4 per prompt × 7 + 1 set check).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/prompts.test.ts
git commit -m "test: validate 7 prompt templates have correct structure"
```

---

## Task 24: Update `package.json` version + `README.md` install instructions

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Bump package.json version**

Change `"version"` field in `package.json` from `0.1.0-alpha.0` (or whatever it currently is) to `0.1.0-alpha.2`.

- [ ] **Step 2: Update README.md install + commands sections**

Replace the "Install (placeholder — Phase 1 will finalize)" section and the post-install snippet with:

```markdown
## Install

From a local checkout:

```bash
claude plugin install "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
```

From the published GitHub repo (after Phase 1d ships):

```bash
claude plugin install alizaouane/dev-agent
```

Then in any consumer repo:

```
/dev-agent-init
```

## Slash commands (reference)

| Command | Purpose |
|---|---|
| `/dev-agent-init` | One-time consumer-repo bootstrap |
| `/develop <intent\|url>` | Start a feature; runs spec brainstorm at Gate 1 |
| `/proposals` | List open scout-proposed features |
| `/status` | Tabular view of in-flight features |
| `/approve <issue#> [--promote]` | Advance past Gate 1 / 2 / 3 |
| `/abandon <issue#>` | Cancel an in-flight feature |
| `/rollback <issue#>` | Revert a shipped feature |
| `/digest` | Trigger scout out-of-cycle |

See `commands/<name>.md` for full per-command docs.

## Internal skills (reference)

| Skill | Purpose |
|---|---|
| `orchestrator` | State-machine reference + transition rules |
| `scout` | Source adapters + digest generator |
| `drift-check` | Diff-vs-spec scope creep detector |
| `notify` | 4-channel notification fan-out (push/email/issue/status-file) |

These are `user-invocable: false` — invoked by slash commands and reusable workflows, not by the user.
```

- [ ] **Step 3: Verify the manifest test still passes (it asserts version match)**

Run: `npm test -- tests/unit/plugin-manifest.test.ts`
Expected: 6 passing (the "manifest version matches package.json version" test verifies they're in sync).

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "chore: bump to 0.1.0-alpha.2 + README install + commands index"
```

---

## Task 25: Full local verification

**Files:** none

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green. Approximate test count after 1b: 23 (from 1a) + 6 (manifest) + 41 (commands) + 21 (skills) + 29 (prompts) = **120 tests across 11 files**. Adjust the count assertion if the actual numbers diverge.

- [ ] **Step 3: Smoke-test the plugin install (manual, optional in CI)**

Run: `claude plugin install "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"`
Expected: plugin appears in `claude plugin list`. Then in any other directory: `/help` shows the 8 dev-agent commands. Then `claude plugin uninstall dev-agent` to clean up after the smoke. (Tracked as a manual checkpoint; not run from CI because the `claude` CLI isn't installed on Actions runners.)

---

## Task 26: Open PR, get CI green, merge, tag `v0.1.0-alpha.2`

**Files:** none

- [ ] **Step 1: Push the feature branch**

Branch name suggestion: `feat/phase-1b-plugin-surface`.

```bash
git push -u origin feat/phase-1b-plugin-surface
```

- [ ] **Step 2: Open PR**

Title: `Phase 1b: Plugin surface — manifest, 8 commands, 4 skills, 7 prompts`

Body should summarize: deliverables (per the file table at top), test counts, deferred items (workflows in 1c).

- [ ] **Step 3: Wait for CI green**

The CI workflow added in 1a (`.github/workflows/ci.yml`) runs typecheck + tests. Verify the `test` job passes.

- [ ] **Step 4: Merge to main**

Use `gh pr merge --merge` (preserves atomic commit history).

- [ ] **Step 5: Tag**

```bash
git checkout main && git pull --ff-only origin main
git tag -a v0.1.0-alpha.2 -m "Phase 1b: Plugin surface — manifest, commands, skills, prompts"
git push origin v0.1.0-alpha.2
```

- [ ] **Step 6: Verify**

```bash
gh api repos/alizaouane/dev-agent/tags --jq '.[] | select(.name=="v0.1.0-alpha.2")'
```

Expected: tag listed pointing at the merge commit.

---

## Plan 1b self-review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `.claude-plugin/plugin.json` (corrected from spec's `.claude/plugin.json`) | Task 1 |
| 8 slash commands | Tasks 2–9 (one per command) |
| 4 plugin skills | Tasks 11–14 |
| 7 prompt templates | Tasks 16–22 |
| Plugin installable | Task 25 (manual smoke) |
| Tag `v0.1.0-alpha.2` | Task 26 |
| Tests for all of the above | Tasks 1, 10, 15, 23 |

**NOT in 1b (deferred):**
- Reusable GH workflows (`phase-implement.yml` etc.) → Plan 1c
- Synthetic test consumer (`examples/test-repo/.github/workflows/`) → Plan 1c
- Real model invocations from inside slash commands → Plan 1c (workflows are the real model entry point; commands are dispatchers)
- TypeScript implementation of `lib/orchestrator.ts`, `lib/drift-check.ts`, scout source adapters → Plan 1c

**Type-consistency check:** `EXPECTED_COMMANDS` / `EXPECTED_SKILLS` / `EXPECTED_PROMPTS` in `lib/plugin-files.ts` are the single source of truth, consumed by 4 different test files. Adding a 9th command requires updating exactly one file.

**Spec deviation log:**
- Plugin manifest path corrected from `.claude/plugin.json` to `.claude-plugin/plugin.json` (per current Claude Code docs). Documented in the file structure table and in Task 1.

---

## Acceptance criteria for Plan 1b (must all be green to advance to Plan 1c)

- [ ] `npm run typecheck` passes (no errors)
- [ ] `npm test` passes (all ~120 unit tests across 11 files)
- [ ] `.claude-plugin/plugin.json` validates (Task 1's tests)
- [ ] All 8 commands present with valid frontmatter (Task 10's tests)
- [ ] All 4 skills present with valid frontmatter (Task 15's tests)
- [ ] All 7 prompt templates present with required sections (Task 23's tests)
- [ ] `package.json` version matches manifest version (cross-check test)
- [ ] CI workflow green on `main`
- [ ] Tag `v0.1.0-alpha.2` exists on GitHub
- [ ] `claude plugin install "<path>"` succeeds locally (manual smoke; not gated by CI)
- [ ] Caliente Booking and Qualiency App repos: zero modifications
