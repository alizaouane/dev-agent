export const STATE_LABELS = [
  'state:proposed',
  'state:scoping',
  'state:spec-ready',
  'state:acm-building',
  'state:implementing',
  'state:swarm-reviewing',
  'state:pr-review',
  'state:staging-deployed',
  'state:tier2-smoke',
  'state:ready-to-promote',
  'state:promoting',
  'state:done',
  'state:blocked',
  'state:abandoned',
  'state:rolled-back',
] as const;

export type StateLabel = (typeof STATE_LABELS)[number];

const TERMINAL_STATES: ReadonlySet<StateLabel> = new Set([
  'state:done',
  'state:abandoned',
  'state:rolled-back',
]);

export type TransitionTrigger =
  | '/proposals-accept'
  | '/develop-auto'
  | '/approve'
  | 'workflow-pr-open'
  | 'workflow-tier2-fire'
  | 'smoke-pass-staging'
  | '/approve --promote'
  | 'smoke-pass-prod'
  | '/abandon'
  | '/rollback-complete'
  | 'phase-failure'
  | 'acm-pass'
  | 'acm-fail'
  | 'swarm-pass'
  | 'swarm-fail'
  | 'human-override'
  | 'tier2-pass';
// Note: there is no `tier2-fail` trigger. The engine workflow
// `phase-tier2-smoke.yml` applies the `tier2-failed` label on a failed
// verdict and exits non-zero — it does NOT remove `state:tier2-smoke`
// or transition state. The runbook (`docs/runbooks/2026-05-20-tier2-smoke-rollout.md`)
// describes the recovery path (re-add `state:staging-deployed` or
// manual dispatch). A previous draft of this table had a fictional
// `tier2-fail → state:blocked` row; removing it so the orchestrator
// only describes transitions that actually happen.

export type TransitionRow = {
  from: StateLabel;
  trigger: TransitionTrigger;
  to: StateLabel;
  fires?: string;
};

export const TRANSITION_TABLE: readonly TransitionRow[] = [
  { from: 'state:proposed',          trigger: '/proposals-accept',  to: 'state:scoping' },
  { from: 'state:scoping',           trigger: '/develop-auto',      to: 'state:spec-ready' },
  { from: 'state:spec-ready',        trigger: '/approve',           to: 'state:implementing',     fires: 'phase-implement.yml' },
  { from: 'state:implementing',      trigger: 'workflow-pr-open',   to: 'state:pr-review' },
  { from: 'state:pr-review',         trigger: '/approve',           to: 'state:staging-deployed', fires: 'phase-staging-deploy.yml' },
  { from: 'state:staging-deployed',  trigger: 'smoke-pass-staging', to: 'state:ready-to-promote' },
  { from: 'state:ready-to-promote',  trigger: '/approve --promote', to: 'state:promoting',        fires: 'phase-promote-to-prod.yml' },
  { from: 'state:promoting',         trigger: 'smoke-pass-prod',    to: 'state:done' },

  // Industry-grade verification gates — new states are reachable only once
  // their corresponding workflows ship (steps 6/12/13 of the v1 build sequence).
  // Until then these rows define the EXIT transitions from each new state, but
  // no entry transition supersedes the existing pipeline above.
  { from: 'state:acm-building',      trigger: 'acm-pass',           to: 'state:implementing',     fires: 'phase-implement.yml' },
  { from: 'state:acm-building',      trigger: 'acm-fail',           to: 'state:blocked' },
  { from: 'state:swarm-reviewing',   trigger: 'swarm-pass',         to: 'state:pr-review' },
  { from: 'state:swarm-reviewing',   trigger: 'swarm-fail',         to: 'state:blocked' },
  { from: 'state:swarm-reviewing',   trigger: 'human-override',     to: 'state:pr-review' },
  { from: 'state:staging-deployed',  trigger: 'workflow-tier2-fire', to: 'state:tier2-smoke',      fires: 'dev-agent-tier2-smoke.yml' },
  { from: 'state:tier2-smoke',       trigger: 'tier2-pass',         to: 'state:ready-to-promote' },
] as const;

export type TransitionResult =
  | { ok: true; next: StateLabel; fires?: string }
  | { ok: false; reason: string };

export function validateTransition(
  from: StateLabel,
  trigger: TransitionTrigger,
): TransitionResult {
  if (TERMINAL_STATES.has(from)) {
    return { ok: false, reason: `${from} is terminal — not a gateable state` };
  }
  if (trigger === '/abandon') return { ok: true, next: 'state:abandoned' };
  if (trigger === '/rollback-complete') return { ok: true, next: 'state:rolled-back' };
  if (trigger === 'phase-failure') return { ok: true, next: 'state:blocked' };

  const row = TRANSITION_TABLE.find((r) => r.from === from && r.trigger === trigger);
  if (!row) {
    return { ok: false, reason: `no transition from ${from} via ${trigger}` };
  }
  return row.fires ? { ok: true, next: row.to, fires: row.fires } : { ok: true, next: row.to };
}
