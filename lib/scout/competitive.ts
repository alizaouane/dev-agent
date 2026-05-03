import type { Candidate } from './types';

export async function competitiveAdapter(_config: { kind: 'competitive'; feeds: string[] }): Promise<Candidate[]> {
  process.stderr.write('STUB_FOR_1D: competitive adapter returning empty list\n');
  return [];
}
