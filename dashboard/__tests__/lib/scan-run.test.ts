import { describe, it, expect } from 'vitest';
import { interpretScanRun } from '@/lib/scan-run';

const SINCE = 1_000_000_000_000; // fixed dispatch timestamp (ms)

describe('interpretScanRun', () => {
  it('reports error when the lookup failed', () => {
    expect(interpretScanRun({ error: 'boom' }, SINCE)).toEqual({
      kind: 'error',
      message: 'boom',
    });
  });

  it('reports queued when there is no run yet', () => {
    const result = { status: null, conclusion: null, html_url: null, created_at: null };
    expect(interpretScanRun(result, SINCE)).toEqual({ kind: 'queued' });
  });

  it('reports queued when the latest run predates this dispatch', () => {
    const stale = new Date(SINCE - 5 * 60_000).toISOString();
    const result = {
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://x',
      created_at: stale,
    };
    expect(interpretScanRun(result, SINCE)).toEqual({ kind: 'queued' });
  });

  it('reports running for an in-progress run created after dispatch', () => {
    const result = {
      status: 'in_progress',
      conclusion: null,
      html_url: 'https://run',
      created_at: new Date(SINCE + 2_000).toISOString(),
    };
    expect(interpretScanRun(result, SINCE)).toEqual({
      kind: 'running',
      runUrl: 'https://run',
    });
  });

  it('reports done+ok for a completed successful run', () => {
    const result = {
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://run',
      created_at: new Date(SINCE + 2_000).toISOString(),
    };
    expect(interpretScanRun(result, SINCE)).toEqual({
      kind: 'done',
      ok: true,
      runUrl: 'https://run',
    });
  });

  it('reports done+not-ok for a completed failed run', () => {
    const result = {
      status: 'completed',
      conclusion: 'startup_failure',
      html_url: 'https://run',
      created_at: new Date(SINCE + 2_000).toISOString(),
    };
    expect(interpretScanRun(result, SINCE)).toEqual({
      kind: 'done',
      ok: false,
      runUrl: 'https://run',
    });
  });
});
