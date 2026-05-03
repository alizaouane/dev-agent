import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const ORIG_TOKEN = process.env.VERCEL_TOKEN;

beforeEach(() => {
  vi.resetModules();
  process.env.VERCEL_TOKEN = 'fake';
});

afterEach(() => {
  if (ORIG_TOKEN === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = ORIG_TOKEN;
});

describe('vercelLogsAdapter', () => {
  it('returns empty when VERCEL_TOKEN is unset', async () => {
    delete process.env.VERCEL_TOKEN;
    const { vercelLogsAdapter } = await import('../../lib/scout/vercel-logs');
    expect(await vercelLogsAdapter({ kind: 'vercel_logs', project: 'p' })).toEqual([]);
  });

  it('groups errors by path+message', async () => {
    const { execFileSync } = await import('node:child_process');
    (execFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      JSON.stringify({ level: 'error', message: 'TypeError: x is undefined', requestPath: '/api/foo' }),
      JSON.stringify({ level: 'error', message: 'TypeError: x is undefined', requestPath: '/api/foo' }),
      JSON.stringify({ level: 'error', message: 'OOM', requestPath: '/api/bar' }),
      JSON.stringify({ level: 'info', message: 'noise' }),
    ].join('\n'));
    const { vercelLogsAdapter } = await import('../../lib/scout/vercel-logs');
    const candidates = await vercelLogsAdapter({ kind: 'vercel_logs', project: 'p' });
    expect(candidates).toHaveLength(2);
    expect(candidates.find((c) => c.title.includes('TypeError'))?.title).toContain('2×');
  });

  it('returns empty + warning when vc CLI fails', async () => {
    const { execFileSync } = await import('node:child_process');
    (execFileSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('not found'); });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { vercelLogsAdapter } = await import('../../lib/scout/vercel-logs');
    const candidates = await vercelLogsAdapter({ kind: 'vercel_logs', project: 'p' });
    expect(candidates).toEqual([]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('skipping'));
    stderrSpy.mockRestore();
  });
});
