/**
 * The gates the dashboard's approve button drives.
 *
 * This exists as data rather than as a chain of `if`s inside the server
 * action so that a test can hold it against the orchestrator's transition
 * table in `skills/orchestrator/SKILL.md`. That table is the contract, and
 * two of its rows shipped as label flips with no dispatch behind them —
 * `state:staging-deployed` announcing a deployment nothing had run. A row
 * documented in the spec and missing here now fails the build instead of
 * waiting to be noticed in use.
 */

/** One approve gate: where it starts, where it lands, what it runs. */
export interface GateTransition {
  /** State label the issue must currently carry. */
  from: string;
  /** True when this gate is the `--promote` one. */
  promote: boolean;
  /** State label the issue carries afterwards. */
  to: string;
  /** Phase dispatched to the consumer's `dev-agent.yml` wrapper. */
  phase: 'implement' | 'staging-deploy' | 'promote-to-prod';
}

/** Every gate, in pipeline order. */
export const GATE_TRANSITIONS: readonly GateTransition[] = [
  {
    from: 'state:spec-ready',
    promote: false,
    to: 'state:implementing',
    phase: 'implement',
  },
  {
    from: 'state:pr-review',
    promote: false,
    to: 'state:staging-deployed',
    phase: 'staging-deploy',
  },
  {
    from: 'state:ready-to-promote',
    promote: true,
    to: 'state:promoting',
    phase: 'promote-to-prod',
  },
];

/**
 * Find the gate that applies to an issue's current state.
 *
 * @param from - The issue's current `state:*` label.
 * @param promote - Whether the operator pressed the promote gate.
 * @returns The matching transition, or undefined when there is none.
 */
export function transitionFor(from: string, promote: boolean): GateTransition | undefined {
  return GATE_TRANSITIONS.find((t) => t.from === from && t.promote === promote);
}
