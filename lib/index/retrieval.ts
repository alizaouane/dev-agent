/**
 * Pillar 3 — retrieval over chunked source files, v1 (text-only).
 *
 * Two-stage scoring per the plan ("vector top-50 → LLM rerank → top-10")
 * adapted to v1's no-embeddings posture:
 *
 *   Stage 1 (this module): lexical pre-filter — token-overlap +
 *     symbol-name match scoring. Returns top-K candidates.
 *   Stage 2 (v1.1, deferred): embedding-cosine + LLM rerank. Plug-in
 *     point is the `score` function below — replace it without
 *     touching the chunker or the retriever's public shape.
 *
 * No external dependencies. Suitable for repos up to ~50k LOC; beyond
 * that the lexical pre-filter starts losing precision and you should
 * pull in v1.1's embeddings.
 */

import type { Chunk } from './chunker';

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
  reasons: string[];
}

export interface RetrievalOptions {
  /** Maximum number of chunks to return. Default: 10. */
  topK?: number;
  /** Minimum score for a chunk to be kept. Default: 0.05. */
  minScore?: number;
  /** Boost factor for matches in the chunk's `name` field. Default: 5. */
  nameBoost?: number;
}

/** Tokenize a string into lowercase alphanumeric tokens (length ≥ 2). */
export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
}

/** Split a camelCase / snake_case identifier into sub-tokens. */
function splitIdentifier(s: string): string[] {
  // foo_bar_baz → [foo, bar, baz]; FooBarBaz → [foo, bar, baz]; fooBar → [foo, bar].
  return s
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}

/**
 * Score a single chunk against the query tokens. Higher is better.
 *
 *   - Each query token that appears in the chunk's content adds 1.
 *   - Each query token that appears in the chunk's *name* adds
 *     `nameBoost` (default 5).
 *   - Identifier sub-token matches against `name` add 2 each.
 *   - Score is normalized by the number of query tokens so longer
 *     queries don't dominate.
 *
 * Returns the score plus a list of human-readable reasons (used by the
 * `--explain` CLI flag).
 */
export function scoreChunk(
  chunk: Chunk,
  queryTokens: string[],
  opts: RetrievalOptions = {},
): { score: number; reasons: string[] } {
  if (queryTokens.length === 0) return { score: 0, reasons: [] };
  const nameBoost = opts.nameBoost ?? 5;
  const reasons: string[] = [];
  let raw = 0;

  const contentLower = chunk.content.toLowerCase();
  const nameLower = chunk.name.toLowerCase();
  const nameSubtokens = splitIdentifier(chunk.name);

  for (const t of queryTokens) {
    const inContent = contentLower.includes(t);
    const inName = nameLower.includes(t);
    const inNameSubtoken = nameSubtokens.includes(t);
    if (inName) {
      raw += nameBoost;
      reasons.push(`name match: "${t}" (+${nameBoost})`);
    } else if (inNameSubtoken) {
      raw += 2;
      reasons.push(`identifier sub-token: "${t}" (+2)`);
    } else if (inContent) {
      raw += 1;
      reasons.push(`content match: "${t}" (+1)`);
    }
  }

  // Length penalty: very long chunks dilute matches. Soft normalization.
  const lengthPenalty = Math.max(1, Math.log10(Math.max(10, chunk.content.length / 100)));
  const normalized = raw / Math.max(1, queryTokens.length) / lengthPenalty;

  return { score: normalized, reasons };
}

/**
 * Score every chunk against `query` and return the top-K. Unscored or
 * below-threshold chunks are dropped.
 */
export function retrieve(query: string, chunks: Chunk[], opts: RetrievalOptions = {}): ScoredChunk[] {
  const topK = opts.topK ?? 10;
  const minScore = opts.minScore ?? 0.05;
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scored: ScoredChunk[] = [];
  for (const chunk of chunks) {
    const { score, reasons } = scoreChunk(chunk, queryTokens, opts);
    if (score < minScore) continue;
    scored.push({ chunk, score, reasons });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
