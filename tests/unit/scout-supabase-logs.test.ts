import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIG_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  process.env.SUPABASE_ACCESS_TOKEN = 'fake';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIG_TOKEN === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
  else process.env.SUPABASE_ACCESS_TOKEN = ORIG_TOKEN;
});

describe('supabaseLogsAdapter', () => {
  it('returns empty when token unset', async () => {
    delete process.env.SUPABASE_ACCESS_TOKEN;
    const { supabaseLogsAdapter } = await import('../../lib/scout/supabase-logs');
    expect(await supabaseLogsAdapter({ kind: 'supabase_logs', project_ids: ['p'] })).toEqual([]);
  });

  it('parses error rows and groups by message', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          { level: 'error', event_message: 'pg: connection refused' },
          { level: 'error', event_message: 'pg: connection refused' },
          { level: 'crit', event_message: 'OOM in function' },
        ],
      }),
    });
    const { supabaseLogsAdapter } = await import('../../lib/scout/supabase-logs');
    const candidates = await supabaseLogsAdapter({ kind: 'supabase_logs', project_ids: ['proj1'] });
    expect(candidates).toHaveLength(2);
    expect(candidates.find((c) => c.title.includes('connection refused'))?.title).toContain('2×');
  });

  it('skips a project on HTTP error but continues others', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: [{ level: 'error', event_message: 'oops' }] }) });
    const { supabaseLogsAdapter } = await import('../../lib/scout/supabase-logs');
    const candidates = await supabaseLogsAdapter({ kind: 'supabase_logs', project_ids: ['bad', 'good'] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toContain('oops');
  });
});
