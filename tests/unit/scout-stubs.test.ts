import { describe, it, expect, vi, afterEach } from 'vitest';
import { vercelLogsAdapter } from '../../lib/scout/vercel-logs';
import { supabaseLogsAdapter } from '../../lib/scout/supabase-logs';
import { competitiveAdapter } from '../../lib/scout/competitive';

describe('scout stub adapters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('vercel-logs stub returns empty + marker', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await vercelLogsAdapter({ kind: 'vercel_logs', project: 'p' });
    expect(r).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('STUB_FOR_1D'));
  });

  it('supabase-logs stub returns empty + marker', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await supabaseLogsAdapter({ kind: 'supabase_logs', project_ids: ['p'] });
    expect(r).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('STUB_FOR_1D'));
  });

  it('competitive stub returns empty + marker', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = await competitiveAdapter({ kind: 'competitive', feeds: [] });
    expect(r).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('STUB_FOR_1D'));
  });
});
