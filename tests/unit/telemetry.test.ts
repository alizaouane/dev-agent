import { describe, it, expect } from 'vitest';
import { formatTelemetry, type TelemetryPayload } from '../../lib/telemetry';

describe('formatTelemetry', () => {
  it('formats a successful implement phase', () => {
    const payload: TelemetryPayload = {
      phase: 'implement',
      model: 'claude-sonnet-4-6',
      duration_ms: 12 * 60_000 + 34 * 1000,
      tokens_in: 145_000,
      tokens_out: 67_000,
      cost_usd: 2.31,
      attempts: 1,
      status: 'success',
      artifacts: {
        branch: 'feature/refund-button',
        pr_number: 142,
        tests_added: 12,
        tests_failing: 0,
        drift_check: 'clean',
      },
    };
    const out = formatTelemetry(payload);
    expect(out).toContain('Phase: implement');
    expect(out).toContain('Model: claude-sonnet-4-6');
    expect(out).toContain('Duration: 12m 34s');
    expect(out).toContain('Tokens: 145k in / 67k out');
    expect(out).toContain('Cost: $2.31');
    expect(out).toContain('Attempts: 1');
    expect(out).toContain('Status: success');
    expect(out).toContain('branch: feature/refund-button');
    expect(out).toContain('PR: #142');
    expect(out).toContain('tests: 12 added, 0 failing');
    expect(out).toContain('drift-check: clean');
  });

  it('formats a blocked phase with no PR', () => {
    const payload: TelemetryPayload = {
      phase: 'implement',
      model: 'claude-sonnet-4-6',
      duration_ms: 30 * 60_000,
      tokens_in: 50_000,
      tokens_out: 20_000,
      cost_usd: 1.10,
      attempts: 3,
      status: 'blocked',
      artifacts: {
        branch: 'feature/x',
        blocker: 'cost cap exceeded',
      },
    };
    const out = formatTelemetry(payload);
    expect(out).toContain('Status: blocked');
    expect(out).toContain('blocker: cost cap exceeded');
    expect(out).not.toContain('PR:');
  });

  it('formats sub-second durations', () => {
    const payload: TelemetryPayload = {
      phase: 'smoke_verify',
      model: 'claude-haiku-4-5',
      duration_ms: 4500,
      tokens_in: 1000,
      tokens_out: 200,
      cost_usd: 0.01,
      attempts: 1,
      status: 'success',
      artifacts: {},
    };
    expect(formatTelemetry(payload)).toContain('Duration: 4s');
  });
});
