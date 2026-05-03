export const STATE_LABELS = [
  'state:proposed',
  'state:scoping',
  'state:spec-ready',
  'state:implementing',
  'state:pr-review',
  'state:staging-deployed',
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
  | 'smoke-pass-staging'
  | '/approve --promote'
  | 'smoke-pass-prod'
  | '/abandon'
  | '/rollback-complete'
  | 'phase-failure';

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
