import type { Candidate } from './types';

export async function vercelLogsAdapter(_config: { kind: 'vercel_logs'; project: string }): Promise<Candidate[]> {
  process.stderr.write('STUB_FOR_1D: vercel_logs adapter returning empty list\n');
  return [];
}
