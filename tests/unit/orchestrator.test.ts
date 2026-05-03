import { describe, it, expect } from 'vitest';
import {
  validateTransition,
  STATE_LABELS,
  TRANSITION_TABLE,
} from '../../lib/orchestrator';

describe('orchestrator', () => {
  it('exports the canonical 12 state labels', () => {
    expect(STATE_LABELS).toHaveLength(12);
    expect(STATE_LABELS).toContain('state:spec-ready');
    expect(STATE_LABELS).toContain('state:done');
    expect(STATE_LABELS).toContain('state:blocked');
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
