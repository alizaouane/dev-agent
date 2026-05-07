/**
 * Persistent store for swarm-review findings + their outcomes. Implements
 * the Greptile-style feedback filter (suppress new findings near a cluster
 * of dismissals) at v1's structural level: exact match on the normalized
 * (rule, file, message-prefix) tuple.
 *
 * v1 is intentionally embedding-free — no semantic similarity, no native
 * deps. The store is a JSONL file at `.dev-agent/findings.jsonl`,
 * append-only, committed to the repo. v1.1 will add an embedding-backed
 * sqlite-vec layer for semantic similarity (the canonical "fix worded
 * differently than the dismissed one" case the hash matcher misses).
 *
 * Pure logic — file I/O is delegated to a pluggable adapter so tests
 * can inject in-memory storage and so the workflow can swap in atomic
 * write semantics without touching the matching logic.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type FindingOutcome = 'open' | 'merged-with-fix' | 'dismissed' | 'false-positive';

export interface FindingRecord {
  /** Stable id derived from the (rule, file, message-prefix) tuple. */
  id: string;
  rule: string;
  file: string;
  /** First 60 chars of the finding message — message_key for matching. */
  message_key: string;
  /** Original full message, kept for human review only. */
  message: string;
  severity: 'high' | 'medium' | 'low';
  reviewer: string;
  pr_number: number;
  /** ISO-8601 timestamp when the finding was first recorded. */
  ts: string;
  /** Updated as the finding's lifecycle progresses. */
  outcome: FindingOutcome;
  /** When outcome was last updated. */
  outcome_ts?: string;
}

/** Storage adapter — pluggable for tests + atomic-write workflows. */
export interface FindingsStorage {
  readAll(): FindingRecord[];
  append(record: FindingRecord): void;
}

export class JsonlFileStorage implements FindingsStorage {
  constructor(private readonly path: string) {}

  readAll(): FindingRecord[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, 'utf8');
    const out: FindingRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as FindingRecord);
      } catch {
        // Skip malformed lines silently — partial recovery > total loss.
      }
    }
    return out;
  }

  append(record: FindingRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + '\n');
  }
}

export class InMemoryStorage implements FindingsStorage {
  records: FindingRecord[] = [];
  readAll(): FindingRecord[] {
    return [...this.records];
  }
  append(record: FindingRecord): void {
    this.records.push(record);
  }
}

/** Normalize whitespace + lowercase for stable matching across reviewers. */
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Stable id from the (rule, file, message-prefix) tuple. */
export function findingId(rule: string, file: string, message: string): string {
  const messageKey = normalize(message).slice(0, 60);
  // Simple FNV-1a 32-bit hash; good enough for clustering, not for
  // crypto. The id collides on (rule, file, message-prefix) match by
  // construction — that's the matching contract.
  let h = 0x811c9dc5;
  const s = `${normalize(rule)}${normalize(file)}${messageKey}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `f${h.toString(16).padStart(8, '0')}`;
}

export interface DismissalThresholds {
  /** Suppress new finding when ≥ this many prior records share its id with dismissive outcomes. */
  dismissalCount: number;
}

const DEFAULT_THRESHOLDS: DismissalThresholds = { dismissalCount: 3 };

const DISMISSIVE: ReadonlySet<FindingOutcome> = new Set<FindingOutcome>(['dismissed', 'false-positive']);

export interface SuppressionDecision {
  suppress: boolean;
  matched_id: string;
  prior_dismissals: number;
  prior_total: number;
  reason: string;
}

/**
 * Decide whether to suppress a candidate finding based on prior records.
 * The rule (per Greptile's pattern adapted to v1's hash-only matching):
 *
 *   - Compute the candidate's id from (rule, file, message-prefix).
 *   - Look at all prior records sharing that id.
 *   - If ≥ thresholds.dismissalCount of them have outcome `dismissed` or
 *     `false-positive` → suppress.
 *   - Otherwise → don't suppress.
 *
 * Records with `merged-with-fix` outcome are positive signal — the
 * finding was real and the reviewer was right. The matcher does NOT
 * suppress in that case (we want the reviewer to keep finding it).
 */
export function shouldSuppress(
  candidate: { rule: string; file: string; message: string },
  storage: FindingsStorage,
  thresholds: DismissalThresholds = DEFAULT_THRESHOLDS,
): SuppressionDecision {
  const id = findingId(candidate.rule, candidate.file, candidate.message);
  const prior = storage.readAll().filter((r) => r.id === id);
  const dismissed = prior.filter((r) => DISMISSIVE.has(r.outcome));
  const decision: SuppressionDecision = {
    suppress: dismissed.length >= thresholds.dismissalCount,
    matched_id: id,
    prior_dismissals: dismissed.length,
    prior_total: prior.length,
    reason:
      dismissed.length >= thresholds.dismissalCount
        ? `${dismissed.length} prior dismissals on the same (rule, file, message-prefix) — suppressed.`
        : `${dismissed.length} prior dismissals (need ≥${thresholds.dismissalCount}) — not suppressed.`,
  };
  return decision;
}

export interface RecordFindingInput {
  rule: string;
  file: string;
  message: string;
  severity: 'high' | 'medium' | 'low';
  reviewer: string;
  pr_number: number;
}

/** Append a new finding record with outcome `open`. Returns the stored record. */
export function recordFinding(
  input: RecordFindingInput,
  storage: FindingsStorage,
  now: () => Date = () => new Date(),
): FindingRecord {
  const messageKey = normalize(input.message).slice(0, 60);
  const record: FindingRecord = {
    id: findingId(input.rule, input.file, input.message),
    rule: input.rule,
    file: input.file,
    message_key: messageKey,
    message: input.message,
    severity: input.severity,
    reviewer: input.reviewer,
    pr_number: input.pr_number,
    ts: now().toISOString(),
    outcome: 'open',
  };
  storage.append(record);
  return record;
}

/**
 * Append a synthetic outcome update record. The store is append-only;
 * a "newer wins" rule applies when re-reading: the latest record per id
 * is the current outcome. We rebuild that view in `currentOutcomes()`.
 */
export function recordOutcome(
  id: string,
  outcome: FindingOutcome,
  context: { reviewer: string; pr_number: number },
  storage: FindingsStorage,
  now: () => Date = () => new Date(),
): void {
  // To preserve the append-only invariant, write a record carrying the
  // existing fields plus the new outcome. Find the latest record
  // matching this id.
  const all = storage.readAll();
  const latest = all.filter((r) => r.id === id).pop();
  if (!latest) {
    throw new Error(`recordOutcome: no prior record with id ${id}`);
  }
  const update: FindingRecord = {
    ...latest,
    outcome,
    outcome_ts: now().toISOString(),
    // Carry the latest reviewer + PR context so audit trails show who/where.
    reviewer: context.reviewer,
    pr_number: context.pr_number,
  };
  storage.append(update);
}

/** Get the latest outcome per id (append-only "log → current state" projection). */
export function currentOutcomes(storage: FindingsStorage): Map<string, FindingRecord> {
  const out = new Map<string, FindingRecord>();
  for (const r of storage.readAll()) {
    out.set(r.id, r);
  }
  return out;
}
