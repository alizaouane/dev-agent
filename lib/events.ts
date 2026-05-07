/**
 * Append-only event log for dev-agent runs.
 *
 * Pattern lifted from OpenHands V1's event-sourced architecture: stateless
 * agents + immutable EventLog as the single mutable thing → deterministic
 * replay, strong consistency, recoverable history. We keep one JSONL file
 * per issue under `.dev-agent/events/<issue>.jsonl` so post-hoc replay,
 * audit-trail export, and dashboard activity rendering can all read from
 * the same canonical source.
 *
 * Why JSONL not SQLite: GitHub Actions runners are ephemeral; a flat,
 * append-only file is committed back to the repo (or uploaded as artifact)
 * without a separate sync step, and the dashboard parses it incrementally.
 * SQLite would re-introduce the "lost on cache miss" failure mode the
 * orchestrator was designed to avoid.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default location relative to the repo root (or the working dir). */
export const DEFAULT_EVENTS_DIR = '.dev-agent/events';

export interface DevAgentEvent {
  /** ISO-8601 UTC timestamp set by `emit()`, never by callers. */
  ts: string;
  /** A stable identifier for the workflow run that emitted the event. */
  run_id: string;
  /** The issue number this event pertains to, or null for global events. */
  issue: number | null;
  /** Phase name (e.g. `phase-acm`, `phase-swarm-review`, `cost-watchdog`). */
  phase: string;
  /**
   * Event verb. Conventional shape: `<area>.<verb>`, e.g.
   *   - `phase.started`
   *   - `phase.completed`
   *   - `verdict.posted`
   *   - `override.applied`
   *   - `cost.threshold.crossed`
   */
  event: string;
  /** Free-form structured payload. Keep it JSON-serializable and small. */
  payload: Record<string, unknown>;
}

export type EventInput = Omit<DevAgentEvent, 'ts'>;

export interface EmitOptions {
  /** Override the events directory (mostly for tests). */
  dir?: string;
  /** Override the timestamp (mostly for deterministic tests). */
  now?: () => Date;
}

function eventsFilePath(issue: number | null, dir: string): string {
  const stem = issue == null ? 'global' : String(issue);
  return path.join(dir, `${stem}.jsonl`);
}

/**
 * Append an event. Returns the fully-populated record (including timestamp).
 * Creates the events directory on demand.
 *
 * Failure modes are intentionally loud — if the events directory cannot be
 * written, the caller has a bigger problem than telemetry and should crash
 * loudly rather than silently swallow the loss.
 */
export function emit(input: EventInput, opts: EmitOptions = {}): DevAgentEvent {
  const dir = opts.dir ?? DEFAULT_EVENTS_DIR;
  const now = opts.now?.() ?? new Date();
  const event: DevAgentEvent = { ts: now.toISOString(), ...input };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(eventsFilePath(input.issue, dir), JSON.stringify(event) + '\n');
  return event;
}

/**
 * Read all events for an issue (or `null` for global events) in append order.
 * Returns `[]` if the file does not exist. Malformed lines are skipped so
 * a partial write does not break the consumer.
 */
export function readEvents(issue: number | null, opts: { dir?: string } = {}): DevAgentEvent[] {
  const dir = opts.dir ?? DEFAULT_EVENTS_DIR;
  const file = eventsFilePath(issue, dir);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const out: DevAgentEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as DevAgentEvent);
    } catch {
      // Skip malformed lines silently — better partial recovery than total loss.
    }
  }
  return out;
}
