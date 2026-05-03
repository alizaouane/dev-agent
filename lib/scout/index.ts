import type { ScoutSource } from '../types';
import type { Candidate } from './types';
import { githubIssuesAdapter } from './github-issues';
import { codebaseAuditAdapter } from './codebase-audit';
import { vercelLogsAdapter } from './vercel-logs';
import { supabaseLogsAdapter } from './supabase-logs';
import { competitiveAdapter } from './competitive';

export async function runScoutSources(sources: ScoutSource[]): Promise<Candidate[]> {
  const all: Candidate[] = [];
  for (const src of sources) {
    switch (src.kind) {
      case 'github_issues': all.push(...(await githubIssuesAdapter())); break;
      case 'codebase_audit': all.push(...(await codebaseAuditAdapter(src))); break;
      case 'vercel_logs': all.push(...(await vercelLogsAdapter(src))); break;
      case 'supabase_logs': all.push(...(await supabaseLogsAdapter(src))); break;
      case 'competitive': all.push(...(await competitiveAdapter(src))); break;
    }
  }
  return all;
}
