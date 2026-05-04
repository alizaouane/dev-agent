import 'server-only';

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

import type { Proposal } from './scout';

/**
 * PM-driven categorization of the proposals queue. The deterministic
 * scouts produce raw findings; this module runs a small LLM pass that
 * groups them by THEME so the user can read the queue as
 * "5 cleanup items, 8 features, 2 tech-debt items" instead of one
 * flat chronological list.
 *
 * Distinct from `/next` — `/next` picks ONE thing to do; this one
 * groups EVERY thing so the user gets the lay of the land.
 *
 * **Cost.** ~$0.005-0.015 per call (claude-haiku-4-5, ~50 proposals).
 * Cached by proposal-set hash for 30 min so reloads are free.
 *
 * **Failure handling.** If the LLM call fails or the response can't
 * be parsed, returns `null` and the page renders un-grouped (same as
 * pre-Phase-2B behavior). Categorization is a UX improvement, not a
 * correctness primitive.
 */

export const PROPOSAL_CATEGORIES = [
  'cleanup',
  'implementation',
  'tech_debt',
  'investigation',
] as const;

export type ProposalCategory = (typeof PROPOSAL_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ProposalCategory, string> = {
  cleanup: 'Cleanup',
  implementation: 'Implementation',
  tech_debt: 'Tech debt',
  investigation: 'Investigation',
};

export const CATEGORY_DESCRIPTIONS: Record<ProposalCategory, string> = {
  cleanup: 'Bug fixes, dead code removal, dangling commitments to close out.',
  implementation: 'Net-new features or specs to build into the product.',
  tech_debt: 'Refactors, migrations, deprecations — pay down past shortcuts.',
  investigation: "Needs research or a decision before action — the user can't just start coding.",
};

const CATEGORY_PROMPT = `You categorize a queue of work proposals into four mutually-exclusive themes so the user can read the list grouped by theme instead of chronologically.

The four categories:
- **cleanup** — bug fixes, dead code, refactors that don't add functionality, dangling commitments (incomplete plan items the team forgot, stale issues, low-severity bug-scout findings)
- **implementation** — net-new features, specs to build, user-facing changes
- **tech_debt** — migrations, deprecations, library upgrades, performance work, abandoned refactors that need finishing
- **investigation** — items where the user can't just start coding — competitor reviews, untriaged issues that need a decision, ambiguous proposals, half-shipped features that need a "ship vs delete" call

Pick exactly one category per proposal. When ambiguous, lean toward the category that captures what the user has to DO:
- An untriaged issue describing a feature request → **investigation** (decide whether to do it), not implementation
- A bug-scout security finding → **cleanup** (fix it), not investigation
- A half-shipped feature → **investigation** if the next step is "decide ship or delete", **tech_debt** if the call has already been made

You receive proposals as a JSON array. Emit a single JSON document on stdout, fenced as \`\`\`json:

\`\`\`json
{
  "categories": [
    { "id": "<proposal id>", "category": "cleanup" | "implementation" | "tech_debt" | "investigation" }
  ]
}
\`\`\`

Every input proposal must appear exactly once in the output. No prose before or after the fenced JSON.`;

/**
 * Public API: classify each proposal into one of four categories. Returns
 * a Map keyed by proposal id. On any failure (LLM error, parse fail,
 * missing IDs), returns `null` so the caller can render un-grouped.
 */
export async function categorizeProposals(
  proposals: Proposal[],
): Promise<Map<string, ProposalCategory> | null> {
  if (proposals.length === 0) return new Map();

  // Strip everything except what the LLM needs — id (for round-tripping)
  // + source (the strongest deterministic signal) + title + 1-line
  // description preview. Saves tokens.
  const compact = proposals.map((p) => ({
    id: p.id,
    source: p.source,
    repo: p.repo,
    title: p.title,
    description: p.description.slice(0, 200),
  }));

  let text: string;
  try {
    const result = await generateText({
      model: anthropic('claude-haiku-4-5'),
      system: CATEGORY_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Categorize these ${proposals.length} proposals:\n\n\`\`\`json\n${JSON.stringify(compact, null, 2)}\n\`\`\``,
        },
      ],
      temperature: 0,
    });
    text = result.text;
  } catch (err) {
    console.warn('categorizeProposals: LLM call failed:', err);
    return null;
  }

  return parseCategorizationResponse(text, proposals);
}

/**
 * Parse the LLM's JSON output into a Map. Tolerates the JSON being
 * fenced (```json ... ```) or bare. Returns null if parsing fails or
 * any proposal id is missing — partial categorization is worse than
 * none because it leaves orphan items in the UI.
 *
 * Exported for unit testing without mocking the LLM call.
 */
export function parseCategorizationResponse(
  text: string,
  proposals: Proposal[],
): Map<string, ProposalCategory> | null {
  // Pull JSON out of fenced code block if present.
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  const jsonText = (fenceMatch ? fenceMatch[1] : text).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { categories?: unknown }).categories)
  ) {
    return null;
  }

  const out = new Map<string, ProposalCategory>();
  const validIds = new Set(proposals.map((p) => p.id));

  for (const entry of (parsed as { categories: unknown[] }).categories) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { id?: unknown; category?: unknown };
    if (typeof e.id !== 'string' || !validIds.has(e.id)) continue;
    if (typeof e.category !== 'string') continue;
    if (!(PROPOSAL_CATEGORIES as readonly string[]).includes(e.category)) continue;
    out.set(e.id, e.category as ProposalCategory);
  }

  // Every proposal must be classified — partial coverage means the UI
  // renders some items twice (once in their category, once in an
  // "uncategorized" bucket) which is worse than not categorizing at all.
  if (out.size !== proposals.length) {
    console.warn(
      `categorizeProposals: parsed ${out.size}/${proposals.length} categories; falling back to un-grouped`,
    );
    return null;
  }

  return out;
}

// ---------- TTL cache ----------

type CacheEntry = { categorization: Map<string, ProposalCategory>; expires: number };

const CATEGORIZATION_CACHE = new Map<string, CacheEntry>();
const CATEGORIZATION_TTL_MS = 30 * 60 * 1000;

/**
 * Build a cache key from the proposal-id set. Same set → same key
 * regardless of order. Keying on `username::ids` would be pointless
 * since categorization is content-only (the LLM doesn't see who's
 * looking).
 */
export function categorizationCacheKey(proposals: Proposal[]): string {
  return [...proposals.map((p) => p.id)].sort().join('|');
}

export function getCachedCategorization(
  key: string,
  now: number = Date.now(),
): Map<string, ProposalCategory> | null {
  const entry = CATEGORIZATION_CACHE.get(key);
  if (!entry) return null;
  if (entry.expires <= now) {
    CATEGORIZATION_CACHE.delete(key);
    return null;
  }
  // Hand back a fresh Map so the caller can't mutate the cache.
  return new Map(entry.categorization);
}

export function setCachedCategorization(
  key: string,
  categorization: Map<string, ProposalCategory>,
  now: number = Date.now(),
): void {
  CATEGORIZATION_CACHE.set(key, {
    categorization: new Map(categorization),
    expires: now + CATEGORIZATION_TTL_MS,
  });
}

/** Test-only reset. Production resets via cold start. */
export function __resetCategorizationCacheForTests(): void {
  CATEGORIZATION_CACHE.clear();
}
