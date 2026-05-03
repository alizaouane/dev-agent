export type Candidate = {
  source:
    | 'github_issues'
    | 'vercel_logs'
    | 'supabase_logs'
    | 'codebase_audit'
    | 'competitive';
  title: string;
  body: string;
  evidence_url: string | null;
  severity_hint: 'low' | 'medium' | 'high';
  novelty_score: number;
};
