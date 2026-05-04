import { parseTelemetry, type ParsedTelemetry } from './telemetry';

/**
 * Per-feature timeline aggregator. Pure: takes already-fetched inputs
 * (issue + comments + session log content) and returns a chronological
 * list of `TimelineEvent`s the UI renders top-to-bottom.
 *
 * Sources unified:
 *   1. **Intent** — the issue itself (creation timestamp + body =
 *      the agreed scope).
 *   2. **Phase telemetry** — each `🤖 Phase: <name>` comment posted by
 *      the engine workflows; parsed via `lib/telemetry`.
 *   3. **Session-log mentions** — entries in `SESSION_LOG.md` whose
 *      header mentions `issue #N`. Per the engine workflows shipped
 *      in PR #63, every cycle (implement / staging-deploy / promote /
 *      rollback) appends a structured entry referencing the issue.
 *   4. **Human comments** — anything that isn't a telemetry comment
 *      and isn't bot-authored.
 *
 * Out of scope for v1: PR review events (would need an extra
 * `pulls.listReviews` call), label-change events (issue events API),
 * deployment events from external services. The engine's own
 * appended SESSION_LOG entries already cover most of what those would
 * surface.
 */

export type TimelineEventKind =
  | 'intent'
  | 'phase'
  | 'session_log'
  | 'comment'
  | 'pr_link';

export type TimelineEvent = {
  kind: TimelineEventKind;
  /** ISO 8601 timestamp the event happened (or, for intent, the issue created_at). */
  timestamp: string;
  /** One-line headline rendered as the row's primary text. */
  title: string;
  /** Optional multi-line context (markdown rendered as plain whitespace-pre-wrap). */
  description?: string;
  /** Optional link to the underlying artifact (issue, PR, comment anchor, file blob). */
  url?: string;
  /** Source-specific metadata (telemetry fields, session-log outcome, etc.). */
  meta?: Record<string, string | number | boolean | null>;
};

/** Comment shape we accept — minimal subset of what Octokit returns. */
export type IssueCommentRow = {
  id: number;
  body?: string | null;
  user?: { login?: string | null; type?: string | null } | null;
  created_at: string;
  html_url?: string;
};

/** Issue shape — minimal subset of what Octokit returns. */
export type IssueRow = {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  created_at: string;
};

export type AggregateInput = {
  issue: IssueRow;
  comments: IssueCommentRow[];
  /** Raw `SESSION_LOG.md` content, or null if the file isn't present. */
  sessionLog: string | null;
};

/**
 * Aggregate every input source into a chronological event list.
 * Newest-first ordering matches the rest of the dashboard (proposals,
 * inbox, session log itself).
 */
export function aggregateTimeline(input: AggregateInput): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // --- Intent (the issue itself) ---
  events.push({
    kind: 'intent',
    timestamp: input.issue.created_at,
    title: 'Intent captured',
    description: input.issue.body?.slice(0, 1200) ?? undefined,
    url: input.issue.html_url,
  });

  // --- Comments (telemetry vs human) ---
  for (const c of input.comments) {
    const body = c.body ?? '';
    if (body.length === 0) continue;

    // Telemetry comments start with the bot prefix.
    if (/^🤖\s*Phase:\s*/m.test(body)) {
      const t = parseTelemetry(body);
      if (t) {
        events.push(buildPhaseEvent(t, c));
        // Some telemetry comments mention `PR: #N` — surface the PR link
        // as its own event so the user can click through. Opening a PR
        // is a meaningful step in the lifecycle.
        const prMatch = body.match(/PR:\s*#(\d+)/);
        if (prMatch) {
          events.push({
            kind: 'pr_link',
            timestamp: c.created_at,
            title: `PR #${prMatch[1]} opened`,
            description: extractField(body, 'Branch') ?? undefined,
            url: c.html_url,
            meta: { pr_number: parseInt(prMatch[1], 10) },
          });
        }
        continue;
      }
      // Falls through if the bot prefix is present but parse failed —
      // treat as a human comment so the user still sees something.
    }

    // Human comment.
    if (c.user?.type === 'Bot') continue; // skip other bots' chatter
    events.push({
      kind: 'comment',
      timestamp: c.created_at,
      title: c.user?.login ? `@${c.user.login} commented` : 'Comment',
      description: body.slice(0, 600),
      url: c.html_url,
    });
  }

  // --- Session-log entries that reference this issue ---
  if (input.sessionLog) {
    for (const entry of parseSessionLogEntriesFor(input.sessionLog, input.issue.number)) {
      events.push(entry);
    }
  }

  // Newest-first.
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return events;
}

/**
 * Build a per-phase telemetry event. Phase title becomes a human-friendly
 * label; description carries the model + tokens + cost; meta keeps the
 * raw fields for downstream renderers (e.g. token budgets in Phase #4
 * aggregate observability).
 */
function buildPhaseEvent(t: ParsedTelemetry, c: IssueCommentRow): TimelineEvent {
  const phaseLabel = phaseHumanLabel(t.phase);
  const statusSuffix = t.status === 'success' ? '' : ` — ${t.status}`;
  return {
    kind: 'phase',
    timestamp: c.created_at,
    title: `${phaseLabel}${statusSuffix}`,
    description:
      `${t.model} · ${t.tokens_in} in / ${t.tokens_out} out · $${t.cost_usd.toFixed(4)}` +
      (t.mode ? ` · ${t.mode}` : ''),
    url: c.html_url,
    meta: {
      phase: t.phase,
      model: t.model,
      tokens_in: t.tokens_in,
      tokens_out: t.tokens_out,
      cost_usd: t.cost_usd,
      mode: t.mode ?? null,
      status: t.status,
    },
  };
}

const PHASE_LABEL: Record<string, string> = {
  implement: 'Implement phase ran',
  'staging-deploy': 'Staging deploy',
  'promote-to-prod': 'Promoted to production',
  rollback: 'Rolled back',
  'smoke-verify': 'Smoke verify',
};

function phaseHumanLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? `Phase: ${phase}`;
}

/**
 * Extract a `**Field:** value` line from a markdown body. Used for
 * pulling `Branch` or `Mode` fields out of telemetry comments.
 */
function extractField(body: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\n)\\s*(?:\\*\\*)?${name}:?(?:\\*\\*)?\\s*(.+?)(?:\\n|$)`, 'i');
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Parse SESSION_LOG.md and emit one TimelineEvent per entry that
 * references this issue number. Entries are H2-headed and `---`-
 * separated; the engine writes headers like
 * `## YYYY-MM-DD HH:MM UTC — implement — issue #42`.
 *
 * Only entries that explicitly cite `issue #N` are returned. The rest
 * (`## 2026-05-04 — Release: staging (PR #N)`) belong to other features.
 */
export function parseSessionLogEntriesFor(
  rawLog: string,
  issueNumber: number,
): TimelineEvent[] {
  const blocks = rawLog.split(/\n---\s*\n/);
  const out: TimelineEvent[] = [];
  const issueRef = `issue #${issueNumber}`;
  for (const raw of blocks) {
    const block = raw.trim();
    if (block.length === 0) continue;
    const headerMatch = block.match(/^##\s+(.+)$/m);
    if (!headerMatch) continue;
    const header = headerMatch[1].trim();
    // Only entries that reference THIS issue. Use lowercase so
    // "issue #42" / "Issue #42" both match.
    if (!header.toLowerCase().includes(issueRef.toLowerCase())) continue;

    const ts = parseEntryTimestamp(header);
    if (!ts) continue;

    // Pull a couple of well-known sections for the description.
    const trigger = extractField(block, 'Trigger');
    const outcome = extractField(block, 'Outcome');
    const next_hint = extractField(block, 'Next session should start with');
    const descLines: string[] = [];
    if (trigger) descLines.push(`Trigger: ${trigger}`);
    if (next_hint) descLines.push(`Next: ${next_hint}`);

    out.push({
      kind: 'session_log',
      timestamp: ts,
      title: header,
      description: descLines.length > 0 ? descLines.join('\n') : undefined,
      meta: { outcome: outcome ?? null },
    });
  }
  return out;
}

/**
 * Parse `## YYYY-MM-DD HH:MM UTC — ...` headers into ISO timestamps.
 * Falls back to `## YYYY-MM-DD — ...` (no time) — older user-authored
 * entries don't include the time. Returns null if the header doesn't
 * match either shape.
 */
function parseEntryTimestamp(header: string): string | null {
  // Variant 1: "2026-05-04 14:30 UTC"
  const withTime = header.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})\s+UTC/);
  if (withTime) {
    return `${withTime[1]}T${withTime[2]}:${withTime[3]}:00Z`;
  }
  // Variant 2: "2026-05-04" (date only)
  const dateOnly = header.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateOnly) {
    return `${dateOnly[1]}T00:00:00Z`;
  }
  return null;
}
