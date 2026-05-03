import type { Candidate } from './types';

export async function supabaseLogsAdapter(_config: { kind: 'supabase_logs'; project_ids: string[] }): Promise<Candidate[]> {
  process.stderr.write('STUB_FOR_1D: supabase_logs adapter returning empty list\n');
  return [];
}
