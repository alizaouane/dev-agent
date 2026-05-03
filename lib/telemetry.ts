export type PhaseName =
  | 'spec_brainstorm'
  | 'implement'
  | 'staging_deploy'
  | 'promote_to_prod'
  | 'smoke_verify'
  | 'scout_digest'
  | 'rollback';

export type PhaseStatus = 'success' | 'blocked' | 'aborted';

export interface TelemetryArtifacts {
  branch?: string;
  pr_number?: number;
  tests_added?: number;
  tests_failing?: number;
  drift_check?: 'clean' | 'flagged';
  blocker?: string;
  [key: string]: string | number | undefined;
}

export interface TelemetryPayload {
  phase: PhaseName;
  model: string;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  attempts: number;
  status: PhaseStatus;
  artifacts: TelemetryArtifacts;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function formatArtifacts(artifacts: TelemetryArtifacts): string {
  const lines: string[] = [];
  if (artifacts.branch) lines.push(`  - branch: ${artifacts.branch}`);
  if (artifacts.pr_number !== undefined) lines.push(`  - PR: #${artifacts.pr_number}`);
  if (artifacts.tests_added !== undefined && artifacts.tests_failing !== undefined) {
    lines.push(`  - tests: ${artifacts.tests_added} added, ${artifacts.tests_failing} failing`);
  }
  if (artifacts.drift_check) lines.push(`  - drift-check: ${artifacts.drift_check}`);
  if (artifacts.blocker) lines.push(`  - blocker: ${artifacts.blocker}`);
  for (const [k, v] of Object.entries(artifacts)) {
    if (['branch', 'pr_number', 'tests_added', 'tests_failing', 'drift_check', 'blocker'].includes(k)) continue;
    if (v !== undefined) lines.push(`  - ${k}: ${v}`);
  }
  return lines.join('\n');
}

export function formatTelemetry(payload: TelemetryPayload): string {
  const artifactsBlock = formatArtifacts(payload.artifacts);
  return [
    '🤖 Phase: ' + payload.phase,
    'Model: ' + payload.model,
    'Duration: ' + formatDuration(payload.duration_ms),
    `Tokens: ${formatTokens(payload.tokens_in)} in / ${formatTokens(payload.tokens_out)} out`,
    'Cost: $' + payload.cost_usd.toFixed(2),
    'Attempts: ' + payload.attempts,
    'Status: ' + payload.status,
    artifactsBlock ? 'Artifacts:\n' + artifactsBlock : '',
  ]
    .filter(Boolean)
    .join('\n');
}

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
  // Inverse of formatDuration: "4s" / "12m" / "12m 34s"
  const trimmed = raw.trim();
  const match = trimmed.match(/^(?:(\d+)m)?\s*(?:(\d+)s)?$/);
  if (!match) return undefined;
  const minutes = match[1] ? parseInt(match[1], 10) : 0;
  const seconds = match[2] ? parseInt(match[2], 10) : 0;
  if (!match[1] && !match[2]) return undefined;
  return minutes * 60_000 + seconds * 1000;
}

function parseTokensField(raw: string): { tokens_in: number; tokens_out: number } | null {
  // "145k in / 67k out" — tolerant of whitespace
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

// Field-by-field, two-pass parser. Tolerant of:
//   - the engine's `formatTelemetry` block (Duration / Attempts / Artifacts)
//   - the workflow's bash `printf` block (Mode, no Duration/Attempts/Artifacts)
// Required fields: Phase, Model, Tokens, Cost, Status. Everything else optional.
export function parseTelemetry(comment: string): ParsedTelemetry | null {
  if (!comment) return null;

  // Pass 1: find the anchor line "🤖 Phase: <name>" and split into lines from there.
  const anchorMatch = comment.match(/🤖\s*Phase:\s*([^\n]+)/);
  if (!anchorMatch) return null;
  const anchorIdx = comment.indexOf(anchorMatch[0]);
  const tail = comment.slice(anchorIdx);
  const lines = tail.split('\n');

  // Pass 2: walk lines, recognizing prefixes. Stop after Status or at end / Artifacts block.
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
    if (trimmedLine.startsWith('Artifacts:')) break; // ignore artifacts block
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
      // Unknown line after we've started; stop scanning so we don't consume
      // unrelated comment text below the telemetry block.
      if (sawStatus) break;
    }
  }

  // Required fields check.
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
