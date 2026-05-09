import 'server-only';

export const PILLAR_IDS = ['gate_b', 'audit_p4', 'risk_p5', 'smoke_p7', 'evidence_p2'] as const;
export type PillarId = (typeof PILLAR_IDS)[number];

export const PILLAR_LABELS: Record<PillarId, string> = {
  gate_b: 'Gate B',
  audit_p4: 'Audit (Pillar 4)',
  risk_p5: 'Risk (Pillar 5)',
  smoke_p7: 'Smoke (Pillar 7)',
  evidence_p2: 'Evidence (Pillar 2)',
};

export type PillarStatus = 'passed' | 'blocked' | 'advisory' | 'failed' | 'not_run';

export type VerificationOutcome = {
  feature_id: number;
  repo: string;
  pillar: PillarId;
  status: PillarStatus;
  summary: string;
  details_url: string;
  cost_usd?: number;
  ran_at: string; // ISO 8601
};

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'passed',
  'blocked',
  'advisory',
  'failed',
  'not_run',
]);

export function isVerificationOutcome(v: unknown): v is VerificationOutcome {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.feature_id === 'number' &&
    typeof o.repo === 'string' &&
    typeof o.pillar === 'string' &&
    (PILLAR_IDS as readonly string[]).includes(o.pillar) &&
    typeof o.status === 'string' &&
    VALID_STATUSES.has(o.status) &&
    typeof o.summary === 'string' &&
    typeof o.details_url === 'string' &&
    typeof o.ran_at === 'string'
  );
}

export type VerificationRollup = {
  window_days: number;
  generated_at: string; // ISO 8601
  shipped_count: number;
  audit_caught_count: number;
  risk_flagged_count: number;
  smoke_failed_count: number;
  total_cost_usd: number;
};
