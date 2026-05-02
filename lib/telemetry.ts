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
