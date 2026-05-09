import { describe, it, expect } from 'vitest';
import {
  PILLAR_IDS,
  isVerificationOutcome,
  type VerificationOutcome,
  type VerificationRollup,
} from '@/lib/verification/types';

describe('verification types', () => {
  it('PILLAR_IDS lists the five v1 pillars', () => {
    expect(PILLAR_IDS).toEqual(['gate_b', 'audit_p4', 'risk_p5', 'smoke_p7', 'evidence_p2']);
  });

  it('isVerificationOutcome accepts a fully-formed outcome', () => {
    const ok: VerificationOutcome = {
      feature_id: 142,
      repo: 'qualiency/caliente',
      pillar: 'audit_p4',
      status: 'passed',
      summary: 'No syntax issues found',
      details_url: 'https://github.com/x/y/actions/runs/1',
      cost_usd: 0.04,
      ran_at: '2026-05-09T10:00:00Z',
    };
    expect(isVerificationOutcome(ok)).toBe(true);
  });

  it('isVerificationOutcome rejects bad status', () => {
    expect(
      isVerificationOutcome({
        feature_id: 1,
        repo: 'a/b',
        pillar: 'audit_p4',
        status: 'maybe',
        summary: '',
        details_url: '',
        ran_at: '2026-05-09T10:00:00Z',
      } as unknown),
    ).toBe(false);
  });

  it('isVerificationOutcome rejects an unknown pillar', () => {
    expect(
      isVerificationOutcome({
        feature_id: 1,
        repo: 'a/b',
        pillar: 'nonexistent',
        status: 'passed',
        summary: '',
        details_url: '',
        ran_at: '2026-05-09T10:00:00Z',
      } as unknown),
    ).toBe(false);
  });

  it('isVerificationOutcome accepts an outcome without the optional cost_usd', () => {
    expect(
      isVerificationOutcome({
        feature_id: 1,
        repo: 'a/b',
        pillar: 'audit_p4',
        status: 'passed',
        summary: '',
        details_url: '',
        ran_at: '2026-05-09T10:00:00Z',
      }),
    ).toBe(true);
  });

  it('isVerificationOutcome rejects a non-numeric cost_usd', () => {
    expect(
      isVerificationOutcome({
        feature_id: 1,
        repo: 'a/b',
        pillar: 'audit_p4',
        status: 'passed',
        summary: '',
        details_url: '',
        cost_usd: '0.04',
        ran_at: '2026-05-09T10:00:00Z',
      } as unknown),
    ).toBe(false);
  });

  it('isVerificationOutcome rejects NaN feature_id', () => {
    expect(
      isVerificationOutcome({
        feature_id: NaN,
        repo: 'a/b',
        pillar: 'audit_p4',
        status: 'passed',
        summary: '',
        details_url: '',
        ran_at: '2026-05-09T10:00:00Z',
      } as unknown),
    ).toBe(false);
  });

  it('isVerificationOutcome rejects Infinity cost_usd', () => {
    expect(
      isVerificationOutcome({
        feature_id: 1,
        repo: 'a/b',
        pillar: 'audit_p4',
        status: 'passed',
        summary: '',
        details_url: '',
        cost_usd: Infinity,
        ran_at: '2026-05-09T10:00:00Z',
      } as unknown),
    ).toBe(false);
  });

  it('VerificationRollup compiles with required fields', () => {
    const rollup: VerificationRollup = {
      window_days: 7,
      generated_at: '2026-05-09T10:00:00Z',
      shipped_count: 12,
      audit_caught_count: 3,
      risk_flagged_count: 2,
      smoke_failed_count: 1,
      total_cost_usd: 4.2,
    };
    expect(rollup.shipped_count).toBe(12);
  });
});
