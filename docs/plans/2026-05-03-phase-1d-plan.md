# dev-agent Phase 1d — Live Anthropic Wiring + End-to-End Lifecycle Drill + v0.1.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan is sub-plan 1d of 4 — the final one.** Plans 1a (Foundation, `v0.1.0-alpha.1`), 1b (Plugin Surface, `v0.1.0-alpha.2`), and 1c (Workflows + TS helpers + Test Consumer, `v0.1.0-alpha.3`) are shipped. Plan 1d flips the `LIVE_MODE_NOT_WIRED_UNTIL_1D` markers to real calls, promotes the 3 stubbed scout adapters to real implementations, builds a **drill bridge** workflow so we can dispatch the reusable phase workflows against test issues on this repo (since `examples/test-repo/.github/workflows/` doesn't get picked up at root level), runs the live end-to-end lifecycle drill that exercises every spec acceptance criterion, fixes gaps the drill exposes, and cuts `v0.1.0`.

**Goal:** End state — `lib/anthropic-client.ts` makes real Anthropic API calls in `live` mode (with prompt caching on the system prompt and per-model dollar accounting); 3 real scout adapters replace the `STUB_FOR_1D` shells; a root-level `dev-agent-drill.yml` workflow lets us dispatch any phase workflow with `workflow_dispatch` + an issue number; the spec's 11 acceptance criteria (or whichever subset is verifiable in stub-mode-of-stub mode for synthetic-consumer-only) all pass; `v0.1.0` tagged on the merge commit; the spec's `.claude/plugin.json` typo amended.

**Architecture:** Live invocation reuses the existing `lib/anthropic-client.ts` `live` branch — replaces the throw with a real `client.messages.create()` call wrapping the existing `system` + `user` parameters in the cache-friendly shape (system as a single text block with `cache_control: {type: "ephemeral"}`). Pricing comes from a small per-model rates table (haiku-4-5 / sonnet-4-6 / opus-4-7) and is computed from `response.usage` (uncached + cache_creation × 1.25 + cache_read × 0.1) × input rate + output_tokens × output rate. Scout adapters get real implementations: `vercel_logs` shells out to `vc logs` if available; `supabase_logs` hits the Supabase Management API; `competitive` parses RSS feeds via a tiny RSS parser. The drill bridge is a single root-level workflow with a `phase` input that switches between calling the 5 reusable phase workflows.

**Tech Stack:** Already-installed `@anthropic-ai/sdk` (the deps were added in Plan 1c). Add `fast-xml-parser` for RSS. Existing `@octokit/rest`, `js-yaml`, `vitest`.

---

## Plan series — final status snapshot

| Sub-plan | Goal | Status |
|---|---|---|
| 1a | Foundation: schema/, lib/, sample config, repo CI | ✅ shipped (`v0.1.0-alpha.1`) |
| 1b | Plugin surface: manifest, 8 commands, 4 skills, 7 prompts | ✅ shipped (`v0.1.0-alpha.2`) |
| 1c | Reusable workflows + TS helpers + synthetic test consumer | ✅ shipped (`v0.1.0-alpha.3`) |
| **1d (this plan)** | Live wiring + lifecycle drill + `v0.1.0` | in progress |

---

## Scope discipline

**In 1d:**
- Live Anthropic wiring (replaces `LIVE_MODE_NOT_WIRED_UNTIL_1D` throw; system prompt cache enabled; per-model pricing)
- 3 real scout adapters (`vercel_logs`, `supabase_logs`, `competitive`)
- Drill bridge workflow (`.github/workflows/dev-agent-drill.yml`) to dispatch any phase workflow with workflow_dispatch
- Drill runbook (`docs/runbooks/2026-05-03-phase-1d-drill.md`) — step-by-step what to click + expected outcomes
- Live lifecycle drill: `state:spec-ready` → `/approve` (label flip) → `phase-implement` (live, stub-implementation logic) → telemetry comment → drift-check (synthetic scope-creep test) → `/rollback` (synthetic shipped feature) → `/abandon` (clean cancellation) → cost-cap abort test → guardrail blocked-paths test
- Gap fixes for whatever the drill exposes
- Spec amendment commit fixing `.claude/plugin.json` → `.claude-plugin/plugin.json`
- Tag `v0.1.0`

**Out of scope (Phase 2+):**
- Caliente integration (Phase 2)
- Daily scout cron in production (Phase 3)
- 2nd-Qualiency-project install (Phase 4)
- Open-source release (Phase 5)

---

## Prerequisites (HUMAN STEP — must happen before drill)

**Before running the drill (Tasks 8–11), the user MUST configure these secrets on the `alizaouane/dev-agent` repo:**

```bash
gh secret set ANTHROPIC_API_KEY --repo alizaouane/dev-agent
# paste the API key when prompted
```

**Optional (for scout adapter integration tests, not required for the drill):**

```bash
gh secret set VERCEL_TOKEN --repo alizaouane/dev-agent       # if you want vercel_logs to fetch real data
gh secret set SUPABASE_ACCESS_TOKEN --repo alizaouane/dev-agent  # if you want supabase_logs to fetch real data
```

**Estimated drill spend:** ~$1–3 across all phases (cost caps in `examples/test-repo/.dev-agent.yml` are deliberately tight — `implement: $0.50`, `staging_deploy: $0.10`, etc.). Hard ceiling: $5 across the full drill if all 5 phases run twice (which the cap-abort test triggers).

---

## File structure (Plan 1d)

**Modify:**

| File | Change |
|---|---|
| `lib/anthropic-client.ts` | Replace `LIVE_MODE_NOT_WIRED_UNTIL_1D` throw with real SDK call; add per-model pricing; cache system prompt |
| `lib/scout/vercel-logs.ts` | Real adapter (CLI shellout via `execFileSync`) |
| `lib/scout/supabase-logs.ts` | Real adapter (Supabase Management API via fetch) |
| `lib/scout/competitive.ts` | Real adapter (RSS parsing) |
| `package.json` | Add `fast-xml-parser`; bump version to `0.1.0` |
| `.claude-plugin/plugin.json` | Bump to `0.1.0` |
| `docs/specs/2026-05-02-dev-agent-design.md` | Fix `.claude/plugin.json` → `.claude-plugin/plugin.json` (section A repo layout + Step 0 bootstrap) |
| `README.md` | Drop "Phase 1d shipped at v0.1.0" subsection; document `INVOCATION_MODE=live` |

**Create:**

| File | Responsibility |
|---|---|
| `lib/pricing.ts` | Per-model `{input, output}` rates per million tokens; helper `usageToDollars(model, usage)` |
| `tests/unit/pricing.test.ts` | Validates pricing math (cached vs uncached vs cache-write) |
| `tests/unit/anthropic-client-live.test.ts` | Live-mode tests with mocked SDK (verifies cache_control wiring, usage parsing, dollar math) |
| `tests/unit/scout-vercel-logs.test.ts` | Real-adapter test (mocked execFileSync) |
| `tests/unit/scout-supabase-logs.test.ts` | Real-adapter test (mocked fetch) |
| `tests/unit/scout-competitive.test.ts` | Real-adapter test (RSS fixtures) |
| `tests/fixtures/competitive/sample-feed.xml` | RSS fixture for competitive adapter test |
| `.github/workflows/dev-agent-drill.yml` | workflow_dispatch bridge to call the reusable phase workflows |
| `docs/runbooks/2026-05-03-phase-1d-drill.md` | Step-by-step drill runbook |

---

## Task 1: Per-model pricing (`lib/pricing.ts`)

**Files:**
- Create: `lib/pricing.ts`
- Create: `tests/unit/pricing.test.ts`

Pricing rates from the claude-api skill (verified 2026-04-15):

| Model | Input $/MTok | Output $/MTok |
|---|---:|---:|
| `claude-haiku-4-5` | 1.00 | 5.00 |
| `claude-sonnet-4-6` | 3.00 | 15.00 |
| `claude-opus-4-7` | 5.00 | 25.00 |

Cache reads cost 0.1× input rate; cache writes (5-min TTL) cost 1.25× input rate. Total dollars = `(input_tokens × input_rate + cache_creation_input_tokens × input_rate × 1.25 + cache_read_input_tokens × input_rate × 0.1 + output_tokens × output_rate) / 1_000_000`.

- [ ] **Step 1: Create `lib/pricing.ts`**

```ts
export type ModelRates = { input: number; output: number };

export const PRICING_PER_MTOK: Record<string, ModelRates> = {
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-7': { input: 5.00, output: 25.00 },
};

export type ApiUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export function usageToDollars(model: string, usage: ApiUsage): number {
  const rates = PRICING_PER_MTOK[model] ?? PRICING_PER_MTOK['claude-haiku-4-5'];
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputCost =
    usage.input_tokens * rates.input +
    cacheWrite * rates.input * 1.25 +
    cacheRead * rates.input * 0.1;
  const outputCost = usage.output_tokens * rates.output;
  return (inputCost + outputCost) / 1_000_000;
}
```

- [ ] **Step 2: Test the math**

```ts
import { describe, it, expect } from 'vitest';
import { usageToDollars, PRICING_PER_MTOK } from '../../lib/pricing';

describe('usageToDollars', () => {
  it('computes uncached input + output for haiku', () => {
    const d = usageToDollars('claude-haiku-4-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(d).toBeCloseTo(1 + 5, 6);
  });

  it('charges 0.1x for cache reads', () => {
    const d = usageToDollars('claude-haiku-4-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    expect(d).toBeCloseTo(0.1, 6);
  });

  it('charges 1.25x for cache writes (5-min TTL)', () => {
    const d = usageToDollars('claude-haiku-4-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(d).toBeCloseTo(1.25, 6);
  });

  it('falls back to haiku rates for unknown model', () => {
    const d = usageToDollars('nonexistent-model', {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(d).toBeCloseTo(1.00, 6);
  });

  it('exports pricing for all 3 spec models', () => {
    expect(PRICING_PER_MTOK['claude-haiku-4-5']).toBeDefined();
    expect(PRICING_PER_MTOK['claude-sonnet-4-6']).toBeDefined();
    expect(PRICING_PER_MTOK['claude-opus-4-7']).toBeDefined();
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- tests/unit/pricing.test.ts
git add lib/pricing.ts tests/unit/pricing.test.ts
git commit -m "feat: lib/pricing — per-model rates + usageToDollars helper"
```

---

## Task 2: Live Anthropic wiring (`lib/anthropic-client.ts`)

**Files:**
- Modify: `lib/anthropic-client.ts`
- Create: `tests/unit/anthropic-client-live.test.ts`

Replace the `live` branch's throw with a real SDK call. The system prompt is wrapped in a single-element array with `cache_control: {type: "ephemeral"}` so it caches across phase invocations (the same `prompts/implement.md` rendered text is reused for every implement-phase call).

**Best practices applied (per claude-api skill):**
- System prompt cached via `cache_control: {type: "ephemeral"}` on the only system block.
- Cache reads/writes accounted for in `usageToDollars`.
- Type-narrow `block.type === 'text'` before reading `block.text`.
- Use `Anthropic.RateLimitError` / `Anthropic.APIError` typed exceptions, not string-matching.
- No streaming for 1d (max_tokens default 16K stays under SDK HTTP timeout). 1e+ can add streaming for prompt-caching-friendly long outputs.

- [ ] **Step 1: Modify `lib/anthropic-client.ts`**

Replace the existing `live` throw with:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { usageToDollars } from './pricing';

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

async function liveInvoke(args: InvokeArgs): Promise<InvokeResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY required for live invocation mode');
  }
  const client = new Anthropic();
  const userText = args.user.length > 0 ? args.user : '(continue)';
  const response = await client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens ?? 16000,
    system: [
      { type: 'text', text: args.system, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userText }],
  });

  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }

  const u = response.usage;
  const tokens_in =
    u.input_tokens +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  const tokens_out = u.output_tokens;

  return {
    text,
    usage: {
      tokens_in,
      tokens_out,
      dollars: usageToDollars(args.model, u),
    },
    model: response.model ?? args.model,
  };
}

export async function invokeAnthropic(args: InvokeArgs): Promise<InvokeResult> {
  const mode = resolveMode(args.mode);
  if (mode === 'stub') return deterministicStub(args);
  return liveInvoke(args);
}
```

- [ ] **Step 2: Live-mode test (mocked SDK)**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn(() => ({ messages: { create: mockCreate } })),
  };
});

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

describe('anthropic-client live mode', () => {
  it('calls the SDK with cache_control on the system block', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'live response' }],
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      model: 'claude-haiku-4-5',
    });
    const { invokeAnthropic } = await import('../../lib/anthropic-client');
    const r = await invokeAnthropic({
      mode: 'live',
      model: 'claude-haiku-4-5',
      system: 'sys',
      user: 'u',
    });
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    expect(r.text).toBe('live response');
    expect(r.usage.tokens_in).toBe(100);
    expect(r.usage.tokens_out).toBe(50);
  });

  it('counts cache_read_input_tokens in tokens_in', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'cached' }],
      usage: { input_tokens: 50, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 },
      model: 'claude-haiku-4-5',
    });
    const { invokeAnthropic } = await import('../../lib/anthropic-client');
    const r = await invokeAnthropic({ mode: 'live', model: 'claude-haiku-4-5', system: 's', user: 'u' });
    expect(r.usage.tokens_in).toBe(250);
  });

  it('throws clearly without API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { invokeAnthropic } = await import('../../lib/anthropic-client');
    await expect(invokeAnthropic({ mode: 'live', model: 'claude-haiku-4-5', system: 's', user: 'u' })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('uses (continue) for empty user input', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'k' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-haiku-4-5',
    });
    const { invokeAnthropic } = await import('../../lib/anthropic-client');
    await invokeAnthropic({ mode: 'live', model: 'claude-haiku-4-5', system: 's', user: '' });
    expect(mockCreate.mock.calls[0][0].messages[0].content).toBe('(continue)');
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- tests/unit/anthropic-client-live.test.ts tests/unit/anthropic-client.test.ts
git add lib/anthropic-client.ts tests/unit/anthropic-client-live.test.ts
git commit -m "feat: lib/anthropic-client — wire live SDK call with prompt caching"
```

---

## Task 3: Real `vercel_logs` adapter

**Files:**
- Modify: `lib/scout/vercel-logs.ts`
- Create: `tests/unit/scout-vercel-logs.test.ts`

The adapter shells out to the `vc` (Vercel) CLI if `VERCEL_TOKEN` is set and `vc` is on PATH, parses recent error log lines, and returns one candidate per distinct error pattern. If either prerequisite is missing, it emits a clear "skipped: vercel CLI/token not configured" message on stderr and returns `[]` (graceful degradation, not failure).

- [ ] **Step 1: Implement the adapter**

```ts
import { execFileSync } from 'node:child_process';
import type { Candidate } from './types';

type Config = { kind: 'vercel_logs'; project: string };

export async function vercelLogsAdapter(config: Config): Promise<Candidate[]> {
  if (!process.env.VERCEL_TOKEN) {
    process.stderr.write('vercel_logs: VERCEL_TOKEN not set, skipping\n');
    return [];
  }
  let output: string;
  try {
    output = execFileSync(
      'vc',
      ['logs', config.project, '--since=24h', '--output=json', '--token', process.env.VERCEL_TOKEN],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    process.stderr.write(`vercel_logs: vc CLI unavailable or failed (${err instanceof Error ? err.message : String(err)}), skipping\n`);
    return [];
  }
  const lines = output.split('\n').filter((l) => l.trim().startsWith('{'));
  const errorBuckets = new Map<string, { count: number; sample: string }>();
  for (const line of lines) {
    let parsed: { level?: string; message?: string; requestPath?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.level !== 'error' || !parsed.message) continue;
    const key = (parsed.requestPath ?? 'no-path') + ':' + parsed.message.slice(0, 80);
    const cur = errorBuckets.get(key) ?? { count: 0, sample: parsed.message };
    cur.count += 1;
    errorBuckets.set(key, cur);
  }
  return [...errorBuckets.entries()].map(([key, { count, sample }]) => ({
    source: 'vercel_logs' as const,
    title: `prod error (${count}×): ${sample.slice(0, 80)}`,
    body: `Path: ${key.split(':')[0]}\nSample: ${sample}\nOccurrences: ${count} in last 24h`,
    evidence_url: null,
    severity_hint: count >= 10 ? 'high' : count >= 3 ? 'medium' : 'low',
    novelty_score: Math.min(0.9, 0.4 + count * 0.05),
  }));
}
```

- [ ] **Step 2: Test (mocked `execFileSync`)**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const ORIG_TOKEN = process.env.VERCEL_TOKEN;

beforeEach(() => {
  vi.resetModules();
  process.env.VERCEL_TOKEN = 'fake';
});

afterEach(() => {
  if (ORIG_TOKEN === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = ORIG_TOKEN;
});

describe('vercelLogsAdapter', () => {
  it('returns empty when VERCEL_TOKEN is unset', async () => {
    delete process.env.VERCEL_TOKEN;
    const { vercelLogsAdapter } = await import('../../lib/scout/vercel-logs');
    expect(await vercelLogsAdapter({ kind: 'vercel_logs', project: 'p' })).toEqual([]);
  });

  it('groups errors by path+message', async () => {
    const { execFileSync } = await import('node:child_process');
    (execFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      JSON.stringify({ level: 'error', message: 'TypeError: x is undefined', requestPath: '/api/foo' }),
      JSON.stringify({ level: 'error', message: 'TypeError: x is undefined', requestPath: '/api/foo' }),
      JSON.stringify({ level: 'error', message: 'OOM', requestPath: '/api/bar' }),
      JSON.stringify({ level: 'info', message: 'noise' }),
    ].join('\n'));
    const { vercelLogsAdapter } = await import('../../lib/scout/vercel-logs');
    const candidates = await vercelLogsAdapter({ kind: 'vercel_logs', project: 'p' });
    expect(candidates).toHaveLength(2);
    expect(candidates.find((c) => c.title.includes('TypeError'))?.title).toContain('2×');
  });

  it('returns empty + warning when vc CLI fails', async () => {
    const { execFileSync } = await import('node:child_process');
    (execFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('not found'); });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { vercelLogsAdapter } = await import('../../lib/scout/vercel-logs');
    const candidates = await vercelLogsAdapter({ kind: 'vercel_logs', project: 'p' });
    expect(candidates).toEqual([]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('skipping'));
    stderrSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- tests/unit/scout-vercel-logs.test.ts
git add lib/scout/vercel-logs.ts tests/unit/scout-vercel-logs.test.ts
git commit -m "feat: lib/scout/vercel-logs — real adapter (vc CLI shellout, graceful degrade)"
```

---

## Task 4: Real `supabase_logs` adapter

**Files:**
- Modify: `lib/scout/supabase-logs.ts`
- Create: `tests/unit/scout-supabase-logs.test.ts`

Hits the Supabase Management API (`https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all`) using `SUPABASE_ACCESS_TOKEN`. Same graceful-degrade pattern as `vercel_logs`.

- [ ] **Step 1: Implement**

```ts
import type { Candidate } from './types';

type Config = { kind: 'supabase_logs'; project_ids: string[] };

type LogRow = {
  level?: string;
  event_message?: string;
  metadata?: { request?: { path?: string } };
};

export async function supabaseLogsAdapter(config: Config): Promise<Candidate[]> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    process.stderr.write('supabase_logs: SUPABASE_ACCESS_TOKEN not set, skipping\n');
    return [];
  }
  const out: Candidate[] = [];
  for (const ref of config.project_ids) {
    try {
      const url = `https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs.all?sql=${encodeURIComponent(
        "SELECT level, event_message FROM api_logs WHERE level IN ('error','crit') AND timestamp > now() - INTERVAL '24 hours' LIMIT 100",
      )}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        process.stderr.write(`supabase_logs: ${ref} HTTP ${resp.status}, skipping\n`);
        continue;
      }
      const body = (await resp.json()) as { result?: LogRow[] };
      const buckets = new Map<string, number>();
      for (const row of body.result ?? []) {
        const key = row.event_message?.slice(0, 80) ?? 'unknown';
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      for (const [msg, count] of buckets) {
        out.push({
          source: 'supabase_logs',
          title: `supabase error (${count}×): ${msg}`,
          body: `Project: ${ref}\nMessage: ${msg}\nOccurrences: ${count} in last 24h`,
          evidence_url: `https://supabase.com/dashboard/project/${ref}/logs/explorer`,
          severity_hint: count >= 10 ? 'high' : count >= 3 ? 'medium' : 'low',
          novelty_score: 0.6,
        });
      }
    } catch (err) {
      process.stderr.write(`supabase_logs: ${ref} fetch failed (${err instanceof Error ? err.message : String(err)}), skipping\n`);
    }
  }
  return out;
}
```

- [ ] **Step 2: Test (mocked fetch)**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIG_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  process.env.SUPABASE_ACCESS_TOKEN = 'fake';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIG_TOKEN === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
  else process.env.SUPABASE_ACCESS_TOKEN = ORIG_TOKEN;
});

describe('supabaseLogsAdapter', () => {
  it('returns empty when token unset', async () => {
    delete process.env.SUPABASE_ACCESS_TOKEN;
    const { supabaseLogsAdapter } = await import('../../lib/scout/supabase-logs');
    expect(await supabaseLogsAdapter({ kind: 'supabase_logs', project_ids: ['p'] })).toEqual([]);
  });

  it('parses error rows and groups by message', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          { level: 'error', event_message: 'pg: connection refused' },
          { level: 'error', event_message: 'pg: connection refused' },
          { level: 'crit', event_message: 'OOM in function' },
        ],
      }),
    });
    const { supabaseLogsAdapter } = await import('../../lib/scout/supabase-logs');
    const candidates = await supabaseLogsAdapter({ kind: 'supabase_logs', project_ids: ['proj1'] });
    expect(candidates).toHaveLength(2);
    expect(candidates.find((c) => c.title.includes('connection refused'))?.title).toContain('2×');
  });

  it('skips a project on HTTP error but continues others', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: [{ level: 'error', event_message: 'oops' }] }) });
    const { supabaseLogsAdapter } = await import('../../lib/scout/supabase-logs');
    const candidates = await supabaseLogsAdapter({ kind: 'supabase_logs', project_ids: ['bad', 'good'] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toContain('oops');
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- tests/unit/scout-supabase-logs.test.ts
git add lib/scout/supabase-logs.ts tests/unit/scout-supabase-logs.test.ts
git commit -m "feat: lib/scout/supabase-logs — real adapter (Management API, graceful degrade)"
```

---

## Task 5: Real `competitive` adapter (RSS)

**Files:**
- Modify: `lib/scout/competitive.ts`
- Create: `tests/unit/scout-competitive.test.ts`
- Create: `tests/fixtures/competitive/sample-feed.xml`
- Modify: `package.json` (add `fast-xml-parser`)

- [ ] **Step 1: Add `fast-xml-parser` dep**

```bash
npm install fast-xml-parser
```

- [ ] **Step 2: Implement**

```ts
import { XMLParser } from 'fast-xml-parser';
import type { Candidate } from './types';

type Config = { kind: 'competitive'; feeds: string[] };

type RssItem = { title?: string; link?: string; description?: string; pubDate?: string };
type RssChannel = { item?: RssItem | RssItem[] };
type RssRoot = { rss?: { channel?: RssChannel }; feed?: { entry?: unknown } };

export async function competitiveAdapter(config: Config): Promise<Candidate[]> {
  if (config.feeds.length === 0) return [];
  const parser = new XMLParser({ ignoreAttributes: false });
  const out: Candidate[] = [];
  for (const url of config.feeds) {
    let xml: string;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        process.stderr.write(`competitive: ${url} HTTP ${resp.status}, skipping\n`);
        continue;
      }
      xml = await resp.text();
    } catch (err) {
      process.stderr.write(`competitive: ${url} fetch failed (${err instanceof Error ? err.message : String(err)}), skipping\n`);
      continue;
    }
    let parsed: RssRoot;
    try {
      parsed = parser.parse(xml) as RssRoot;
    } catch (err) {
      process.stderr.write(`competitive: ${url} parse failed, skipping\n`);
      continue;
    }
    const items = parsed.rss?.channel?.item ?? [];
    const list = Array.isArray(items) ? items : [items];
    for (const item of list.slice(0, 20)) {
      if (!item.title) continue;
      out.push({
        source: 'competitive',
        title: `competitor signal: ${item.title.slice(0, 80)}`,
        body: `From: ${url}\n${item.description?.slice(0, 200) ?? ''}\nPublished: ${item.pubDate ?? 'unknown'}`,
        evidence_url: item.link ?? null,
        severity_hint: 'low',
        novelty_score: 0.5,
      });
    }
  }
  return out;
}
```

- [ ] **Step 3: Fixture + test**

`tests/fixtures/competitive/sample-feed.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Acme Blog</title>
    <item>
      <title>Acme launches AI Agent v2</title>
      <link>https://acme.example.com/posts/agent-v2</link>
      <description>New scheduling features.</description>
      <pubDate>Mon, 03 May 2026 09:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Acme adds OAuth flow</title>
      <link>https://acme.example.com/posts/oauth</link>
      <description>Sign in with Google.</description>
      <pubDate>Sun, 02 May 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
```

Test:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sampleFeed = readFileSync(resolve(__dirname, '../fixtures/competitive/sample-feed.xml'), 'utf8');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

describe('competitiveAdapter', () => {
  it('returns empty for empty feed list', async () => {
    const { competitiveAdapter } = await import('../../lib/scout/competitive');
    expect(await competitiveAdapter({ kind: 'competitive', feeds: [] })).toEqual([]);
  });

  it('parses RSS items into candidates', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => sampleFeed,
    });
    const { competitiveAdapter } = await import('../../lib/scout/competitive');
    const candidates = await competitiveAdapter({ kind: 'competitive', feeds: ['https://acme.example.com/feed'] });
    expect(candidates).toHaveLength(2);
    expect(candidates[0].title).toContain('AI Agent v2');
    expect(candidates[0].evidence_url).toBe('https://acme.example.com/posts/agent-v2');
  });

  it('skips a feed on HTTP error but continues others', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, text: async () => sampleFeed });
    const { competitiveAdapter } = await import('../../lib/scout/competitive');
    const candidates = await competitiveAdapter({ kind: 'competitive', feeds: ['bad', 'good'] });
    expect(candidates.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
npm test -- tests/unit/scout-competitive.test.ts
git add lib/scout/competitive.ts tests/unit/scout-competitive.test.ts tests/fixtures/competitive/ package.json package-lock.json
git commit -m "feat: lib/scout/competitive — real adapter (RSS via fast-xml-parser)"
```

---

## Task 6: Drill bridge workflow

**Files:**
- Create: `.github/workflows/dev-agent-drill.yml`

Bridges `workflow_dispatch` (which we can fire from CLI / GitHub UI) to the reusable `phase-*.yml` workflows. Without this, we'd need to push new wrapper files into `examples/test-repo/.github/workflows/` AND have GitHub Actions actually pick them up at root level — which it doesn't, because subdirectory workflows are ignored.

- [ ] **Step 1: Create the workflow**

```yaml
name: dev-agent · drill

on:
  workflow_dispatch:
    inputs:
      phase:
        description: 'Phase to dispatch'
        required: true
        type: choice
        options:
          - implement
          - staging-deploy
          - promote-to-prod
          - rollback
          - smoke-verify
      issue_number:
        description: 'Issue number to operate on'
        required: true
        type: number
      invocation_mode:
        description: 'stub or live'
        required: false
        type: string
        default: 'live'
      smoke_phase:
        description: '(smoke-verify only) staging or prod'
        required: false
        type: string
        default: 'staging'
      smoke_output:
        description: '(smoke-verify only) captured smoke output'
        required: false
        type: string
        default: 'MOCK: tests pass'
      smoke_exit_code:
        description: '(smoke-verify only) smoke exit code'
        required: false
        type: number
        default: 0

jobs:
  implement:
    if: inputs.phase == 'implement'
    uses: ./.github/workflows/phase-implement.yml
    with:
      issue_number: ${{ inputs.issue_number }}
      config_path: examples/test-repo/.dev-agent.yml
      invocation_mode: ${{ inputs.invocation_mode }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

  staging-deploy:
    if: inputs.phase == 'staging-deploy'
    uses: ./.github/workflows/phase-staging-deploy.yml
    with:
      issue_number: ${{ inputs.issue_number }}
      config_path: examples/test-repo/.dev-agent.yml
      invocation_mode: ${{ inputs.invocation_mode }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

  promote-to-prod:
    if: inputs.phase == 'promote-to-prod'
    uses: ./.github/workflows/phase-promote-to-prod.yml
    with:
      issue_number: ${{ inputs.issue_number }}
      config_path: examples/test-repo/.dev-agent.yml
      invocation_mode: ${{ inputs.invocation_mode }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

  rollback:
    if: inputs.phase == 'rollback'
    uses: ./.github/workflows/phase-rollback.yml
    with:
      issue_number: ${{ inputs.issue_number }}
      config_path: examples/test-repo/.dev-agent.yml
      invocation_mode: ${{ inputs.invocation_mode }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

  smoke-verify:
    if: inputs.phase == 'smoke-verify'
    uses: ./.github/workflows/phase-smoke-verify.yml
    with:
      issue_number: ${{ inputs.issue_number }}
      smoke_phase: ${{ inputs.smoke_phase }}
      smoke_output: ${{ inputs.smoke_output }}
      smoke_exit_code: ${{ inputs.smoke_exit_code }}
      invocation_mode: ${{ inputs.invocation_mode }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/dev-agent-drill.yml
git commit -m "feat: workflow dev-agent-drill — bridge for dispatching phase workflows in 1d drill"
```

---

## Task 7: Drill runbook

**Files:**
- Create: `docs/runbooks/2026-05-03-phase-1d-drill.md`

Step-by-step drill instructions. The drill is a sequence of `gh` CLI commands operated by a human (the user, or the agent acting on the user's behalf). Each step lists expected outcomes; failures land as gap-fix tasks.

- [ ] **Step 1: Author the runbook**

```markdown
# Phase 1d Lifecycle Drill

**Goal:** Exercise every spec acceptance criterion against the synthetic consumer end-to-end with live model invocation. Findings → gap-fix tasks → `v0.1.0` tag.

**Prereqs:**
- `ANTHROPIC_API_KEY` configured as a repo secret on `alizaouane/dev-agent`
- Working tree on `feat/phase-1d-live-and-drill` branch with the live wiring + drill bridge merged

## Drill scenarios

### Scenario A: Happy-path implement (live)

1. Create a test issue:
   ```bash
   gh issue create --repo alizaouane/dev-agent --title "drill: A1 happy-path implement" --body "Synthetic feature for drill A1." --label "kind:user-intent,state:spec-ready"
   # Note the issue number returned; call it $A1
   ```
2. Dispatch phase-implement via the drill bridge (live mode):
   ```bash
   gh workflow run dev-agent-drill.yml --repo alizaouane/dev-agent -f phase=implement -f issue_number=$A1 -f invocation_mode=live
   ```
3. Watch the run:
   ```bash
   gh run watch --repo alizaouane/dev-agent
   ```
4. Verify:
   - [ ] Run completes with conclusion: success
   - [ ] Issue $A1 has a comment starting with "🤖 Phase: implement" containing model + token + cost fields
   - [ ] Cost field shows a non-zero dollar value (proves live mode hit the API)
   - [ ] No drift-check violations (synthetic stub mode)

**Expected spend:** ~$0.05–0.20 depending on prompt size.

### Scenario B: Cost-cap abort

1. Create a test issue with the existing labels.
2. Temporarily edit `examples/test-repo/.dev-agent.yml` to set `cost_caps.implement.dollars: 0.001` (commit on a side branch — don't merge).
3. Dispatch phase-implement; expect the workflow to **fail** with cost-cap exceeded message.
4. Revert the edit; verify workflow runs green again.

**Expected outcome:** workflow fails fast, no telemetry comment posted, no PR opened.

### Scenario C: Guardrail blocked-paths

1. The synthetic consumer's `.dev-agent.yml` has `guardrails.blocked_paths: [secrets/**]`.
2. Create an issue, dispatch implement.
3. (1d limitation) The stub-mode implementation logic doesn't yet write files; this scenario validates only that the guardrail config is parsed and surfaced in the prompt. **A real-write test belongs in 2a or later** — note as known limitation.

### Scenario D: Drift-check synthetic scope-creep

1. Create a spec file at `examples/test-repo/docs/specs/drill-d.md` with a "Critical files" section listing only `src/foo.ts`.
2. On a side branch, modify `src/foo.ts` AND `src/bar.ts` (out of scope).
3. Manually run `lib/cli/drift-check.ts` with `SPEC_PATH=examples/test-repo/docs/specs/drill-d.md BASE_REF=main HEAD_REF=<side branch>`.
4. Verify: stdout JSON has `verdict: scope_creep` and exit code 1.

### Scenario E: /abandon cleanup

1. Pick any open drill issue.
2. Manually apply `state:abandoned` label, remove all other `state:*`.
3. Verify: issue closes; existing audit trail preserved.

This is a manual verification of the slash command's documented behavior; the actual `/abandon` command shipped in 1b is a markdown spec, not yet a runnable CLI in 1d.

### Scenario F: Rollback (stub-only in 1d)

1. Create a stand-in "shipped feature" issue with a synthetic linked PR comment ("PR: #999").
2. Dispatch phase-rollback via the drill bridge.
3. Verify: workflow attempts to find the merge commit (will fail since #999 is fake), exits with a clear error message about missing PR.

A real rollback against a real merged PR is exercised in Phase 2 (Caliente).

## Findings log

After running the drill, append findings here as bullet points. Each finding becomes a gap-fix commit before tagging `v0.1.0`.

- (none yet)
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/2026-05-03-phase-1d-drill.md
git commit -m "docs: Phase 1d lifecycle drill runbook"
```

---

## Task 8: Pause for ANTHROPIC_API_KEY secret configuration

**Required HUMAN action before continuing:**

```bash
gh secret set ANTHROPIC_API_KEY --repo alizaouane/dev-agent
# paste the API key when prompted
```

After the secret is set, resume with Task 9.

---

## Task 9: Run the drill scenarios A–F

For each scenario in the runbook, execute the steps and record findings.

- [ ] Scenario A: Happy-path implement (live)
- [ ] Scenario B: Cost-cap abort
- [ ] Scenario C: Guardrail blocked-paths (1d limitation noted)
- [ ] Scenario D: Drift-check synthetic scope-creep
- [ ] Scenario E: /abandon cleanup
- [ ] Scenario F: Rollback (synthetic)

Append findings to `docs/runbooks/2026-05-03-phase-1d-drill.md` under the "Findings log" section.

---

## Task 10: Ship gap fixes from drill findings

For each finding that surfaces during the drill, create a fix commit. Aim to keep each commit small and atomic. Common likely findings:

- Workflow `jq` command edge cases (empty arrays, missing fields)
- Token counting mismatches in stub vs live
- Missing labels from `gh label create` (the spec assumes labels exist; first drill run will need them)
- Path resolution issues in CLI scripts when run from a different cwd

For label creation specifically, run once before Scenario A:

```bash
# Create canonical label vocabulary on the repo (run once)
for state in proposed scoping spec-ready implementing pr-review staging-deployed ready-to-promote promoting done blocked abandoned rolled-back; do
  gh label create "state:$state" --repo alizaouane/dev-agent --color BFD4F2 --force
done
for kind in user-intent scout-proposal scout-digest hotfix; do
  gh label create "kind:$kind" --repo alizaouane/dev-agent --color D4C5F9 --force
done
for prio in p0 p1 p2 p3; do
  gh label create "priority:$prio" --repo alizaouane/dev-agent --color FBCA04 --force
done
```

---

## Task 11: Spec amendment + version bump

**Files:**
- Modify: `docs/specs/2026-05-02-dev-agent-design.md` (fix `.claude/plugin.json` → `.claude-plugin/plugin.json`)
- Modify: `package.json` (version → `0.1.0`)
- Modify: `.claude-plugin/plugin.json` (version → `0.1.0`)
- Modify: `README.md` (add "Phase 1d shipped at v0.1.0" subsection)

- [ ] **Step 1: Amend the spec**

In `docs/specs/2026-05-02-dev-agent-design.md`, replace `.claude/plugin.json` with `.claude-plugin/plugin.json` in two places:
- Section A repo layout tree (around line 254–255)
- Section: "Plugin manifest (`.claude/plugin.json`)" → "(`.claude-plugin/plugin.json`)" (around line 514)

- [ ] **Step 2: Bump versions**

`package.json`: `"version": "0.1.0"`
`.claude-plugin/plugin.json`: `"version": "0.1.0"`

- [ ] **Step 3: Update README**

Replace the Phase 1c section's "shipped at v0.1.0-alpha.3" with:

```markdown
## Phase 1d — live wiring + lifecycle drill (status: shipped at v0.1.0)

Anthropic SDK calls are now wired live: `lib/anthropic-client.ts` makes real `messages.create()` calls when `INVOCATION_MODE=live`, with prompt caching enabled on the system prompt and per-model dollar accounting. The 3 stubbed scout adapters (`vercel_logs`, `supabase_logs`, `competitive`) ship as real implementations that gracefully degrade when API tokens are unset.

To run a workflow in live mode:

```yaml
with:
  invocation_mode: live
secrets:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The Phase 1d drill (see `docs/runbooks/2026-05-03-phase-1d-drill.md`) exercised every spec acceptance criterion against the synthetic test consumer.

`v0.1.0` is the first stable release. Consumer repos can now reference reusable workflows by tag: `uses: alizaouane/dev-agent/.github/workflows/phase-implement.yml@v1`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-05-02-dev-agent-design.md package.json .claude-plugin/plugin.json README.md
git commit -m "chore: bump 0.1.0 + spec amendment (.claude-plugin path) + README v0.1.0 section"
```

---

## Task 12: Open PR, get CI green, merge, tag `v0.1.0`

- [ ] **Step 1: Push** `feat/phase-1d-live-and-drill` to origin.

- [ ] **Step 2: Open PR** titled `Phase 1d: Live Anthropic + lifecycle drill + v0.1.0`.

- [ ] **Step 3: Wait for CI green** on the PR.

- [ ] **Step 4: Merge** (`gh pr merge --merge`).

- [ ] **Step 5: Tag** `v0.1.0` on the merge commit; push tag. Also create the major-line floating tag `v1` (consumers reference `@v1` in their `uses:` declarations).

```bash
git checkout main && git pull --ff-only origin main
git tag -a v0.1.0 -m "Phase 1: Foundation through live wiring — first stable release"
git push origin v0.1.0
git tag -f v1 v0.1.0
git push -f origin v1
```

- [ ] **Step 6: Verify** both tags listed on GitHub.

---

## Acceptance criteria for Plan 1d (must all be green to ship `v0.1.0`)

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (~165 unit tests across 24 files; +20 from 1c)
- [ ] Live SDK call wires up (mocked-SDK tests verify cache_control, usage parsing, dollar math)
- [ ] All 3 scout stubs are now real adapters with mocked-network tests
- [ ] Drill scenarios A, B, D, E, F pass; C limitation documented
- [ ] All drill findings either fixed or logged as known issues
- [ ] CI workflow green on `main`
- [ ] Tag `v0.1.0` exists on GitHub
- [ ] Tag `v1` floating tag exists (points at v0.1.0)
- [ ] Caliente Booking and Qualiency App repos: zero modifications (verified via `git -C <path> status`)
- [ ] Spec amendment commit applied (`.claude-plugin/plugin.json` path corrected)
