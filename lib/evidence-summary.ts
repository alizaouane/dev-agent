/**
 * Distill a verification-bundle (the artifact produced by
 * phase-evidence-collector.yml) into a compact JSON summary the swarm
 * reviewers can consume. Pillar 2's frozen-EvidenceBundle requirement: every
 * reviewer reads the SAME summarized view, no independent retrieval, no per-
 * reviewer divergence (Cognition's anti-multi-agent argument resolved).
 *
 * Inputs (paths inside the un-tarred bundle directory):
 *   - gitleaks.json           secret-scanner output (flat array OR { findings: [...] })
 *   - semgrep.json            { results: [{ extra.severity, path, start.line, ... }] }
 *   - npm-audit.json          { vulnerabilities: { <pkg>: { severity, ... } } }
 *   - ast-diff.txt            free-text diff summary
 *   - meta.json               { pr_number, base_sha, head_sha, generated_at }
 *
 * Output shape (stable — reviewer prompts depend on field names):
 *   {
 *     meta:       { pr_number, head_sha, generated_at },
 *     scanners: {
 *       gitleaks:  { count, findings: [{ file, line, rule, redacted_match }] },
 *       semgrep:   { high_count, total_count, findings: [{ file, line, rule, severity, message }] },
 *       npm_audit: { high_count, total_count, findings: [{ package, severity, title, range }] }
 *     },
 *     ast_diff_excerpt: string         // first ~6KB of ast-diff.txt
 *   }
 *
 * The CAP_PER_SCANNER constant bounds each scanner's `findings` array so the
 * summary never explodes a reviewer's prompt context. Items past the cap are
 * dropped with a `truncated_to: <n>` field on the parent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const CAP_PER_SCANNER = 30;
export const AST_DIFF_EXCERPT_BYTES = 6000;

export interface EvidenceSummary {
  meta: {
    pr_number: number | null;
    head_sha: string | null;
    generated_at: string | null;
  };
  scanners: {
    gitleaks: GitleaksSummary;
    semgrep: SemgrepSummary;
    npm_audit: NpmAuditSummary;
  };
  ast_diff_excerpt: string;
}

export interface GitleaksSummary {
  count: number;
  truncated_to?: number;
  findings: Array<{
    file: string;
    line: number;
    rule: string;
    redacted_match: string;
  }>;
}

export interface SemgrepSummary {
  high_count: number;
  total_count: number;
  truncated_to?: number;
  findings: Array<{
    file: string;
    line: number;
    rule: string;
    severity: string;
    message: string;
  }>;
}

export interface NpmAuditSummary {
  high_count: number;
  total_count: number;
  truncated_to?: number;
  findings: Array<{
    package: string;
    severity: string;
    title: string;
    range: string;
  }>;
}

function readJsonOrNull(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function summarizeGitleaks(raw: unknown): GitleaksSummary {
  // gitleaks emits either a flat array or `{ findings: [...] }` depending on
  // version. Normalize both shapes.
  const items = Array.isArray(raw)
    ? (raw as unknown[])
    : raw && typeof raw === 'object' && 'findings' in raw
      ? asArray<unknown>((raw as { findings: unknown }).findings)
      : [];
  const total = items.length;
  const findings = items.slice(0, CAP_PER_SCANNER).map((item) => {
    const f = (item ?? {}) as Record<string, unknown>;
    return {
      file: asString(f.File ?? f.file),
      line: asNumber(f.StartLine ?? f.line, 0),
      rule: asString(f.RuleID ?? f.rule, 'unknown'),
      redacted_match: asString(f.Match ?? f.match, '<redacted>').slice(0, 200),
    };
  });
  const out: GitleaksSummary = { count: total, findings };
  if (total > CAP_PER_SCANNER) out.truncated_to = CAP_PER_SCANNER;
  return out;
}

function summarizeSemgrep(raw: unknown): SemgrepSummary {
  const results = asArray<unknown>((raw as { results?: unknown })?.results);
  const total = results.length;
  // Sort HIGH (Semgrep "ERROR") first so the cap doesn't drop the worst items.
  const sorted = [...results].sort((a, b) => {
    const sa = severityRank((a as { extra?: { severity?: string } })?.extra?.severity);
    const sb = severityRank((b as { extra?: { severity?: string } })?.extra?.severity);
    return sb - sa;
  });
  const findings = sorted.slice(0, CAP_PER_SCANNER).map((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const extra = ((r.extra ?? {}) as Record<string, unknown>) ?? {};
    const start = ((r.start ?? {}) as Record<string, unknown>) ?? {};
    return {
      file: asString(r.path),
      line: asNumber(start.line, 0),
      rule: asString(r.check_id, 'unknown'),
      severity: asString(extra.severity, 'INFO'),
      message: asString(extra.message, '').slice(0, 280),
    };
  });
  const high = results.filter(
    (item) =>
      asString((item as { extra?: { severity?: string } })?.extra?.severity).toUpperCase() ===
      'ERROR',
  ).length;
  const out: SemgrepSummary = { high_count: high, total_count: total, findings };
  if (total > CAP_PER_SCANNER) out.truncated_to = CAP_PER_SCANNER;
  return out;
}

function severityRank(s: string | undefined): number {
  switch ((s ?? '').toUpperCase()) {
    case 'ERROR':
      return 3;
    case 'WARNING':
      return 2;
    case 'INFO':
      return 1;
    default:
      return 0;
  }
}

function summarizeNpmAudit(raw: unknown): NpmAuditSummary {
  const vulns = ((raw as { vulnerabilities?: unknown })?.vulnerabilities ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const entries = Object.entries(vulns);
  const total = entries.length;
  const HIGH = new Set(['high', 'critical']);
  // Sort high+critical first so cap can't drop the worst items.
  const sorted = [...entries].sort((a, b) => npmRank(b[1].severity) - npmRank(a[1].severity));
  const findings = sorted.slice(0, CAP_PER_SCANNER).map(([pkg, v]) => ({
    package: pkg,
    severity: asString(v.severity, 'unknown'),
    title: asString(v.title ?? (Array.isArray(v.via) ? (v.via[0] as { title?: string })?.title : '')),
    range: asString(v.range, ''),
  }));
  const high = entries.filter(([, v]) => HIGH.has(asString(v.severity).toLowerCase())).length;
  const out: NpmAuditSummary = { high_count: high, total_count: total, findings };
  if (total > CAP_PER_SCANNER) out.truncated_to = CAP_PER_SCANNER;
  return out;
}

function npmRank(s: unknown): number {
  switch (asString(s).toLowerCase()) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'moderate':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

export function summarizeBundle(bundleDir: string): EvidenceSummary {
  const meta = (readJsonOrNull(path.join(bundleDir, 'meta.json')) ?? {}) as Record<
    string,
    unknown
  >;
  const gitleaksRaw = readJsonOrNull(path.join(bundleDir, 'gitleaks.json'));
  const semgrepRaw = readJsonOrNull(path.join(bundleDir, 'semgrep.json'));
  const npmAuditRaw = readJsonOrNull(path.join(bundleDir, 'npm-audit.json'));
  const astDiffPath = path.join(bundleDir, 'ast-diff.txt');
  const astDiffExcerpt = fs.existsSync(astDiffPath)
    ? fs.readFileSync(astDiffPath, 'utf8').slice(0, AST_DIFF_EXCERPT_BYTES)
    : '';

  return {
    meta: {
      pr_number: typeof meta.pr_number === 'number' ? (meta.pr_number as number) : null,
      head_sha: asString(meta.head_sha) || null,
      generated_at: asString(meta.generated_at) || null,
    },
    scanners: {
      gitleaks: summarizeGitleaks(gitleaksRaw),
      semgrep: summarizeSemgrep(semgrepRaw),
      npm_audit: summarizeNpmAudit(npmAuditRaw),
    },
    ast_diff_excerpt: astDiffExcerpt,
  };
}
