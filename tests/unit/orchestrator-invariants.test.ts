import { describe, it, expect } from 'vitest';
import {
  STATE_LABELS,
  TRANSITION_TABLE,
  validateTransition,
  type StateLabel,
  type TransitionTrigger,
} from '../../lib/orchestrator';

/**
 * State-machine invariants. Pillar 10 first cut. These assertions catch
 * the failure modes that would otherwise surface only when an issue gets
 * stuck in production:
 *
 *   - dead states (non-terminal, no outbound transition)
 *   - unreachable states
 *   - terminal states with outbound transitions (state-machine bug)
 *   - cycles with no /abandon escape
 *   - phase-failure / /abandon / /rollback-complete must work from
 *     every non-terminal state (the universal fallbacks the orchestrator
 *     relies on for stuck-state recovery)
 */

const TERMINAL_STATES: ReadonlySet<StateLabel> = new Set<StateLabel>([
  'state:done',
  'state:abandoned',
  'state:rolled-back',
]);

const NON_TERMINAL_STATES = STATE_LABELS.filter((s) => !TERMINAL_STATES.has(s));

describe('orchestrator invariants', () => {
  it('every non-terminal state has at least one outbound transition (no dead-ends)', () => {
    for (const state of NON_TERMINAL_STATES) {
      // The universal fallbacks (/abandon, /rollback-complete, phase-failure)
      // count as outbound transitions for terminal-recovery purposes; check
      // them via validateTransition.
      const hasNamedRow = TRANSITION_TABLE.some((row) => row.from === state);
      const hasUniversalEscape =
        validateTransition(state, '/abandon').ok ||
        validateTransition(state, 'phase-failure').ok;
      expect(hasNamedRow || hasUniversalEscape, `${state} has no outbound transition`).toBe(true);
    }
  });

  it('terminal states have NO outbound transitions in TRANSITION_TABLE', () => {
    for (const state of TERMINAL_STATES) {
      const outbound = TRANSITION_TABLE.filter((row) => row.from === state);
      expect(outbound, `${state} is terminal but has outbound transitions in the table`).toEqual([]);
    }
  });

  it('terminal states reject every named trigger', () => {
    for (const state of TERMINAL_STATES) {
      // /abandon and /rollback-complete are universal but should still
      // refuse to operate on a terminal — once done, done.
      const triggers: TransitionTrigger[] = [
        '/proposals-accept',
        '/develop-auto',
        '/approve',
        '/abandon',
        '/rollback-complete',
        'phase-failure',
        'workflow-pr-open',
        'acm-pass',
        'swarm-pass',
        'tier2-pass',
      ];
      for (const t of triggers) {
        const r = validateTransition(state, t);
        expect(r.ok, `${state} should reject ${t}`).toBe(false);
      }
    }
  });

  it('every non-terminal state can be /abandon-ed', () => {
    for (const state of NON_TERMINAL_STATES) {
      const r = validateTransition(state, '/abandon');
      expect(r.ok, `${state} cannot be /abandon-ed`).toBe(true);
      if (r.ok) expect(r.next).toBe('state:abandoned');
    }
  });

  it('every non-terminal state can be hit with phase-failure', () => {
    for (const state of NON_TERMINAL_STATES) {
      const r = validateTransition(state, 'phase-failure');
      expect(r.ok, `${state} cannot transition on phase-failure`).toBe(true);
      if (r.ok) expect(r.next).toBe('state:blocked');
    }
  });

  it('every state in STATE_LABELS is reachable from the initial state (excluding pending-canary states)', () => {
    // Reachability via BFS over TRANSITION_TABLE + universal fallbacks.
    // state:proposed is the canonical initial state (issues land there
    // when filed via a scout or by hand).
    //
    // Three states are deliberately UNREACHABLE through the named
    // transition table in v1: acm-building, swarm-reviewing, tier2-smoke.
    // They have only EXIT transitions, with no entry rows yet, because
    // step 1 kept the legacy /approve → state:implementing path
    // unchanged so consumers without ACM config keep working. Step 16's
    // canary rollout flips the entry rows on; until then these states
    // are reachable only through manual labeling (orch-unstick CLI) or
    // a phase workflow setting them directly (phase-acm.yml does this
    // when invoked manually).
    const PENDING_CANARY_STATES: ReadonlySet<StateLabel> = new Set<StateLabel>([
      'state:acm-building',
      'state:swarm-reviewing',
      'state:tier2-smoke',
    ]);
    const reachable = new Set<StateLabel>(['state:proposed']);
    let added = true;
    while (added) {
      added = false;
      for (const row of TRANSITION_TABLE) {
        if (reachable.has(row.from) && !reachable.has(row.to)) {
          reachable.add(row.to);
          added = true;
        }
      }
      for (const s of [...reachable]) {
        if (!TERMINAL_STATES.has(s)) {
          if (!reachable.has('state:blocked')) {
            reachable.add('state:blocked');
            added = true;
          }
          if (!reachable.has('state:abandoned')) {
            reachable.add('state:abandoned');
            added = true;
          }
          if (!reachable.has('state:rolled-back')) {
            reachable.add('state:rolled-back');
            added = true;
          }
        }
      }
    }
    for (const state of STATE_LABELS) {
      if (PENDING_CANARY_STATES.has(state)) continue;
      expect(reachable.has(state), `${state} is not reachable from state:proposed`).toBe(true);
    }
  });

  it('pending-canary states all have well-formed exit transitions even though no entry exists yet', () => {
    // Locks in the v1 invariant: the 3 new states must have both pass
    // and fail exits even though nothing yet transitions INTO them. This
    // catches an accidental edit that would leave a pending-canary state
    // unreachable AND with no exit (i.e., a true dead-end).
    const newStates: StateLabel[] = ['state:acm-building', 'state:swarm-reviewing', 'state:tier2-smoke'];
    for (const state of newStates) {
      const exits = TRANSITION_TABLE.filter((r) => r.from === state);
      expect(exits.length, `${state} has no exit transitions`).toBeGreaterThanOrEqual(2);
      const targets = new Set(exits.map((r) => r.to));
      // At least one success target (not blocked) and at least one fail target (blocked).
      const hasSuccess = [...targets].some((t) => t !== 'state:blocked');
      const hasFailure = targets.has('state:blocked');
      expect(hasSuccess, `${state} has no success exit`).toBe(true);
      expect(hasFailure, `${state} has no failure exit`).toBe(true);
    }
  });

  it('the spec-ready /approve transition fires phase-implement.yml (until phase-acm wires in)', () => {
    // Step 1 deliberately keeps the existing /approve → state:implementing
    // transition unchanged so consumers without ACM keep working. Once
    // step 16's canary completes, this row should be replaced with
    // /approve → state:acm-building. This invariant pins the v1 default
    // so an accidental edit doesn't slip through.
    const r = validateTransition('state:spec-ready', '/approve');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next).toBe('state:implementing');
      expect(r.fires).toBe('phase-implement.yml');
    }
  });

  it('every new verification state (acm-building, swarm-reviewing, tier2-smoke) has both a pass and a fail trigger', () => {
    const newStates: StateLabel[] = [
      'state:acm-building',
      'state:swarm-reviewing',
      'state:tier2-smoke',
    ];
    for (const state of newStates) {
      const outbound = TRANSITION_TABLE.filter((r) => r.from === state).map((r) => r.trigger);
      const hasPass = outbound.some((t) => t.endsWith('-pass') || t === 'human-override');
      const hasFail = outbound.some((t) => t.endsWith('-fail'));
      expect(hasPass, `${state} lacks a pass trigger`).toBe(true);
      expect(hasFail, `${state} lacks a fail trigger`).toBe(true);
    }
  });

  it('there are no unintended cycles without an escape (every non-terminal cycle includes /abandon path)', () => {
    // Build adjacency from the named transitions only (universal
    // fallbacks always escape via state:blocked / state:abandoned, so
    // any cycle is escapable).
    const adj = new Map<StateLabel, StateLabel[]>();
    for (const state of STATE_LABELS) adj.set(state, []);
    for (const row of TRANSITION_TABLE) {
      adj.get(row.from)!.push(row.to);
    }
    // Detect any cycle via DFS — for v1 the table is small enough that
    // brute-force is fine. We only flag a cycle if it doesn't pass through
    // a terminal state.
    function hasNonTerminalCycle(start: StateLabel, current: StateLabel, visited: Set<StateLabel>): boolean {
      if (TERMINAL_STATES.has(current)) return false;
      for (const next of adj.get(current) ?? []) {
        if (next === start) return true;
        if (!visited.has(next)) {
          visited.add(next);
          if (hasNonTerminalCycle(start, next, visited)) return true;
        }
      }
      return false;
    }
    for (const state of NON_TERMINAL_STATES) {
      const cycleFound = hasNonTerminalCycle(state, state, new Set([state]));
      // Cycles ARE allowed if they're escapable via /abandon, which they
      // always are by construction. So we just assert: any cycle
      // detected must include a state for which /abandon is valid.
      if (cycleFound) {
        // /abandon works on any non-terminal — so any non-terminal cycle
        // is escapable. This is more of a sanity check than a real test.
        expect(validateTransition(state, '/abandon').ok).toBe(true);
      }
    }
  });
});
