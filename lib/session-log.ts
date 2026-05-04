import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Append-an-entry helper for the consumer repo's `SESSION_LOG.md`.
 *
 * The consumer maintains `SESSION_LOG.md` at repo root as the durable
 * "what happened" log. Human-authored Claude Code sessions append rich
 * entries; the dev-agent's automated phases append structured ones.
 * The PM agent reads the log on every conversation as primary grounding,
 * so empty `pm.md` no longer matters.
 *
 * Format observed in the consumer repos:
 *
 *   # Session Log
 *
 *   ## YYYY-MM-DD ... — <header>
 *
 *   **Trigger:** ...
 *
 *   ...sections...
 *
 *   **Next session should start with:** ...
 *
 *   ---
 *
 *   ## (next entry, also newest-first)
 *
 * New entries are PREPENDED above older ones (matches the
 * newest-first convention the existing log follows). The H1 stays at
 * the top; if the file doesn't exist yet, we initialize with one.
 */

export type PhaseOutcome = 'success' | 'blocked' | 'aborted' | 'rolled_back';

export type PhaseEntryInput = {
  /** ISO 8601 UTC timestamp; e.g. `2026-05-04T14:30:00Z`. Defaults to `now`. */
  timestamp?: Date;
  /** Phase name: `implement`, `staging-deploy`, `promote-to-prod`, `rollback`, etc. */
  phase: string;
  /** Issue number this phase ran against. */
  issue: number;
  /** Outcome of the phase. */
  outcome: PhaseOutcome;
  /** Optional one-line trigger description. Falls back to a generic line. */
  trigger?: string;
  /** Tokens used by the phase, with optional dollar cost. */
  tokens?: { input?: number; output?: number; cost_usd?: number };
  /** Number of files the phase changed (when applicable). */
  files_changed?: number;
  /** PR URL if the phase opened one. */
  pr_url?: string;
  /** One-or-more deferred / follow-up items. Bulleted in the entry. */
  deferred?: string[];
  /** What the next session should start with. Required — the log's most-loaded handoff cue. */
  next_session_hint: string;
};

const H1 = '# Session Log';

/**
 * Build a markdown entry block matching the existing convention. The
 * caller writes it (via `prependEntry`) — this function is pure so
 * tests can assert on the output without touching the filesystem.
 */
export function buildPhaseEntry(input: PhaseEntryInput): string {
  const ts = input.timestamp ?? new Date();
  const dateStr = formatTimestampUtc(ts);

  const headerSuffix = input.outcome === 'success' ? '' : ` — ${input.outcome.toUpperCase()}`;
  const header = `## ${dateStr} — ${input.phase} — issue #${input.issue}${headerSuffix}`;

  const trigger = input.trigger
    ? input.trigger
    : `dev-agent ${input.phase} phase, dispatched from the dashboard.`;

  const lines: string[] = [];
  lines.push(header, '');
  lines.push(`**Trigger:** ${trigger}`, '');
  lines.push(`**Outcome:** ${input.outcome}`, '');

  if (input.tokens) {
    const parts: string[] = [];
    if (typeof input.tokens.input === 'number') parts.push(`in=${input.tokens.input}`);
    if (typeof input.tokens.output === 'number') parts.push(`out=${input.tokens.output}`);
    if (typeof input.tokens.cost_usd === 'number') {
      parts.push(`cost=$${input.tokens.cost_usd.toFixed(2)}`);
    }
    if (parts.length > 0) {
      lines.push(`**Tokens:** ${parts.join(', ')}`, '');
    }
  }

  if (typeof input.files_changed === 'number') {
    lines.push(`**Files changed:** ${input.files_changed}`, '');
  }

  if (input.pr_url) {
    lines.push(`**PR:** ${input.pr_url}`, '');
  }

  if (input.deferred && input.deferred.length > 0) {
    lines.push('**Deferred / Next:**');
    for (const d of input.deferred) lines.push(`- ${d}`);
    lines.push('');
  }

  lines.push(`**Next session should start with:** ${input.next_session_hint}`, '');
  lines.push('---', '');

  return lines.join('\n');
}

/**
 * Build a "user approved scope" entry — the dashboard's
 * `approveAndStart` action calls this before dispatching the implement
 * workflow, so the human decision is recorded even if the workflow run
 * later fails.
 */
export type ApprovedScopeEntryInput = {
  timestamp?: Date;
  /** Issue number freshly created by the dashboard. */
  issue: number;
  /** GitHub username who approved. */
  approver: string;
  /** Short feature title (issue title). */
  title: string;
  /** The agreed-scope text the PM emitted. Truncated in the entry to keep things scannable. */
  scope: string;
};

export function buildApprovedScopeEntry(input: ApprovedScopeEntryInput): string {
  const ts = input.timestamp ?? new Date();
  const dateStr = formatTimestampUtc(ts);
  const scopeOneLine = collapseToOneLine(input.scope, 280);

  const lines: string[] = [];
  lines.push(`## ${dateStr} — user-approved scope — issue #${input.issue}`, '');
  lines.push(`**Trigger:** @${input.approver} clicked "Approve and start" on the PM brainstorm.`, '');
  lines.push(`**Title:** ${input.title}`, '');
  lines.push(`**Scope (one-line):** ${scopeOneLine}`, '');
  lines.push(
    `**Next session should start with:** waiting for the implement phase to dispatch and open a PR.`,
    '',
  );
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Prepend an entry to `filepath`. If the file doesn't exist, initialize
 * with the H1 + the entry. If it does exist, insert the entry right
 * after the H1 (so newest entries appear at the top — matches the
 * existing log convention).
 *
 * Idempotent on writes: if the file already has the same first entry
 * (same H2 line, byte-identical), this is a no-op. Used by phase
 * workflows on `if: always()` so retries don't double-write.
 */
export function prependEntry(filepath: string, entry: string): { changed: boolean } {
  const trimmedEntry = entry.endsWith('\n') ? entry : `${entry}\n`;

  if (!existsSync(filepath)) {
    writeFileSync(filepath, `${H1}\n\n${trimmedEntry}`, 'utf8');
    return { changed: true };
  }

  const current = readFileSync(filepath, 'utf8');

  // Find the first entry's header in the existing log.
  const firstEntryHeader = trimmedEntry.split('\n', 1)[0];
  const existingFirst = current
    .split('\n')
    .find((l) => l.startsWith('## '));
  if (existingFirst === firstEntryHeader) {
    // Same H2 already at top — assume duplicate, skip. Phases sometimes
    // run with `if: always()` and we don't want a retry to write twice.
    return { changed: false };
  }

  const lines = current.split('\n');
  const h1Idx = lines.findIndex((l) => /^#\s+/.test(l));
  let inserted: string;
  if (h1Idx === -1) {
    // No H1 found — prepend H1 + entry, leave the rest of the file alone.
    inserted = `${H1}\n\n${trimmedEntry}${current}`;
  } else {
    // Insert after the H1 + a blank line.
    const before = lines.slice(0, h1Idx + 1).join('\n');
    const after = lines.slice(h1Idx + 1).join('\n');
    // Trim leading whitespace on `after` so we don't accumulate blank lines on retries.
    const afterTrimmed = after.replace(/^\n+/, '');
    inserted = `${before}\n\n${trimmedEntry}${afterTrimmed}`;
  }
  writeFileSync(filepath, inserted, 'utf8');
  return { changed: true };
}

/** Format `YYYY-MM-DD HH:mm UTC`. Match the existing convention's date precision. */
function formatTimestampUtc(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

function collapseToOneLine(text: string, maxLen: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
}
