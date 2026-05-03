# dev-agent Phase 1c — Reusable Workflows + Synthetic Test Consumer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan is sub-plan 1c of 4.** Plans 1a (Foundation, `v0.1.0-alpha.1`) and 1b (Plugin Surface, `v0.1.0-alpha.2`) are shipped. Plan 1c adds the **reusable GitHub workflows** that consumer repos call via `uses: alizaouane/dev-agent/.github/workflows/<phase>.yml@v1`, the **TypeScript helpers** the workflows depend on (`render-prompt`, `orchestrator`, `drift-check`, scout adapters, anthropic client), and the **synthetic test consumer** at `examples/test-repo/` that the workflows are exercised against. Plan 1d follows: real Anthropic API wiring (replacing stubs), full lifecycle drill, gap fixes, and the `v0.1.0` final tag.

**Goal:** End state — six reusable workflows live at `.github/workflows/phase-*.yml` and `orch-sweep.yml`, each callable via `workflow_call` with documented inputs/outputs/secrets and syntactically valid YAML; TS helpers under `lib/` carry the orchestration logic with full unit-test coverage; the synthetic test consumer at `examples/test-repo/` has package.json + mock scripts + 6 thin wrapper workflows that reference the parent repo's reusable workflows. The Anthropic API integration is **stubbed in 1c** — workflows produce deterministic non-LLM output so the wiring (label transitions, issue comments, PR creation, telemetry posting) is testable without burning model tokens. The real `claude-code-action` wiring lands in Plan 1d alongside the live lifecycle drill.

**Architecture:** Workflows are thin orchestrators — they parse inputs, run TS helpers via `tsx`, and react to helper output. All real logic lives in `lib/`. Workflow steps that previously would invoke Claude are gated by an `INVOCATION_MODE` env var (`stub` or `live`); 1c ships in `stub` mode by default with `live` ready to flip in 1d. Untrusted inputs (issue titles, bodies, comments) are NEVER inlined in `run:` blocks — they're passed via `env:` with proper quoting per GitHub Actions security guidance. TS helpers that shell out (drift-check) use `execFileSync` with separate args, never `execSync` with template-string interpolation.

**Tech Stack:** TypeScript 5.6 / Node 20; `tsx` for runtime; `@anthropic-ai/sdk` (declared, used in `live` mode by 1d); `@octokit/rest` for GitHub API in TS helpers; `handlebars` for prompt template rendering; `minimatch` for glob matching in drift-check; existing `zod`, `js-yaml`, `deepmerge`, `vitest`.

---

## Plan series overview (recap, with status)

| Sub-plan | Goal | Status |
|---|---|---|
| 1a | Foundation: schema/, lib/, sample config, repo CI | ✅ shipped (`v0.1.0-alpha.1`) |
| 1b | Plugin surface: manifest, 8 commands, 4 skills, 7 prompts | ✅ shipped (`v0.1.0-alpha.2`) |
| **1c (this plan)** | Reusable workflows + TS helpers + synthetic test consumer | in progress |
| 1d | Live Anthropic wiring + end-to-end lifecycle drill + `v0.1.0` final tag | pending |

---

## Scope discipline (what's in 1c vs deferred to 1d)

**In 1c:**
- All 6 workflow YAML files (syntactically valid, callable, fully wired except the model-invocation step)
- TS helpers: `render-prompt`, `orchestrator`, `drift-check`, `cost-cap`, `anthropic-client` (stub-only in 1c), 5 scout adapters (1 real + 4 typed-stubs)
- Synthetic test consumer fleshed out: `package.json` with mock test/build/typecheck/deploy scripts, `tests/`, `.github/workflows/dev-agent-*.yml` wrappers (6 of them)
- Unit tests for every TS helper
- Structural-validity tests for every workflow file (parses, has required keys, declares required secrets, no untrusted-input inlining)

**Deferred to 1d:**
- Live Anthropic API calls (`live` mode flip, prompt-cache wiring, real model selection, cost/duration capture from real responses)
- Full end-to-end lifecycle drill against the synthetic consumer (`/develop` → `/approve` → phase-implement → ... → `/rollback`)
- The 4 stubbed scout adapters becoming real (`vercel_logs`, `supabase_logs`, `competitive`, plus tightening `codebase_audit`)
- Gap fixes discovered during the drill
- Tag `v0.1.0`

---

## File structure (Plan 1c)

**Create — TS helpers:**

| File | Responsibility |
|---|---|
| `lib/render-prompt.ts` | Load `prompts/<name>.md`, substitute `{{var}}` placeholders via Handlebars, return rendered text |
| `lib/orchestrator.ts` | State-transition table + `validateTransition(from, trigger)` enforcement |
| `lib/drift-check.ts` | Compute changed-files set, declared-scope set from spec, classify each into in-scope / trivial / out-of-scope; apply thresholds |
| `lib/cost-cap.ts` | Track tokens-in / tokens-out / dollars across a phase run; throw if exceeded |
| `lib/anthropic-client.ts` | Thin wrapper around `@anthropic-ai/sdk`. Honors `INVOCATION_MODE=stub` by returning a deterministic canned response. `live` mode wires up real API calls (used by 1d). |
| `lib/scout/types.ts` | Common candidate type used by all scout adapters |
| `lib/scout/github-issues.ts` | Real adapter: enumerate triage/bug-labeled issues |
| `lib/scout/codebase-audit.ts` | Real adapter: TODO/FIXME/HACK + pitfalls scan |
| `lib/scout/vercel-logs.ts` | Stub (typed shell, returns empty list, marked `STUB_FOR_1D`) |
| `lib/scout/supabase-logs.ts` | Stub |
| `lib/scout/competitive.ts` | Stub |
| `lib/scout/index.ts` | Dispatch by source kind |
| `lib/cli/render-and-run.ts` | tsx-runnable CLI — workflow steps invoke this with env vars; orchestrates render-prompt + anthropic-client + telemetry |
| `lib/cli/drift-check.ts` | tsx-runnable CLI for the drift step (uses `execFileSync` with args array — never shell-string interpolation) |
| `lib/cli/orchestrate.ts` | tsx-runnable CLI for state transitions (called by workflows after each phase result) |

**Create — workflow files at this repo's root:**

| File | Responsibility |
|---|---|
| `.github/workflows/phase-implement.yml` | Implementation phase (workflow_call). Triggered by consumer's wrapper on `state:implementing` label. |
| `.github/workflows/phase-staging-deploy.yml` | Staging deploy chain |
| `.github/workflows/phase-promote-to-prod.yml` | Prod promote chain |
| `.github/workflows/phase-smoke-verify.yml` | Smoke output classifier |
| `.github/workflows/phase-rollback.yml` | Revert merge + redeploy + rollback SQL |
| `.github/workflows/orch-sweep.yml` | Cron polling fallback (every 10 min) for missed webhooks |

**Create — synthetic test consumer:**

| File | Responsibility |
|---|---|
| `examples/test-repo/package.json` | Mock consumer with stubbed test/build/typecheck/deploy scripts |
| `examples/test-repo/scripts/mock-test.sh` | Echoes "tests pass"; exit 0 |
| `examples/test-repo/scripts/mock-build.sh` | Echoes "build ok"; exit 0 |
| `examples/test-repo/scripts/mock-typecheck.sh` | Echoes "no type errors"; exit 0 |
| `examples/test-repo/scripts/mock-deploy-staging.sh` | Echoes "deployed to staging-fake.example.com"; exit 0 |
| `examples/test-repo/scripts/mock-deploy-prod.sh` | Echoes "deployed to prod-fake.example.com"; exit 0 |
| `examples/test-repo/.github/workflows/dev-agent-implement.yml` | Wrapper: `uses: ./.github/workflows/phase-implement.yml` (relative for in-repo testing; tagged `@v1` example shown in comment) |
| `examples/test-repo/.github/workflows/dev-agent-staging-deploy.yml` | Wrapper |
| `examples/test-repo/.github/workflows/dev-agent-promote-to-prod.yml` | Wrapper |
| `examples/test-repo/.github/workflows/dev-agent-smoke-verify.yml` | Wrapper |
| `examples/test-repo/.github/workflows/dev-agent-rollback.yml` | Wrapper |
| `examples/test-repo/.github/workflows/dev-agent-orch-sweep.yml` | Wrapper |
| `examples/test-repo/docs/specs/.gitkeep` | Placeholder spec dir |
| `examples/test-repo/docs/program-status.md` | Initial status file |

**Create — tests:**

| File | Responsibility |
|---|---|
| `tests/unit/render-prompt.test.ts` | Substitution correctness, missing-var behavior |
| `tests/unit/orchestrator.test.ts` | Transition table coverage, illegal-transition rejection |
| `tests/unit/drift-check.test.ts` | In-scope / trivial / out-of-scope classification, threshold logic |
| `tests/unit/cost-cap.test.ts` | Tracker accumulation, cap-exceeded throw |
| `tests/unit/anthropic-client.test.ts` | Stub-mode determinism; `INVOCATION_MODE` env handling |
| `tests/unit/scout-github-issues.test.ts` | Real adapter against mocked Octokit |
| `tests/unit/scout-codebase-audit.test.ts` | TODO/FIXME scanner against fixture files |
| `tests/unit/scout-stubs.test.ts` | Stubbed adapters return empty list with `STUB_FOR_1D` marker in stderr |
| `tests/unit/workflows.test.ts` | All 6 workflow YAML files parse, declare required `secrets:` and `inputs:`, no `${{ github.event.* (title\|body) }}` in `run:` blocks |
| `tests/unit/test-repo-config.test.ts` | examples/test-repo `.dev-agent.yml` parses and the 6 wrapper workflows reference the correct parent paths |

**Modify:**

| File | Change |
|---|---|
| `package.json` | Add deps: `@anthropic-ai/sdk`, `@octokit/rest`, `handlebars`, `minimatch`. Bump version to `0.1.0-alpha.3`. |
| `tsconfig.json` | (no change expected, but verify `lib/cli/**` and `lib/scout/**` are picked up by `include`) |
| `README.md` | Add "Phase 1c — workflows + test consumer" subsection; document `INVOCATION_MODE` env |

---

## Conventions used across all workflow files

**Workflow shape:**

```yaml
name: <human-readable phase name>

on:
  workflow_call:
    inputs:
      issue_number:
        required: true
        type: number
      config_path:
        required: false
        type: string
        default: '.dev-agent.yml'
      invocation_mode:
        required: false
        type: string
        default: 'stub'
    secrets:
      ANTHROPIC_API_KEY:
        required: false  # only required in live mode
      RESEND_API_KEY:
        required: false
      NTFY_TOPIC:
        required: false

jobs:
  <phase>:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - name: <phase-specific step>
        env:
          ISSUE_NUMBER: ${{ inputs.issue_number }}
          CONFIG_PATH: ${{ inputs.config_path }}
          INVOCATION_MODE: ${{ inputs.invocation_mode }}
          GH_TOKEN: ${{ github.token }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: npx tsx lib/cli/render-and-run.ts <phase-name>
```

**Security:** No `${{ github.event.* (title|body) }}` field is interpolated directly into a `run:` block. Untrusted inputs are passed via `env:` and consumed by TS scripts that quote them safely. The workflow-test (Task 16) enforces this with a regex check. TS helpers that shell out use `execFileSync(cmd, [args...])` not `execSync(\`cmd ${arg}\`)`.

---

## Task 1: Add deps + bump version

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add deps**

Add to `dependencies` (preserve existing):
```json
"@anthropic-ai/sdk": "^0.32.0",
"@octokit/rest": "^21.0.0",
"handlebars": "^4.7.8",
"minimatch": "^10.0.0"
```

Bump `version` to `"0.1.0-alpha.3"`.

- [ ] **Step 2: Install + verify**

```bash
npm install
npm run typecheck
npm test
```

Expected: install clean; typecheck clean; tests still 120/120.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @anthropic-ai/sdk, @octokit/rest, handlebars, minimatch + bump 0.1.0-alpha.3"
```

---

## Task 2: `lib/render-prompt.ts` (Handlebars-based template renderer)

**Files:**
- Create: `lib/render-prompt.ts`
- Create: `tests/unit/render-prompt.test.ts`

- [ ] **Step 1: Write the test first**

`tests/unit/render-prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderPrompt } from '../../lib/render-prompt';

describe('renderPrompt', () => {
  it('substitutes {{var}} placeholders', () => {
    const out = renderPrompt('implement', {
      spec_path: 'docs/specs/foo.md',
      branch_name: 'feat/bar',
      commands: { test: 'npm test', typecheck: 'tsc', lint: 'eslint' },
      guardrails: {
        blocked_paths: ['supabase/migrations/**'],
        require_explicit_unlock: ['tests/integration/**'],
        max_files_changed: 30,
        max_lines_changed: 800,
      },
    });
    expect(out).toContain('docs/specs/foo.md');
    expect(out).toContain('feat/bar');
    expect(out).toContain('npm test');
  });

  it('throws on missing required variable', () => {
    expect(() => renderPrompt('implement', {})).toThrow();
  });

  it('handles array variables', () => {
    const out = renderPrompt('staging-deploy', {
      deploy_skills: { staging: ['deploy-a', 'deploy-b'] },
      branches: { staging: 'staging' },
      commands: { test: 'npm test' },
      merge_sha: 'abc123',
    });
    expect(out).toContain('deploy-a');
  });

  it('rejects unknown prompt name', () => {
    expect(() => renderPrompt('does-not-exist' as never, {})).toThrow(/unknown|not found/i);
  });
});
```

- [ ] **Step 2: Run test (should fail — module missing)**

- [ ] **Step 3: Create `lib/render-prompt.ts`**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { EXPECTED_PROMPTS, type ExpectedPrompt } from './plugin-files';

const promptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export type PromptVariables = Record<string, unknown>;

export function renderPrompt(name: ExpectedPrompt, vars: PromptVariables): string {
  if (!EXPECTED_PROMPTS.includes(name)) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  const path = resolve(promptsDir, `${name}.md`);
  if (!existsSync(path)) {
    throw new Error(`Prompt template not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const template = Handlebars.compile(raw, { strict: true, noEscape: true });
  try {
    return template(vars);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`renderPrompt(${name}): missing variable — ${msg}`);
  }
}
```

- [ ] **Step 4: Re-run test (4 passing)**

- [ ] **Step 5: Commit**

```bash
git add lib/render-prompt.ts tests/unit/render-prompt.test.ts
git commit -m "feat: lib/render-prompt — Handlebars-based prompt template renderer"
```

---

## Task 3: `lib/orchestrator.ts` (state-machine enforcement)

**Files:**
- Create: `lib/orchestrator.ts`
- Create: `tests/unit/orchestrator.test.ts`

- [ ] **Step 1: Write the test**

`tests/unit/orchestrator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  validateTransition,
  STATE_LABELS,
  TRANSITION_TABLE,
} from '../../lib/orchestrator';

describe('orchestrator', () => {
  it('exports the canonical 12 state labels', () => {
    expect(STATE_LABELS).toHaveLength(12);
    expect(STATE_LABELS).toContain('state:spec-ready');
    expect(STATE_LABELS).toContain('state:done');
    expect(STATE_LABELS).toContain('state:blocked');
  });

  it('allows the happy-path transition spec-ready → implementing via /approve', () => {
    const result = validateTransition('state:spec-ready', '/approve');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toBe('state:implementing');
  });

  it('allows promoting via /approve --promote', () => {
    const result = validateTransition('state:ready-to-promote', '/approve --promote');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toBe('state:promoting');
  });

  it('rejects /approve --promote on spec-ready', () => {
    const result = validateTransition('state:spec-ready', '/approve --promote');
    expect(result.ok).toBe(false);
  });

  it('rejects /approve on a terminal state', () => {
    const result = validateTransition('state:done', '/approve');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/terminal|gateable/i);
  });

  it('every TRANSITION_TABLE row references a known state', () => {
    for (const row of TRANSITION_TABLE) {
      expect(STATE_LABELS).toContain(row.from);
      expect(STATE_LABELS).toContain(row.to);
    }
  });
});
```

- [ ] **Step 2: Run test (fails — module missing)**

- [ ] **Step 3: Create `lib/orchestrator.ts`**

```ts
export const STATE_LABELS = [
  'state:proposed',
  'state:scoping',
  'state:spec-ready',
  'state:implementing',
  'state:pr-review',
  'state:staging-deployed',
  'state:ready-to-promote',
  'state:promoting',
  'state:done',
  'state:blocked',
  'state:abandoned',
  'state:rolled-back',
] as const;

export type StateLabel = (typeof STATE_LABELS)[number];

const TERMINAL_STATES: ReadonlySet<StateLabel> = new Set([
  'state:done',
  'state:abandoned',
  'state:rolled-back',
]);

export type TransitionTrigger =
  | '/proposals-accept'
  | '/develop-auto'
  | '/approve'
  | 'workflow-pr-open'
  | 'smoke-pass-staging'
  | '/approve --promote'
  | 'smoke-pass-prod'
  | '/abandon'
  | '/rollback-complete'
  | 'phase-failure';

export type TransitionRow = {
  from: StateLabel;
  trigger: TransitionTrigger;
  to: StateLabel;
  fires?: string;
};

export const TRANSITION_TABLE: readonly TransitionRow[] = [
  { from: 'state:proposed',          trigger: '/proposals-accept',  to: 'state:scoping' },
  { from: 'state:scoping',           trigger: '/develop-auto',      to: 'state:spec-ready' },
  { from: 'state:spec-ready',        trigger: '/approve',           to: 'state:implementing',     fires: 'phase-implement.yml' },
  { from: 'state:implementing',      trigger: 'workflow-pr-open',   to: 'state:pr-review' },
  { from: 'state:pr-review',         trigger: '/approve',           to: 'state:staging-deployed', fires: 'phase-staging-deploy.yml' },
  { from: 'state:staging-deployed',  trigger: 'smoke-pass-staging', to: 'state:ready-to-promote' },
  { from: 'state:ready-to-promote',  trigger: '/approve --promote', to: 'state:promoting',        fires: 'phase-promote-to-prod.yml' },
  { from: 'state:promoting',         trigger: 'smoke-pass-prod',    to: 'state:done' },
] as const;

export type TransitionResult =
  | { ok: true; next: StateLabel; fires?: string }
  | { ok: false; reason: string };

export function validateTransition(
  from: StateLabel,
  trigger: TransitionTrigger,
): TransitionResult {
  if (TERMINAL_STATES.has(from)) {
    return { ok: false, reason: `${from} is terminal — not a gateable state` };
  }
  if (trigger === '/abandon') return { ok: true, next: 'state:abandoned' };
  if (trigger === '/rollback-complete') return { ok: true, next: 'state:rolled-back' };
  if (trigger === 'phase-failure') return { ok: true, next: 'state:blocked' };

  const row = TRANSITION_TABLE.find((r) => r.from === from && r.trigger === trigger);
  if (!row) {
    return { ok: false, reason: `no transition from ${from} via ${trigger}` };
  }
  return row.fires ? { ok: true, next: row.to, fires: row.fires } : { ok: true, next: row.to };
}
```

- [ ] **Step 4: Re-run test (6 passing)**

- [ ] **Step 5: Commit**

```bash
git add lib/orchestrator.ts tests/unit/orchestrator.test.ts
git commit -m "feat: lib/orchestrator — state machine enforcement (12 states, 8 transitions)"
```

---

## Task 4: `lib/cost-cap.ts`

**Files:**
- Create: `lib/cost-cap.ts`
- Create: `tests/unit/cost-cap.test.ts`

- [ ] **Step 1: Write the test**

`tests/unit/cost-cap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CostCapTracker } from '../../lib/cost-cap';

describe('CostCapTracker', () => {
  it('accumulates tokens and dollars', () => {
    const t = new CostCapTracker({ tokens_in: 1000, tokens_out: 500, dollars: 0.5 });
    t.add({ tokens_in: 100, tokens_out: 50, dollars: 0.05 });
    t.add({ tokens_in: 200, tokens_out: 100, dollars: 0.10 });
    const usage = t.usage();
    expect(usage.tokens_in).toBe(300);
    expect(usage.tokens_out).toBe(150);
    expect(usage.dollars).toBeCloseTo(0.15, 5);
  });

  it('throws when tokens_in cap is exceeded', () => {
    const t = new CostCapTracker({ tokens_in: 100, tokens_out: 100, dollars: 1 });
    expect(() => t.add({ tokens_in: 150, tokens_out: 0, dollars: 0 })).toThrow(/tokens_in/i);
  });

  it('throws when dollars cap is exceeded', () => {
    const t = new CostCapTracker({ tokens_in: 1e9, tokens_out: 1e9, dollars: 0.10 });
    expect(() => t.add({ tokens_in: 1, tokens_out: 1, dollars: 0.20 })).toThrow(/dollars/i);
  });

  it('approachingCap returns true at 80%+ usage', () => {
    const t = new CostCapTracker({ tokens_in: 100, tokens_out: 100, dollars: 1 });
    t.add({ tokens_in: 85, tokens_out: 0, dollars: 0 });
    expect(t.approachingCap()).toBe(true);
  });

  it('approachingCap returns false below 80%', () => {
    const t = new CostCapTracker({ tokens_in: 100, tokens_out: 100, dollars: 1 });
    t.add({ tokens_in: 50, tokens_out: 50, dollars: 0.5 });
    expect(t.approachingCap()).toBe(false);
  });
});
```

- [ ] **Step 2: Create `lib/cost-cap.ts`**

```ts
export type PhaseCap = { tokens_in: number; tokens_out: number; dollars: number };
export type Usage = { tokens_in: number; tokens_out: number; dollars: number };

export class CostCapTracker {
  private used: Usage = { tokens_in: 0, tokens_out: 0, dollars: 0 };

  constructor(private readonly cap: PhaseCap) {}

  add(delta: Usage): void {
    this.used.tokens_in += delta.tokens_in;
    this.used.tokens_out += delta.tokens_out;
    this.used.dollars += delta.dollars;
    if (this.used.tokens_in > this.cap.tokens_in) {
      throw new Error(`cost cap exceeded: tokens_in ${this.used.tokens_in} > ${this.cap.tokens_in}`);
    }
    if (this.used.tokens_out > this.cap.tokens_out) {
      throw new Error(`cost cap exceeded: tokens_out ${this.used.tokens_out} > ${this.cap.tokens_out}`);
    }
    if (this.used.dollars > this.cap.dollars) {
      throw new Error(`cost cap exceeded: dollars ${this.used.dollars.toFixed(2)} > ${this.cap.dollars}`);
    }
  }

  usage(): Usage {
    return { ...this.used };
  }

  approachingCap(threshold = 0.8): boolean {
    return (
      this.used.tokens_in / this.cap.tokens_in >= threshold ||
      this.used.tokens_out / this.cap.tokens_out >= threshold ||
      this.used.dollars / this.cap.dollars >= threshold
    );
  }
}
```

- [ ] **Step 3: Re-run test (5 passing)**

- [ ] **Step 4: Commit**

```bash
git add lib/cost-cap.ts tests/unit/cost-cap.test.ts
git commit -m "feat: lib/cost-cap — per-phase token/dollar tracker with approaching-cap check"
```

---

## Task 5: `lib/anthropic-client.ts` (stub-mode by default)

**Files:**
- Create: `lib/anthropic-client.ts`
- Create: `tests/unit/anthropic-client.test.ts`

- [ ] **Step 1: Write the test**

`tests/unit/anthropic-client.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { invokeAnthropic } from '../../lib/anthropic-client';

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_MODE = process.env.INVOCATION_MODE;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_MODE === undefined) delete process.env.INVOCATION_MODE;
  else process.env.INVOCATION_MODE = ORIGINAL_MODE;
});

describe('anthropic-client', () => {
  it('stub mode returns deterministic canned response', async () => {
    const resp = await invokeAnthropic({
      mode: 'stub',
      model: 'claude-haiku-4-5',
      system: 'sys',
      user: 'hi',
    });
    expect(resp.text).toContain('STUB');
    expect(resp.usage.tokens_in).toBeGreaterThan(0);
    expect(resp.usage.tokens_out).toBeGreaterThan(0);
    expect(resp.usage.dollars).toBeGreaterThanOrEqual(0);
  });

  it('stub mode is deterministic for the same inputs', async () => {
    const a = await invokeAnthropic({ mode: 'stub', model: 'claude-haiku-4-5', system: 's', user: 'u' });
    const b = await invokeAnthropic({ mode: 'stub', model: 'claude-haiku-4-5', system: 's', user: 'u' });
    expect(a.text).toBe(b.text);
    expect(a.usage).toEqual(b.usage);
  });

  it('live mode without API key throws a clear error', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      invokeAnthropic({ mode: 'live', model: 'claude-haiku-4-5', system: 's', user: 'u' }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/i);
  });

  it('reads INVOCATION_MODE env when mode is "auto"', async () => {
    process.env.INVOCATION_MODE = 'stub';
    const resp = await invokeAnthropic({ mode: 'auto', model: 'claude-haiku-4-5', system: 's', user: 'u' });
    expect(resp.text).toContain('STUB');
  });
});
```

- [ ] **Step 2: Create `lib/anthropic-client.ts`**

```ts
import { createHash } from 'node:crypto';

export type InvocationMode = 'stub' | 'live' | 'auto';

export type InvokeArgs = {
  mode: InvocationMode;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
};

export type InvokeResult = {
  text: string;
  usage: { tokens_in: number; tokens_out: number; dollars: number };
  model: string;
};

function resolveMode(mode: InvocationMode): 'stub' | 'live' {
  if (mode !== 'auto') return mode;
  return process.env.INVOCATION_MODE === 'live' ? 'live' : 'stub';
}

function deterministicStub(args: InvokeArgs): InvokeResult {
  const fingerprint = createHash('sha256')
    .update(`${args.model}\n${args.system}\n${args.user}`)
    .digest('hex')
    .slice(0, 12);
  const tokens_in = Math.max(1, (args.system.length + args.user.length) >> 2);
  const tokens_out = 64;
  return {
    text: `STUB[${fingerprint}]: ${args.model} would respond here in live mode.`,
    usage: { tokens_in, tokens_out, dollars: 0 },
    model: args.model,
  };
}

export async function invokeAnthropic(args: InvokeArgs): Promise<InvokeResult> {
  const mode = resolveMode(args.mode);
  if (mode === 'stub') return deterministicStub(args);
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY required for live invocation mode');
  }
  throw new Error('LIVE_MODE_NOT_WIRED_UNTIL_1D — set INVOCATION_MODE=stub to proceed');
}
```

- [ ] **Step 3: Re-run test (4 passing)**

- [ ] **Step 4: Commit**

```bash
git add lib/anthropic-client.ts tests/unit/anthropic-client.test.ts
git commit -m "feat: lib/anthropic-client — stub-mode invoker (live wiring deferred to 1d)"
```

---

## Task 6: `lib/drift-check.ts` + tests

**Files:**
- Create: `lib/drift-check.ts`
- Create: `tests/unit/drift-check.test.ts`

- [ ] **Step 1: Write the test**

`tests/unit/drift-check.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyChangedFiles, type ClassificationInput } from '../../lib/drift-check';

const baseInput: ClassificationInput = {
  changed_files: [],
  declared_scope: ['src/auth/**', 'tests/auth/**'],
  trivial_categories: ['formatting', 'import-sort', 'dead-code-removal', 'comment-fix'],
  trivial_classifier: () => false,
  thresholds: { files_outside_spec_scope: 0, loc_outside_spec_scope: 50 },
  added_lines: {},
};

describe('classifyChangedFiles', () => {
  it('classifies in-scope files correctly', () => {
    const r = classifyChangedFiles({
      ...baseInput,
      changed_files: ['src/auth/middleware.ts', 'tests/auth/middleware.test.ts'],
      added_lines: { 'src/auth/middleware.ts': 30, 'tests/auth/middleware.test.ts': 50 },
    });
    expect(r.in_scope).toEqual(['src/auth/middleware.ts', 'tests/auth/middleware.test.ts']);
    expect(r.out_of_scope).toEqual([]);
    expect(r.verdict).toBe('clean');
  });

  it('flags out-of-scope files as scope_creep when thresholds exceeded', () => {
    const r = classifyChangedFiles({
      ...baseInput,
      changed_files: ['src/auth/m.ts', 'src/payments/refund.ts'],
      added_lines: { 'src/auth/m.ts': 10, 'src/payments/refund.ts': 100 },
    });
    expect(r.out_of_scope).toContain('src/payments/refund.ts');
    expect(r.verdict).toBe('scope_creep');
  });

  it('treats trivial-classified files as allowed', () => {
    const r = classifyChangedFiles({
      ...baseInput,
      changed_files: ['src/auth/m.ts', 'src/util/format.ts'],
      added_lines: { 'src/auth/m.ts': 10, 'src/util/format.ts': 5 },
      trivial_classifier: (path) => path === 'src/util/format.ts',
    });
    expect(r.trivial).toContain('src/util/format.ts');
    expect(r.out_of_scope).toEqual([]);
    expect(r.verdict).toBe('clean');
  });

  it('verdict needs_review when below loc threshold but non-trivial', () => {
    const r = classifyChangedFiles({
      ...baseInput,
      changed_files: ['src/auth/m.ts', 'src/x/y.ts'],
      added_lines: { 'src/auth/m.ts': 10, 'src/x/y.ts': 30 },
      thresholds: { files_outside_spec_scope: 1, loc_outside_spec_scope: 50 },
    });
    expect(r.verdict).toBe('needs_review');
  });
});
```

- [ ] **Step 2: Create `lib/drift-check.ts`**

```ts
import { minimatch } from 'minimatch';

export type ClassificationInput = {
  changed_files: string[];
  declared_scope: string[];
  trivial_categories: string[];
  trivial_classifier: (path: string) => boolean;
  thresholds: { files_outside_spec_scope: number; loc_outside_spec_scope: number };
  added_lines: Record<string, number>;
};

export type Verdict = 'clean' | 'needs_review' | 'scope_creep';

export type Classification = {
  in_scope: string[];
  trivial: string[];
  out_of_scope: string[];
  loc_out_of_scope: number;
  verdict: Verdict;
};

export function classifyChangedFiles(input: ClassificationInput): Classification {
  const in_scope: string[] = [];
  const trivial: string[] = [];
  const out_of_scope: string[] = [];

  for (const file of input.changed_files) {
    if (input.declared_scope.some((glob) => minimatch(file, glob))) {
      in_scope.push(file);
    } else if (input.trivial_classifier(file)) {
      trivial.push(file);
    } else {
      out_of_scope.push(file);
    }
  }

  const loc_out_of_scope = out_of_scope.reduce(
    (sum, f) => sum + (input.added_lines[f] ?? 0),
    0,
  );

  let verdict: Verdict = 'clean';
  if (out_of_scope.length > 0) {
    if (
      out_of_scope.length > input.thresholds.files_outside_spec_scope ||
      loc_out_of_scope > input.thresholds.loc_outside_spec_scope
    ) {
      verdict = 'scope_creep';
    } else {
      verdict = 'needs_review';
    }
  }

  return { in_scope, trivial, out_of_scope, loc_out_of_scope, verdict };
}
```

- [ ] **Step 3: Re-run test (4 passing)**

- [ ] **Step 4: Commit**

```bash
git add lib/drift-check.ts tests/unit/drift-check.test.ts
git commit -m "feat: lib/drift-check — classify changed files into in-scope/trivial/out-of-scope"
```

---

## Task 7: Scout types + dispatch (`lib/scout/types.ts`, `lib/scout/index.ts`)

**Files:**
- Create: `lib/scout/types.ts`
- Create: `lib/scout/index.ts`

- [ ] **Step 1: Create `lib/scout/types.ts`**

```ts
export type Candidate = {
  source:
    | 'github_issues'
    | 'vercel_logs'
    | 'supabase_logs'
    | 'codebase_audit'
    | 'competitive';
  title: string;
  body: string;
  evidence_url: string | null;
  severity_hint: 'low' | 'medium' | 'high';
  novelty_score: number;
};
```

- [ ] **Step 2: Create `lib/scout/index.ts`**

```ts
import type { ScoutSource } from '../types';
import type { Candidate } from './types';
import { githubIssuesAdapter } from './github-issues';
import { codebaseAuditAdapter } from './codebase-audit';
import { vercelLogsAdapter } from './vercel-logs';
import { supabaseLogsAdapter } from './supabase-logs';
import { competitiveAdapter } from './competitive';

export async function runScoutSources(sources: ScoutSource[]): Promise<Candidate[]> {
  const all: Candidate[] = [];
  for (const src of sources) {
    switch (src.kind) {
      case 'github_issues': all.push(...(await githubIssuesAdapter())); break;
      case 'codebase_audit': all.push(...(await codebaseAuditAdapter(src))); break;
      case 'vercel_logs': all.push(...(await vercelLogsAdapter(src))); break;
      case 'supabase_logs': all.push(...(await supabaseLogsAdapter(src))); break;
      case 'competitive': all.push(...(await competitiveAdapter(src))); break;
    }
  }
  return all;
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/scout/types.ts lib/scout/index.ts
git commit -m "feat: lib/scout/{types,index} — common types + adapter dispatch"
```

---

## Task 8: Real scout adapter — `github-issues`

**Files:**
- Create: `lib/scout/github-issues.ts`
- Create: `tests/unit/scout-github-issues.test.ts`

- [ ] **Step 1: Write test (mock Octokit)**

`tests/unit/scout-github-issues.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(() => ({
    paginate: vi.fn().mockResolvedValue([
      { number: 1, title: 'login fails on Safari', body: 'Steps...', html_url: 'https://gh/1', labels: [{ name: 'bug' }] },
      { number: 2, title: 'add dark mode', body: 'Want...', html_url: 'https://gh/2', labels: [{ name: 'triage' }] },
      { number: 3, title: 'bump deps', body: 'routine', html_url: 'https://gh/3', labels: [{ name: 'chore' }] },
    ]),
  })),
}));

beforeEach(() => {
  process.env.GH_TOKEN = 'fake';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
});

describe('githubIssuesAdapter', () => {
  it('returns candidates for triage/bug-labeled issues', async () => {
    const { githubIssuesAdapter } = await import('../../lib/scout/github-issues');
    const candidates = await githubIssuesAdapter();
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.title)).toEqual([
      'login fails on Safari',
      'add dark mode',
    ]);
    expect(candidates[0].source).toBe('github_issues');
    expect(candidates[0].evidence_url).toBe('https://gh/1');
  });
});
```

- [ ] **Step 2: Create `lib/scout/github-issues.ts`**

```ts
import { Octokit } from '@octokit/rest';
import type { Candidate } from './types';

const RELEVANT_LABELS = new Set(['bug', 'triage']);

type IssueShape = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<string | { name: string }>;
};

export async function githubIssuesAdapter(): Promise<Candidate[]> {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repo || !token) return [];
  const [owner, name] = repo.split('/');
  const octokit = new Octokit({ auth: token });
  const issues = (await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
    owner,
    repo: name,
    state: 'open',
    per_page: 100,
  })) as IssueShape[];
  return issues
    .filter((i) =>
      i.labels.some((l) => RELEVANT_LABELS.has(typeof l === 'string' ? l : l.name)),
    )
    .map((i) => ({
      source: 'github_issues' as const,
      title: i.title,
      body: i.body ?? '',
      evidence_url: i.html_url,
      severity_hint: 'medium' as const,
      novelty_score: 0.5,
    }));
}
```

- [ ] **Step 3: Re-run test (1 passing)**

- [ ] **Step 4: Commit**

```bash
git add lib/scout/github-issues.ts tests/unit/scout-github-issues.test.ts
git commit -m "feat: lib/scout/github-issues — real adapter for triage/bug-labeled issues"
```

---

## Task 9: Real scout adapter — `codebase-audit`

**Files:**
- Create: `lib/scout/codebase-audit.ts`
- Create: `tests/unit/scout-codebase-audit.test.ts`
- Create: `tests/fixtures/codebase-audit/file-with-todo.ts`

- [ ] **Step 1: Create fixture**

`tests/fixtures/codebase-audit/file-with-todo.ts`:
```ts
// TODO: refactor this when the new auth lands
export function legacyAuth() { return null; }
// FIXME: this leaks memory under load
export function brokenCache() {}
```

- [ ] **Step 2: Write test**

`tests/unit/scout-codebase-audit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { codebaseAuditAdapter } from '../../lib/scout/codebase-audit';

const fixturesDir = resolve(__dirname, '../fixtures/codebase-audit');

describe('codebaseAuditAdapter', () => {
  it('finds TODO and FIXME entries', async () => {
    const candidates = await codebaseAuditAdapter({
      kind: 'codebase_audit',
      pitfalls_path: 'CLAUDE.md',
      max_age_days: 30,
      _scan_root: fixturesDir,
    });
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const titles = candidates.map((c) => c.title);
    expect(titles.some((t) => t.includes('refactor'))).toBe(true);
    expect(titles.some((t) => t.includes('leaks'))).toBe(true);
  });

  it('returns empty for a missing scan root', async () => {
    const candidates = await codebaseAuditAdapter({
      kind: 'codebase_audit',
      pitfalls_path: 'CLAUDE.md',
      max_age_days: 30,
      _scan_root: resolve(fixturesDir, 'nonexistent'),
    });
    expect(candidates).toEqual([]);
  });
});
```

- [ ] **Step 3: Create `lib/scout/codebase-audit.ts`**

```ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate } from './types';

type Config = {
  kind: 'codebase_audit';
  pitfalls_path: string;
  max_age_days: number;
  _scan_root?: string;
};

const MARKER_RE = /\b(TODO|FIXME|HACK)\b:?\s*(.*)$/;

function* walkFiles(root: string): Generator<string> {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walkFiles(full);
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

export async function codebaseAuditAdapter(config: Config): Promise<Candidate[]> {
  const root = config._scan_root ?? process.cwd();
  const out: Candidate[] = [];
  for (const file of walkFiles(root)) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(MARKER_RE);
      if (m) {
        const marker = m[1];
        const text = m[2].trim();
        if (text.length === 0) continue;
        out.push({
          source: 'codebase_audit',
          title: `${marker}: ${text.slice(0, 80)}`,
          body: `${file}:${i + 1}\n${lines[i].trim()}`,
          evidence_url: null,
          severity_hint: marker === 'FIXME' ? 'high' : 'medium',
          novelty_score: 0.6,
        });
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Re-run test (2 passing)**

- [ ] **Step 5: Commit**

```bash
git add lib/scout/codebase-audit.ts tests/unit/scout-codebase-audit.test.ts tests/fixtures/codebase-audit/
git commit -m "feat: lib/scout/codebase-audit — TODO/FIXME/HACK scanner"
```

---

## Task 10: Stubbed scout adapters (3 files)

**Files:**
- Create: `lib/scout/vercel-logs.ts`
- Create: `lib/scout/supabase-logs.ts`
- Create: `lib/scout/competitive.ts`
- Create: `tests/unit/scout-stubs.test.ts`

- [ ] **Step 1: Create the 3 stub files**

Each is a one-function file that emits the stub marker on stderr and returns an empty array.

- [ ] **Step 2: Write joint test**

`tests/unit/scout-stubs.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { vercelLogsAdapter } from '../../lib/scout/vercel-logs';
import { supabaseLogsAdapter } from '../../lib/scout/supabase-logs';
import { competitiveAdapter } from '../../lib/scout/competitive';

describe('scout stub adapters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('vercel-logs stub returns empty + marker', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await vercelLogsAdapter({ kind: 'vercel_logs', project: 'p' });
    expect(r).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('STUB_FOR_1D'));
  });

  it('supabase-logs stub returns empty + marker', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await supabaseLogsAdapter({ kind: 'supabase_logs', project_ids: ['p'] });
    expect(r).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('STUB_FOR_1D'));
  });

  it('competitive stub returns empty + marker', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await competitiveAdapter({ kind: 'competitive', feeds: [] });
    expect(r).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('STUB_FOR_1D'));
  });
});
```

- [ ] **Step 3: Run test (3 passing)**

- [ ] **Step 4: Commit**

```bash
git add lib/scout/{vercel-logs,supabase-logs,competitive}.ts tests/unit/scout-stubs.test.ts
git commit -m "feat: lib/scout — vercel/supabase/competitive stubs (real adapters in 1d)"
```

---

## Task 11: CLI helpers under `lib/cli/`

**Files:**
- Create: `lib/cli/render-and-run.ts`
- Create: `lib/cli/drift-check.ts`
- Create: `lib/cli/orchestrate.ts`

These are tsx-runnable scripts the workflow steps invoke. They read env vars, call the lib helpers, and write output to stdout.

**Security:** `lib/cli/drift-check.ts` shells out to `git`. It uses `execFileSync('git', [...args])` with arguments as separate elements — never `execSync(\`git ...${var}\`)`. This makes shell-injection via untrusted refs impossible.

- [ ] **Step 1: `lib/cli/render-and-run.ts`**

```ts
#!/usr/bin/env tsx
import { renderPrompt } from '../render-prompt';
import { invokeAnthropic } from '../anthropic-client';
import type { ExpectedPrompt } from '../plugin-files';

async function main(): Promise<void> {
  const promptName = process.argv[2] as ExpectedPrompt | undefined;
  if (!promptName) {
    console.error('usage: render-and-run.ts <prompt-name>');
    process.exit(2);
  }
  const varsRaw = process.env.PROMPT_VARS_JSON ?? '{}';
  const vars = JSON.parse(varsRaw) as Record<string, unknown>;
  const rendered = renderPrompt(promptName, vars);

  const result = await invokeAnthropic({
    mode: 'auto',
    model: process.env.MODEL ?? 'claude-haiku-4-5',
    system: rendered,
    user: process.env.USER_INPUT ?? '',
  });

  console.log(JSON.stringify({
    text: result.text,
    usage: result.usage,
    model: result.model,
  }));
}

main().catch((err) => {
  console.error(`render-and-run failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
```

- [ ] **Step 2: `lib/cli/drift-check.ts`** (uses `execFileSync`, NOT `execSync`)

```ts
#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { classifyChangedFiles } from '../drift-check';
import { parseConfig } from '../parse-config';

const SPEC_PATH = process.env.SPEC_PATH ?? '';
const BASE = process.env.BASE_REF ?? 'main';
const HEAD = process.env.HEAD_REF ?? 'HEAD';
const CONFIG_PATH = process.env.CONFIG_PATH ?? '.dev-agent.yml';

function declaredScopeFromSpec(specText: string): string[] {
  const m = specText.match(/##\s+(Critical files|Files modified)\s+([\s\S]*?)(?=\n##\s+|$)/i);
  if (!m) return [];
  return Array.from(m[2].matchAll(/^-\s+`?([^\s`]+)`?/gm)).map((mm) => mm[1]);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

async function main(): Promise<void> {
  if (!SPEC_PATH) throw new Error('SPEC_PATH required');
  const config = await parseConfig(CONFIG_PATH);
  const specText = readFileSync(SPEC_PATH, 'utf8');
  const declared_scope = declaredScopeFromSpec(specText);

  const range = `${BASE}...${HEAD}`;
  const diffNames = git('diff', '--name-only', range).split('\n').filter(Boolean);
  const diffStat = git('diff', '--numstat', range);
  const added_lines: Record<string, number> = {};
  for (const line of diffStat.split('\n').filter(Boolean)) {
    const [add, _del, file] = line.split('\t');
    added_lines[file] = parseInt(add, 10) || 0;
  }
  const result = classifyChangedFiles({
    changed_files: diffNames,
    declared_scope,
    trivial_categories: config.guardrails.trivial_cleanup_categories,
    trivial_classifier: () => false,
    thresholds: config.guardrails.scope_creep_thresholds,
    added_lines,
  });
  console.log(JSON.stringify(result));
  if (result.verdict === 'scope_creep') process.exit(1);
}

main().catch((err) => {
  console.error(`drift-check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
```

Note: `BASE`/`HEAD`/`range` are passed as **arguments** to `execFileSync`, not interpolated into a shell command string. Even if env vars are tainted, they cannot be used to escape into shell metacharacters because no shell is involved.

- [ ] **Step 3: `lib/cli/orchestrate.ts`**

```ts
#!/usr/bin/env tsx
import { validateTransition, type StateLabel, type TransitionTrigger } from '../orchestrator';

const FROM = process.env.FROM_STATE as StateLabel | undefined;
const TRIGGER = process.env.TRIGGER as TransitionTrigger | undefined;

function main(): void {
  if (!FROM || !TRIGGER) {
    console.error('usage: FROM_STATE=<label> TRIGGER=<trigger> orchestrate.ts');
    process.exit(2);
  }
  const result = validateTransition(FROM, TRIGGER);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
}

main();
```

- [ ] **Step 4: typecheck**

`npm run typecheck`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add lib/cli/
git commit -m "feat: lib/cli/{render-and-run,drift-check,orchestrate} — tsx-runnable workflow entry points (execFileSync for git)"
```

---

## Task 12: Workflow — `.github/workflows/phase-implement.yml`

**Files:**
- Create: `.github/workflows/phase-implement.yml`

- [ ] **Step 1: Create the workflow** (full YAML below)

```yaml
name: dev-agent · phase-implement

on:
  workflow_call:
    inputs:
      issue_number:
        required: true
        type: number
      config_path:
        required: false
        type: string
        default: '.dev-agent.yml'
      invocation_mode:
        required: false
        type: string
        default: 'stub'
    secrets:
      ANTHROPIC_API_KEY:
        required: false

jobs:
  implement:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }

      - run: npm ci

      - name: Read issue (data only, never expanded into shell)
        env:
          ISSUE_NUMBER: ${{ inputs.issue_number }}
          GH_TOKEN: ${{ github.token }}
        run: gh issue view "$ISSUE_NUMBER" --json number,title,body,labels > issue.json

      - name: Render implementation prompt + invoke (stub mode in 1c)
        env:
          MODEL: claude-sonnet-4-6
          INVOCATION_MODE: ${{ inputs.invocation_mode }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          CONFIG_PATH: ${{ inputs.config_path }}
          ISSUE_NUMBER: ${{ inputs.issue_number }}
        run: |
          set -euo pipefail
          export PROMPT_VARS_JSON=$(jq -nc \
            --arg spec_path "docs/specs/placeholder-1c.md" \
            --arg branch_name "feat/dev-agent-issue-${ISSUE_NUMBER}" \
            --arg test "$(jq -r '.commands.test // "npm test"' "$CONFIG_PATH" 2>/dev/null || echo "npm test")" \
            '{spec_path:$spec_path, branch_name:$branch_name, commands:{test:$test, typecheck:"npm run typecheck", lint:null}, guardrails:{blocked_paths:[], require_explicit_unlock:[], max_files_changed:30, max_lines_changed:800}}')
          npx tsx lib/cli/render-and-run.ts implement > implement-result.json
          jq -c . implement-result.json

      - name: Comment telemetry
        env:
          ISSUE_NUMBER: ${{ inputs.issue_number }}
          GH_TOKEN: ${{ github.token }}
          INVOCATION_MODE: ${{ inputs.invocation_mode }}
        run: |
          set -euo pipefail
          MODEL=$(jq -r '.model' implement-result.json)
          TIN=$(jq -r '.usage.tokens_in' implement-result.json)
          TOUT=$(jq -r '.usage.tokens_out' implement-result.json)
          DOLLARS=$(jq -r '.usage.dollars' implement-result.json)
          BODY=$(printf '🤖 Phase: implement\nModel: %s\nTokens: %s in / %s out\nCost: $%s\nMode: %s\nStatus: stub-success (live mode wires in 1d)\n' "$MODEL" "$TIN" "$TOUT" "$DOLLARS" "$INVOCATION_MODE")
          gh issue comment "$ISSUE_NUMBER" --body "$BODY"
```

Notes:
- All `${{ ... }}` expressions reference workflow inputs (typed `number`/`string`) or `github.token` — no untrusted-input expansion.
- The `gh issue view --json` reads title/body but lands them in `issue.json` consumed by `jq` as data.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/phase-implement.yml
git commit -m "feat: workflow phase-implement (stub mode; live wiring in 1d)"
```

---

## Task 13: Workflows — staging-deploy, promote-to-prod, smoke-verify, rollback, orch-sweep

The remaining 5 workflow files share the same structure. Plan executor: implement each by copying the `phase-implement.yml` skeleton and substituting the distinguishing step.

**Distinguishing steps:**

`phase-staging-deploy.yml` — invoke `staging-deploy` prompt with deploy_skills.staging:
```yaml
      - name: Run staging deploy chain (stub)
        env:
          ISSUE_NUMBER: ${{ inputs.issue_number }}
          MODEL: claude-sonnet-4-6
          INVOCATION_MODE: ${{ inputs.invocation_mode }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          CONFIG_PATH: ${{ inputs.config_path }}
          MERGE_SHA: ${{ github.sha }}
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          export PROMPT_VARS_JSON=$(jq -nc \
            --argjson skills "$(jq -c '.deploy_skills.staging' "$CONFIG_PATH")" \
            --arg staging "$(jq -r '.branches.staging // ""' "$CONFIG_PATH")" \
            --arg test "$(jq -r '.commands.test' "$CONFIG_PATH")" \
            --arg sha "$MERGE_SHA" \
            '{deploy_skills:{staging:$skills}, branches:{staging:($staging // null)}, commands:{test:$test}, merge_sha:$sha}')
          npx tsx lib/cli/render-and-run.ts staging-deploy > result.json
          BODY=$(printf '🤖 Phase: staging-deploy\nModel: %s\nMode: %s\nStatus: stub-success\n' "$(jq -r '.model' result.json)" "$INVOCATION_MODE")
          gh issue comment "$ISSUE_NUMBER" --body "$BODY"
```

`phase-promote-to-prod.yml` — same shape; substitute `staging-deploy` → `promote-to-prod`, `staging` → `prod`, `branches.staging` → `branches.release_target`, comment header.

`phase-smoke-verify.yml` — additionally declares `smoke_phase`, `smoke_output`, `smoke_exit_code` inputs:
```yaml
on:
  workflow_call:
    inputs:
      issue_number:
        required: true
        type: number
      smoke_phase:
        required: true
        type: string
      smoke_output:
        required: true
        type: string
      smoke_exit_code:
        required: true
        type: number
      invocation_mode:
        required: false
        type: string
        default: 'stub'
    secrets:
      ANTHROPIC_API_KEY:
        required: false
```
Step:
```yaml
      - name: Classify smoke output (stub)
        env:
          MODEL: claude-haiku-4-5
          INVOCATION_MODE: ${{ inputs.invocation_mode }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ISSUE_NUMBER: ${{ inputs.issue_number }}
          SMOKE_PHASE: ${{ inputs.smoke_phase }}
          SMOKE_OUTPUT: ${{ inputs.smoke_output }}
          SMOKE_EXIT_CODE: ${{ inputs.smoke_exit_code }}
        run: |
          set -euo pipefail
          export PROMPT_VARS_JSON=$(jq -nc \
            --arg phase "$SMOKE_PHASE" \
            --arg out "$SMOKE_OUTPUT" \
            --argjson code "$SMOKE_EXIT_CODE" \
            --argjson issue "$ISSUE_NUMBER" \
            '{smoke_phase:$phase, smoke_output:$out, smoke_exit_code:$code, issue_number:$issue}')
          npx tsx lib/cli/render-and-run.ts smoke-verify
```
Note: `SMOKE_OUTPUT` is untrusted (it's verbatim test output). It's passed to `jq --arg`, not interpolated into a shell command — `jq --arg` quotes it safely.

`phase-rollback.yml` — finds merge commit via `gh pr view`, then runs rollback prompt:
```yaml
      - name: Identify merge commit
        id: merge
        env:
          ISSUE_NUMBER: ${{ inputs.issue_number }}
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          PR=$(gh issue view "$ISSUE_NUMBER" --json comments | jq -r '.comments[].body' | grep -oE 'PR: #[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
          if [ -z "$PR" ]; then echo "no PR linked from issue" >&2; exit 1; fi
          SHA=$(gh pr view "$PR" --json mergeCommit --jq .mergeCommit.oid)
          echo "pr=$PR" >> "$GITHUB_OUTPUT"
          echo "sha=$SHA" >> "$GITHUB_OUTPUT"

      - name: Render rollback prompt (stub)
        env:
          MODEL: claude-sonnet-4-6
          INVOCATION_MODE: ${{ inputs.invocation_mode }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ISSUE_NUMBER: ${{ inputs.issue_number }}
          PR_NUMBER: ${{ steps.merge.outputs.pr }}
        run: |
          set -euo pipefail
          export PROMPT_VARS_JSON=$(jq -nc \
            --argjson issue "$ISSUE_NUMBER" \
            --argjson pr "$PR_NUMBER" \
            '{issue_number:$issue, merged_pr:$pr, branches:{staging:"staging", release_target:"main"}, deploy_skills:{staging:[],prod:[]}, commands:{test:"npm test"}}')
          npx tsx lib/cli/render-and-run.ts rollback
```

`orch-sweep.yml` — cron polling fallback (no workflow_call; root-level cron):
```yaml
name: dev-agent · orch-sweep

on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch:

jobs:
  sweep:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      issues: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - name: Detect stuck issues
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          CUTOFF=$(node -e "console.log(new Date(Date.now() - 30*60*1000).toISOString())")
          gh issue list --label state:implementing --json number,updatedAt,title \
            | jq -c --arg cutoff "$CUTOFF" '[.[] | select(.updatedAt < $cutoff)] | .[]?' \
            | while read -r issue; do
                NUM=$(echo "$issue" | jq -r .number)
                echo "::warning::dev-agent issue #${NUM} stuck in state:implementing"
              done
```

- [ ] **Step 1: Create all 5 files** per the structures above.

- [ ] **Step 2: Commit (single commit, set ships together)**

```bash
git add .github/workflows/phase-staging-deploy.yml \
        .github/workflows/phase-promote-to-prod.yml \
        .github/workflows/phase-smoke-verify.yml \
        .github/workflows/phase-rollback.yml \
        .github/workflows/orch-sweep.yml
git commit -m "feat: workflows — staging-deploy, promote-to-prod, smoke-verify, rollback, orch-sweep"
```

---

## Task 14: Synthetic test consumer — `examples/test-repo/` package + scripts

**Files:**
- Create: `examples/test-repo/package.json`
- Create: `examples/test-repo/scripts/{mock-test,mock-build,mock-typecheck,mock-deploy-staging,mock-deploy-prod}.sh`
- Create: `examples/test-repo/docs/specs/.gitkeep`
- Create: `examples/test-repo/docs/program-status.md`

- [ ] **Step 1: `examples/test-repo/package.json`**

```json
{
  "name": "test-repo",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "test": "bash scripts/mock-test.sh",
    "build": "bash scripts/mock-build.sh",
    "typecheck": "bash scripts/mock-typecheck.sh",
    "deploy:staging": "bash scripts/mock-deploy-staging.sh",
    "deploy:prod": "bash scripts/mock-deploy-prod.sh"
  }
}
```

- [ ] **Step 2: 5 mock scripts**

Each: `#!/usr/bin/env bash` then a single `echo` line. Make all five executable.

- [ ] **Step 3: `examples/test-repo/docs/program-status.md`**

```markdown
# test-repo program status

This is the status file for the synthetic dev-agent test consumer.
dev-agent appends per-feature sections here at gate transitions.

(empty — no features in flight)
```

- [ ] **Step 4: `.gitkeep` for specs dir**

- [ ] **Step 5: Commit**

```bash
git add examples/test-repo/package.json examples/test-repo/scripts/ examples/test-repo/docs/
git commit -m "feat: examples/test-repo — package.json + 5 mock scripts + docs scaffolding"
```

---

## Task 15: Synthetic test consumer — 6 wrapper workflows

**Files:**
- Create: `examples/test-repo/.github/workflows/dev-agent-{implement,staging-deploy,promote-to-prod,smoke-verify,rollback,orch-sweep}.yml`

Each wrapper is a 5–10 line YAML referencing the parent workflow. Example for `implement`:

```yaml
name: dev-agent · implement

on:
  issues:
    types: [labeled]

jobs:
  implement:
    if: github.event.label.name == 'state:implementing'
    # Production consumers reference the parent repo via:
    #   uses: alizaouane/dev-agent/.github/workflows/phase-implement.yml@v1
    # For in-this-repo testing, we point at the local file:
    uses: ./.github/workflows/phase-implement.yml
    with:
      issue_number: ${{ github.event.issue.number }}
      config_path: examples/test-repo/.dev-agent.yml
      invocation_mode: stub
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

| Wrapper | `if:` condition | Calls |
|---|---|---|
| `dev-agent-implement.yml` | `label.name == 'state:implementing'` | `./.github/workflows/phase-implement.yml` |
| `dev-agent-staging-deploy.yml` | `label.name == 'state:staging-deployed'` | `./.github/workflows/phase-staging-deploy.yml` |
| `dev-agent-promote-to-prod.yml` | `label.name == 'state:promoting'` | `./.github/workflows/phase-promote-to-prod.yml` |
| `dev-agent-smoke-verify.yml` | `workflow_dispatch` only | `./.github/workflows/phase-smoke-verify.yml` |
| `dev-agent-rollback.yml` | `workflow_dispatch` only | `./.github/workflows/phase-rollback.yml` |
| `dev-agent-orch-sweep.yml` | `schedule '*/10 * * * *'` + `workflow_dispatch` | `./.github/workflows/orch-sweep.yml` |

**Important:** Files under `examples/test-repo/.github/workflows/` are NOT activated by GitHub Actions on this repo — Actions only picks up workflows at the *root-level* `.github/workflows/`. They serve as documentation + the consumer-side blueprint. The test below verifies the structural shape.

- [ ] **Step 1: Create all 6 wrappers.**

- [ ] **Step 2: Commit**

```bash
git add examples/test-repo/.github/workflows/
git commit -m "feat: examples/test-repo — 6 thin wrapper workflows"
```

---

## Task 16: Tests for workflow YAML structural validity

**Files:**
- Create: `tests/unit/workflows.test.ts`
- Create: `tests/unit/test-repo-config.test.ts`

- [ ] **Step 1: Write workflows.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const workflowsDir = resolve(__dirname, '../../.github/workflows');

const PHASE_WORKFLOWS = [
  'phase-implement.yml',
  'phase-staging-deploy.yml',
  'phase-promote-to-prod.yml',
  'phase-smoke-verify.yml',
  'phase-rollback.yml',
];

const ALL_REUSABLE = [...PHASE_WORKFLOWS, 'orch-sweep.yml'];

describe('.github/workflows/', () => {
  for (const wf of [...ALL_REUSABLE, 'ci.yml']) {
    describe(wf, () => {
      const path = resolve(workflowsDir, wf);
      const raw = readFileSync(path, 'utf8');
      const parsed = yaml.load(raw) as Record<string, unknown>;

      it('parses as YAML', () => {
        expect(parsed).toBeDefined();
        expect(typeof parsed).toBe('object');
      });

      it('has a name', () => {
        expect(typeof parsed.name).toBe('string');
      });

      it('has at least one job', () => {
        expect(parsed.jobs).toBeDefined();
        expect(Object.keys(parsed.jobs as object).length).toBeGreaterThan(0);
      });
    });
  }

  describe('reusable phase workflows', () => {
    for (const wf of PHASE_WORKFLOWS) {
      it(`${wf} declares workflow_call with issue_number input`, () => {
        const raw = readFileSync(resolve(workflowsDir, wf), 'utf8');
        const parsed = yaml.load(raw) as { on?: { workflow_call?: { inputs?: Record<string, unknown> } } };
        expect(parsed.on?.workflow_call).toBeDefined();
        expect(parsed.on?.workflow_call?.inputs?.issue_number).toBeDefined();
      });
    }
  });

  it('no run: block inlines github.event.* (title|body) directly', () => {
    const forbidden = /\$\{\{\s*github\.event\.[a-z_.]*(title|body)/i;
    for (const wf of [...ALL_REUSABLE, 'ci.yml']) {
      const raw = readFileSync(resolve(workflowsDir, wf), 'utf8');
      const runBlocks = raw.split(/\n\s+run:\s*\|/).slice(1);
      for (const block of runBlocks) {
        const upToNextStep = block.split(/\n\s+- (?:name|uses|run|id):/)[0];
        expect(upToNextStep).not.toMatch(forbidden);
      }
    }
  });
});
```

- [ ] **Step 2: Write test-repo-config.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const repoRoot = resolve(__dirname, '../../examples/test-repo');

describe('examples/test-repo', () => {
  it('.dev-agent.yml exists and parses', () => {
    const path = resolve(repoRoot, '.dev-agent.yml');
    expect(existsSync(path)).toBe(true);
    expect(yaml.load(readFileSync(path, 'utf8'))).toBeDefined();
  });

  it('package.json declares mock scripts', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toMatch(/mock-test/);
    expect(pkg.scripts.build).toMatch(/mock-build/);
    expect(pkg.scripts.typecheck).toMatch(/mock-typecheck/);
  });

  it('all 5 mock scripts exist and are non-empty', () => {
    const scripts = ['mock-test', 'mock-build', 'mock-typecheck', 'mock-deploy-staging', 'mock-deploy-prod'];
    for (const s of scripts) {
      const path = resolve(repoRoot, 'scripts', `${s}.sh`);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(20);
    }
  });

  it('all 6 wrapper workflows exist and reference reusable workflow paths', () => {
    const wrappersDir = resolve(repoRoot, '.github/workflows');
    const wrappers = readdirSync(wrappersDir).filter((f) => f.startsWith('dev-agent-') && f.endsWith('.yml'));
    expect(wrappers).toHaveLength(6);
    for (const w of wrappers) {
      const raw = readFileSync(resolve(wrappersDir, w), 'utf8');
      expect(raw).toMatch(/uses:\s*(\.\/\.github\/workflows\/(phase|orch)-|alizaouane\/dev-agent\/\.github\/workflows\/)/);
    }
  });
});
```

- [ ] **Step 3: Run tests** — all pass.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/workflows.test.ts tests/unit/test-repo-config.test.ts
git commit -m "test: workflow YAML structural validity + test-repo consumer config"
```

---

## Task 17: Verify `examples/test-repo/.dev-agent.yml` deploy_skills

**Files:**
- Possibly modify: `examples/test-repo/.dev-agent.yml`

- [ ] **Step 1: Inspect existing config** for deploy_skills.

- [ ] **Step 2: If `deploy_skills.staging`/`prod` are empty, populate with mock skill names**:
```yaml
deploy_skills:
  staging:
    - mock-deploy-staging
  prod:
    - mock-deploy-prod
```

- [ ] **Step 3: Commit if changed**

```bash
git add examples/test-repo/.dev-agent.yml
git commit -m "chore: examples/test-repo/.dev-agent.yml — wire mock deploy skill names"
```

---

## Task 18: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add Phase 1c subsection** documenting the workflows + `INVOCATION_MODE` env + the synthetic test consumer.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README — Phase 1c workflows + invocation_mode + test consumer"
```

---

## Task 19: Full local verification

- [ ] **Step 1: typecheck** — `npm run typecheck` clean.

- [ ] **Step 2: tests** — `npm test` all pass. Approximate count: 120 + ~25 new = **~145 tests across ~17 files**.

- [ ] **Step 3: workflow YAML lint (manual sanity)**

```bash
for f in .github/workflows/*.yml examples/test-repo/.github/workflows/*.yml; do
  echo "--- $f ---"
  node -e "console.log(require('js-yaml').load(require('fs').readFileSync('$f','utf8')) ? 'ok' : 'fail')"
done
```

Expected: every file says "ok".

---

## Task 20: Open PR, get CI green, merge, tag `v0.1.0-alpha.3`

Same shape as 1a/1b's PR/merge/tag boundary.

- [ ] **Step 1: Push** `feat/phase-1c-workflows` to origin.

- [ ] **Step 2: Open PR** titled `Phase 1c: Reusable workflows + TS helpers + synthetic test consumer`.

- [ ] **Step 3: Wait for CI green**.

- [ ] **Step 4: Merge** (`gh pr merge --merge`).

- [ ] **Step 5: Tag** `v0.1.0-alpha.3` on the merge commit; push tag.

- [ ] **Step 6: Verify** tag listed on GitHub.

---

## Plan 1c self-review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `phase-implement.yml` | Task 12 |
| `phase-staging-deploy.yml` | Task 13 |
| `phase-promote-to-prod.yml` | Task 13 |
| `phase-smoke-verify.yml` | Task 13 |
| `phase-rollback.yml` | Task 13 |
| `orch-sweep.yml` | Task 13 |
| Synthetic test consumer (`examples/test-repo/`) | Tasks 14–17 |
| Helper TS for workflows | Tasks 2–11 |
| Tag `v0.1.0-alpha.3` | Task 20 |

**NOT in 1c (deferred):**
- Live `claude-code-action` / Anthropic SDK wiring → Plan 1d (`anthropic-client.ts` ships with `live` mode throwing a clear `LIVE_MODE_NOT_WIRED_UNTIL_1D` marker)
- 4 of 5 scout adapters as real implementations → Plan 1d
- End-to-end lifecycle drill against the synthetic consumer → Plan 1d
- `v0.1.0` final tag → Plan 1d

**Type-consistency check:** `ScoutSource` (1a's `lib/types.ts`) is consumed by `lib/scout/index.ts`'s switch. `DevAgentConfig` is consumed by `lib/cli/drift-check.ts` via `parseConfig`. Adding a new state to `STATE_LABELS` requires updating one file plus its test.

**Security check:** No `${{ github.event.* (title|body) }}` interpolation in any `run:` block (enforced by `tests/unit/workflows.test.ts`). `lib/cli/drift-check.ts` shells out only via `execFileSync(cmd, [args...])` — no template-string interpolation, so tainted refs cannot inject shell metacharacters.

---

## Acceptance criteria for Plan 1c (must all be green to advance to Plan 1d)

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (~145 unit tests across ~17 files)
- [ ] All 6 reusable workflows parse as valid YAML and declare workflow_call inputs
- [ ] All 6 synthetic-consumer wrappers reference correct parent paths
- [ ] No untrusted-input shell-injection patterns in any workflow (regex-checked)
- [ ] No `execSync` template-string interpolation in TS helpers (manual review)
- [ ] `examples/test-repo/.dev-agent.yml` parses + validates via `parseConfig`
- [ ] All scout stubs emit `STUB_FOR_1D` marker on stderr
- [ ] CI workflow green on `main`
- [ ] Tag `v0.1.0-alpha.3` exists on GitHub
- [ ] Caliente Booking and Qualiency App repos: zero modifications
