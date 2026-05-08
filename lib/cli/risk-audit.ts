#!/usr/bin/env tsx
/**
 * Pillar 5 advisory audit: read the agent's `.dev-agent/bash-log.jsonl`
 * (one `{cmd, risk, justification}` JSON object per line), validate each
 * entry against `lib/risk-annotation.ts`, and emit:
 *
 *   - <output>.json — { total, by_level, mismatches, findings[] }
 *   - <output>.md   — short markdown report for the issue comment
 *
 * v1 is advisory: the workflow does NOT exit non-zero on mismatches. It
 * surfaces them as an issue label + comment so operators see them. v1.1
 * will flip to fail-closed once we've audited typical false-positive
 * rates on real consumer PRs.
 *
 * If the bash-log is missing the audit emits an "absent" verdict (the
 * agent was running on an old prompt that didn't know about the log,
 * or the workflow is running against a stub-mode invocation that didn't
 * author one). Workflow treats `absent` as a no-op.
 *
 * Usage:
 *   risk-audit.ts --log .dev-agent/bash-log.jsonl --output /tmp/risk-audit
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyRisk, validateAnnotation, AnnotatedBashCall, RiskLevel } from '../risk-annotation';

interface Args {
  log: string;
  output: string;
}

interface AuditFinding {
  cmd: string;
  agent_risk: RiskLevel;
  classified_risk: RiskLevel;
  classifier_reason: string | null;
  justification: string;
  validation_error: string | null;
  index: number;
}

export interface AuditReport {
  verdict: 'absent' | 'clean' | 'mismatches';
  total: number;
  by_agent_level: Record<RiskLevel, number>;
  by_classifier_level: Record<RiskLevel, number>;
  mismatch_count: number;
  high_risk_count: number;
  findings: AuditFinding[];
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--log') {
      args.log = value;
      i++;
    } else if (flag === '--output') {
      args.output = value;
      i++;
    }
  }
  if (!args.log || !args.output) {
    console.error('usage: risk-audit --log <path> --output <path-prefix>');
    process.exit(1);
  }
  return args as Args;
}

function emptyByLevel(): Record<RiskLevel, number> {
  return { low: 0, medium: 0, high: 0, unknown: 0 };
}

function isAnnotated(o: unknown): o is AnnotatedBashCall {
  if (!o || typeof o !== 'object') return false;
  const r = o as Record<string, unknown>;
  return typeof r.cmd === 'string' && typeof r.risk === 'string' && typeof r.justification === 'string';
}

export function audit(logPath: string): AuditReport {
  if (!fs.existsSync(logPath)) {
    return {
      verdict: 'absent',
      total: 0,
      by_agent_level: emptyByLevel(),
      by_classifier_level: emptyByLevel(),
      mismatch_count: 0,
      high_risk_count: 0,
      findings: [],
    };
  }

  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const findings: AuditFinding[] = [];
  const byAgent = emptyByLevel();
  const byClassifier = emptyByLevel();
  let mismatches = 0;
  let highRisk = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed JSON: still try classifying the raw line text against the
      // deterministic ruleset. A line like `{ "cmd": "rm -rf /", "risk": ` (a
      // truncated record from a crashing tool) would otherwise hide its
      // dangerous payload under `byClassifier.unknown`. (codex P2 #1 from
      // PR #80 review: classifier HIGH activity must not be lost just because
      // the surrounding record was malformed.)
      const cmdPreview = line.slice(0, 200);
      const cls = classifyRisk(cmdPreview);
      findings.push({
        cmd: cmdPreview,
        agent_risk: 'unknown',
        classified_risk: cls.level,
        classifier_reason: cls.reason,
        justification: '',
        validation_error: 'malformed JSON line',
        index: i,
      });
      byAgent.unknown++;
      byClassifier[cls.level]++;
      if (cls.level === 'high') highRisk++;
      mismatches++;
      continue;
    }

    if (!isAnnotated(parsed)) {
      const cmdStr =
        typeof (parsed as { cmd?: unknown })?.cmd === 'string' ? (parsed as { cmd: string }).cmd : '';
      const cls = classifyRisk(cmdStr);
      findings.push({
        cmd: cmdStr || '<missing>',
        agent_risk: 'unknown',
        // Use the real classified level + reason. The previous code computed
        // the level for the finding but then incremented `byClassifier.unknown`,
        // making aggregate counts disagree with the per-finding rows whenever
        // a malformed record contained a dangerous command. (codex P2 #1.)
        classified_risk: cls.level,
        classifier_reason: cls.reason,
        justification: '',
        validation_error: 'missing required fields (cmd | risk | justification)',
        index: i,
      });
      byAgent.unknown++;
      byClassifier[cls.level]++;
      if (cls.level === 'high') highRisk++;
      mismatches++;
      continue;
    }

    const validation = validateAnnotation(parsed);
    byAgent[parsed.risk]++;
    byClassifier[validation.classified]++;
    if (validation.classified === 'high') highRisk++;

    const isMismatch =
      !validation.ok || (validation.classified === 'high' && parsed.risk !== 'high');
    if (isMismatch) mismatches++;

    if (isMismatch || validation.classified === 'high') {
      findings.push({
        cmd: parsed.cmd.slice(0, 400),
        agent_risk: parsed.risk,
        classified_risk: validation.classified,
        classifier_reason: validation.reason,
        justification: parsed.justification.slice(0, 300),
        validation_error: validation.ok ? null : validation.error,
        index: i,
      });
    }
  }

  return {
    verdict: mismatches > 0 ? 'mismatches' : 'clean',
    total: lines.length,
    by_agent_level: byAgent,
    by_classifier_level: byClassifier,
    mismatch_count: mismatches,
    high_risk_count: highRisk,
    findings,
  };
}

function renderMarkdown(report: AuditReport): string {
  if (report.verdict === 'absent') {
    return [
      '🤖 Phase: risk-audit',
      'Verdict: absent',
      '',
      'No `.dev-agent/bash-log.jsonl` was authored by the implement-agent during this run.',
      'This is expected when the agent prompt predates the Pillar 5 risk-annotation contract',
      '(see `prompts/implement.md` § Bash risk annotations). No action required.',
    ].join('\n');
  }

  const head = [
    '🤖 Phase: risk-audit',
    `Verdict: ${report.verdict}`,
    `Total Bash calls: ${report.total}`,
    `Mismatches (agent rated < classifier): ${report.mismatch_count}`,
    `Classifier-HIGH calls: ${report.high_risk_count}`,
    '',
    `Agent self-rating: low=${report.by_agent_level.low} medium=${report.by_agent_level.medium} high=${report.by_agent_level.high} unknown=${report.by_agent_level.unknown}`,
    `Classifier rating: low=${report.by_classifier_level.low} medium=${report.by_classifier_level.medium} high=${report.by_classifier_level.high} unknown=${report.by_classifier_level.unknown}`,
  ].join('\n');

  if (report.findings.length === 0) {
    return [head, '', '_No mismatches or HIGH-risk calls. Clean run._'].join('\n');
  }

  const rows = report.findings
    .slice(0, 20)
    .map((f) => {
      const cmdPreview = f.cmd.replace(/\|/g, '\\|').slice(0, 80);
      const reason = f.classifier_reason ?? '—';
      const err = f.validation_error ? ` _(${f.validation_error})_` : '';
      return `| ${f.index} | \`${cmdPreview}\` | ${f.agent_risk} | **${f.classified_risk}** (${reason})${err} |`;
    })
    .join('\n');

  const truncated =
    report.findings.length > 20
      ? `\n_…and ${report.findings.length - 20} more findings (see audit JSON in workflow logs)_`
      : '';

  return [
    head,
    '',
    'Findings (mismatches + classifier-HIGH calls):',
    '',
    '| # | command | agent | classifier (reason) |',
    '| --- | --- | --- | --- |',
    rows + truncated,
    '',
    '_Advisory in v1: this report does not block the PR. v1.1 will fail-closed on mismatches._',
  ].join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const report = audit(args.log);
  const outBase = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(`${outBase}.json`, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(`${outBase}.md`, renderMarkdown(report), 'utf8');
  console.log(`risk-audit: verdict=${report.verdict} total=${report.total} mismatches=${report.mismatch_count} high=${report.high_risk_count}`);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`risk-audit failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
