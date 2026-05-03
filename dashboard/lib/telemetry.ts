// Dashboard-side parser for the engine's telemetry comment format.
// Mirrors lib/telemetry.ts's parseTelemetry/ParsedTelemetry.
// Duplicated here (rather than imported via ../../lib/telemetry) so the
// Next.js build with rootDirectory=dashboard resolves cleanly without
// experimental.externalDir or output-tracing tweaks.

export interface ParsedTelemetry {
  phase: string;
  model: string;
  duration_ms?: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  attempts?: number;
  status: string;
  mode?: 'stub' | 'live';
}

function parseTokenCount(raw: string): number {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([\d.]+)\s*([kKmM]?)$/);
  if (!match) return NaN;
  const n = parseFloat(match[1]);
  const suffix = match[2].toLowerCase();
  if (suffix === 'k') return Math.round(n * 1000);
  if (suffix === 'm') return Math.round(n * 1_000_000);
  return Math.round(n);
}

function parseDuration(raw: string): number | undefined {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(?:(\d+)m)?\s*(?:(\d+)s)?$/);
  if (!match) return undefined;
  const minutes = match[1] ? parseInt(match[1], 10) : 0;
  const seconds = match[2] ? parseInt(match[2], 10) : 0;
  if (!match[1] && !match[2]) return undefined;
  return minutes * 60_000 + seconds * 1000;
}

function parseTokensField(raw: string): { tokens_in: number; tokens_out: number } | null {
  const m = raw.match(/^\s*([\d.]+\s*[kKmM]?)\s*in\s*\/\s*([\d.]+\s*[kKmM]?)\s*out\s*$/);
  if (!m) return null;
  const tokens_in = parseTokenCount(m[1]);
  const tokens_out = parseTokenCount(m[2]);
  if (Number.isNaN(tokens_in) || Number.isNaN(tokens_out)) return null;
  return { tokens_in, tokens_out };
}

function parseCostField(raw: string): number | null {
  const m = raw.match(/^\s*\$?\s*([\d.]+)\s*$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isNaN(n) ? null : n;
}

function parseModeField(raw: string): 'stub' | 'live' | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'stub' || trimmed === 'live') return trimmed;
  return undefined;
}

export function parseTelemetry(comment: string): ParsedTelemetry | null {
  if (!comment) return null;

  const anchorMatch = comment.match(/🤖\s*Phase:\s*([^\n]+)/);
  if (!anchorMatch) return null;
  const anchorIdx = comment.indexOf(anchorMatch[0]);
  const tail = comment.slice(anchorIdx);
  const lines = tail.split('\n');

  const fields: Record<string, string> = {};
  fields.phase = anchorMatch[1].trim();

  const prefixes: Array<[string, string]> = [
    ['Model:', 'model'],
    ['Tokens:', 'tokens'],
    ['Cost:', 'cost'],
    ['Mode:', 'mode'],
    ['Duration:', 'duration'],
    ['Attempts:', 'attempts'],
    ['Status:', 'status'],
  ];

  let sawStatus = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    if (trimmedLine.startsWith('Artifacts:')) break;
    let matched = false;
    for (const [prefix, key] of prefixes) {
      if (trimmedLine.startsWith(prefix)) {
        fields[key] = trimmedLine.slice(prefix.length).trim();
        matched = true;
        if (key === 'status') sawStatus = true;
        break;
      }
    }
    if (!matched) {
      if (sawStatus) break;
    }
  }

  if (!fields.phase || !fields.model || !fields.tokens || !fields.cost || !fields.status) {
    return null;
  }

  const tokens = parseTokensField(fields.tokens);
  if (!tokens) return null;

  const cost = parseCostField(fields.cost);
  if (cost === null) return null;

  const out: ParsedTelemetry = {
    phase: fields.phase,
    model: fields.model.trim(),
    tokens_in: tokens.tokens_in,
    tokens_out: tokens.tokens_out,
    cost_usd: cost,
    status: fields.status.trim(),
  };

  if (fields.duration !== undefined) {
    const d = parseDuration(fields.duration);
    if (d !== undefined) out.duration_ms = d;
  }
  if (fields.attempts !== undefined) {
    const a = parseInt(fields.attempts, 10);
    if (!Number.isNaN(a)) out.attempts = a;
  }
  if (fields.mode !== undefined) {
    const m = parseModeField(fields.mode);
    if (m) out.mode = m;
  }

  return out;
}
