// Mirrors the shape of `DevAgentEvent` from lib/events.ts but kept loose-typed
// here so this module has no runtime dependency on the writer. The scraper
// must tolerate future event-shape additions without crashing.
export interface DevAgentEventLike {
  ts: string;
  run_id: string;
  issue: number | null;
  phase: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface OverrideSummary {
  ts: string;
  issue: number | null;
  actor: string;
  reason: string;
  override_type: string;
}

// `[A-Za-z0-9+/=]+` is the canonical base64 alphabet. The trailing `=` may
// or may not be present depending on padding; both work.
const ANCHOR = /<!--\s*dev-agent:event:b64\s+([A-Za-z0-9+/=]+)\s*-->/g;

export function extractAnchors(commentBody: string): string[] {
  if (!commentBody) return [];
  const out: string[] = [];
  for (const m of commentBody.matchAll(ANCHOR)) {
    out.push(m[1]);
  }
  return out;
}

export function decodeAnchor(b64: string): DevAgentEventLike | null {
  let json: string;
  try {
    json = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const e = parsed as Partial<DevAgentEventLike>;
  if (
    typeof e.ts !== 'string' ||
    typeof e.run_id !== 'string' ||
    typeof e.phase !== 'string' ||
    typeof e.event !== 'string' ||
    !e.payload ||
    typeof e.payload !== 'object'
  ) {
    return null;
  }
  // ts must be parseable — sort/render paths assume valid ISO-ish strings.
  if (Number.isNaN(Date.parse(e.ts))) return null;
  // `issue` may be null (global events) — only reject if it's neither.
  if (e.issue !== null && typeof e.issue !== 'number') return null;
  return e as DevAgentEventLike;
}

export function summarizeOverride(e: DevAgentEventLike): OverrideSummary | null {
  if (e.event !== 'override.applied') return null;
  const p = e.payload as Record<string, unknown>;
  if (
    typeof p.override_type !== 'string' ||
    typeof p.actor !== 'string' ||
    typeof p.reason !== 'string'
  ) {
    return null;
  }
  return {
    ts: e.ts,
    issue: e.issue,
    actor: p.actor,
    reason: p.reason,
    override_type: p.override_type,
  };
}
