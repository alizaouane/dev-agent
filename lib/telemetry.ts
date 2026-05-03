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
}

// Matches the canonical block produced by `formatTelemetry`. The token counts
// are written through `formatTokens` (e.g. "145k", "1.2M"), so we accept those
// suffixes too — not just raw integers.
const TELEMETRY_RE =
  /🤖\s*Phase:\s*([^\n]+?)\s*\n\s*Model:\s*([^\n]+?)\s*\n\s*Duration:\s*([^\n]+?)\s*\n\s*Tokens:\s*([\d.]+\s*[kKmM]?)\s*in\s*\/\s*([\d.]+\s*[kKmM]?)\s*out\s*\n\s*Cost:\s*\$?\s*([\d.]+)\s*\n\s*Attempts:\s*(\d+)\s*\n\s*Status:\s*([^\n]+)/;

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

export function parseTelemetry(comment: string): ParsedTelemetry | null {
  if (!comment) return null;
  const match = comment.match(TELEMETRY_RE);
  if (!match) return null;
  const tokensIn = parseTokenCount(match[4]);
  const tokensOut = parseTokenCount(match[5]);
  if (Number.isNaN(tokensIn) || Number.isNaN(tokensOut)) return null;
  return {
    phase: match[1].trim(),
    model: match[2].trim(),
    duration_ms: parseDuration(match[3]),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: parseFloat(match[6]),
    attempts: parseInt(match[7], 10),
    status: match[8].trim(),
  };
}
