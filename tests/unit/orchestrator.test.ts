import { describe, it, expect } from 'vitest';
import {
  validateTransition,
  STATE_LABELS,
  TRANSITION_TABLE,
} from '../../lib/orchestrator';

describe('orchestrator', () => {
  it('exports the canonical state labels including industry-grade verification gates', () => {
    expect(STATE_LABELS).toHaveLength(15);
    expect(STATE_LABELS).toContain('state:spec-ready');
    expect(STATE_LABELS).toContain('state:done');
    expect(STATE_LABELS).toContain('state:blocked');
    // Industry-grade verification states (Pillars 1, 2, 7) — added in step 1
    // of the v1 build sequence; reachable only once their workflows ship.
    expect(STATE_LABELS).toContain('state:acm-building');
    expect(STATE_LABELS).toContain('state:swarm-reviewing');
    expect(STATE_LABELS).toContain('state:tier2-smoke');
  });

  it('defines exit transitions for each new verification state', () => {
    expect(validateTransition('state:acm-building', 'acm-pass').ok).toBe(true);
    expect(validateTransition('state:acm-building', 'acm-fail').ok).toBe(true);
    expect(validateTransition('state:swarm-reviewing', 'swarm-pass').ok).toBe(true);
    expect(validateTransition('state:swarm-reviewing', 'swarm-fail').ok).toBe(true);
    expect(validateTransition('state:swarm-reviewing', 'human-override').ok).toBe(true);
    expect(validateTransition('state:tier2-smoke', 'tier2-pass').ok).toBe(true);
    expect(validateTransition('state:tier2-smoke', 'tier2-fail').ok).toBe(true);
  });

  it('routes acm-pass back into the existing implement phase', () => {
    const r = validateTransition('state:acm-building', 'acm-pass');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.next).toBe('state:implementing');
      expect(r.fires).toBe('phase-implement.yml');
    }
  });

  it('allows the happy-path transition spec-ready → implementing via /approve', () => {
    const result = validateTransition('state:spec-ready', '/approve');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toBe('state:implementing');
  });

  it('allows promoting via /approve --promote', () => {
    const result = validateTransition('state:ready-to-promote', '/approve --promote');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.next).toBe('state:promoting');
  });

  it('rejects /approve --promote on spec-ready', () => {
    const result = validateTransition('state:spec-ready', '/approve --promote');
    expect(result.ok).toBe(false);
  });

  it('rejects /approve on a terminal state', () => {
    const result = validateTransition('state:done', '/approve');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/terminal|gateable/i);
  });

  it('every TRANSITION_TABLE row references a known state', () => {
    for (const row of TRANSITION_TABLE) {
      expect(STATE_LABELS).toContain(row.from);
      expect(STATE_LABELS).toContain(row.to);
    }
  });
});
