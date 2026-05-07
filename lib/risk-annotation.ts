/**
 * Risk-classifies Bash invocations the agent emits.
 *
 * Pattern lifted from OpenHands' LLMSecurityAnalyzer: the agent tags every
 * shell command with a `risk:` field plus a one-line justification. The
 * harness uses the field two ways: (1) HIGH triggers a confirmation step
 * (label + comment + human gate), (2) the deterministic classifier in this
 * module *audits* the agent's self-rating — if the LLM rates a `rm -rf /`
 * as low risk, the harness rejects the call and bumps it to HIGH.
 *
 * The classifier deliberately favors over-flagging. False positives cost a
 * confirmation step; false negatives cost a wiped repo or a leaked token.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface AnnotatedBashCall {
  /** The shell command line as the agent would execute it. */
  cmd: string;
  /** The agent's self-rated risk classification. */
  risk: RiskLevel;
  /** Required: ≥5 chars explaining why this risk level is appropriate. */
  justification: string;
}

interface RiskRule {
  level: 'high' | 'medium';
  pattern: RegExp;
  reason: string;
}

const RISK_RULES: ReadonlyArray<RiskRule> = [
  // HIGH — destructive, exfiltrating, or privilege-escalating.
  { level: 'high', pattern: /\brm\s+(?:-[a-z]*r[a-z]*|--recursive)\b/i, reason: 'recursive rm' },
  { level: 'high', pattern: /\brm\s+-\w*f\w*\b/i, reason: 'force rm' },
  { level: 'high', pattern: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sh|bash|zsh|python|node|ruby|perl)/i, reason: 'pipe-to-shell from network' },
  { level: 'high', pattern: /\bchmod\s+(?:777|a\+w|a\+rwx|0?777)\b/, reason: 'world-writable chmod' },
  { level: 'high', pattern: /\bchown\s+(?:-R\s+)?root\b/, reason: 'chown to root' },
  { level: 'high', pattern: /\bsudo\b/, reason: 'sudo escalation' },
  { level: 'high', pattern: /\beval\s+["'`$]/, reason: 'eval of external string' },
  { level: 'high', pattern: />\s*\/(?:etc|dev|sys|proc|boot)\//, reason: 'redirect to system path' },
  { level: 'high', pattern: /\bdd\s+(?:if|of)=/, reason: 'dd block-level write' },
  { level: 'high', pattern: /\bmkfs\.|fdisk\b|parted\b/, reason: 'filesystem/partition op' },
  { level: 'high', pattern: />\s*~\/\.(?:ssh|aws|gnupg|kube)\//, reason: 'overwrite credential dir' },
  { level: 'high', pattern: /\b(?:cat|less|more|head|tail)\s+[^|;]*\.(?:env|pem|key|pfx|p12)\b/i, reason: 'read secret file' },
  { level: 'high', pattern: /\bgit\s+push\s+(?:-f|--force)/, reason: 'force push' },
  { level: 'high', pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[fdx]+)/, reason: 'destructive git reset/clean' },
  { level: 'high', pattern: /\bnpm\s+publish\b|\bcargo\s+publish\b|\bgem\s+push\b/, reason: 'package publish' },
  // MEDIUM — touches shared state / external systems but reversibly.
  { level: 'medium', pattern: /\bgit\s+push\b/, reason: 'git push' },
  { level: 'medium', pattern: /\bdocker\s+(?:push|run|exec)\b/, reason: 'docker shared state' },
  { level: 'medium', pattern: /\bgh\s+(?:pr|issue)\s+(?:create|close|merge|comment)/, reason: 'GitHub mutation' },
  { level: 'medium', pattern: /\.github\/workflows\//, reason: 'workflow file edit' },
  { level: 'medium', pattern: /\bkubectl\s+(?:apply|delete|edit|exec)/, reason: 'kubernetes mutation' },
  { level: 'medium', pattern: /\bnpm\s+(?:install|uninstall|i)\b/, reason: 'dep mutation' },
  { level: 'medium', pattern: /\bcurl\b|\bwget\b/, reason: 'network fetch' },
];

/** Highest matching rule wins; HIGH always beats MEDIUM. */
export function classifyRisk(cmd: string): { level: RiskLevel; reason: string | null } {
  let best: { level: RiskLevel; reason: string | null } = { level: 'low', reason: null };
  for (const rule of RISK_RULES) {
    if (!rule.pattern.test(cmd)) continue;
    if (rule.level === 'high') return { level: 'high', reason: rule.reason };
    if (best.level === 'low') best = { level: 'medium', reason: rule.reason };
  }
  return best;
}

export type AnnotationValidation =
  | { ok: true; classified: RiskLevel; reason: string | null }
  | { ok: false; error: string; classified: RiskLevel; reason: string | null };

/**
 * Validate the agent's annotation. Returns `ok: false` if:
 *   - Required fields are missing or malformed
 *   - The agent's self-rating dramatically under-rates the deterministic
 *     classifier (HIGH classified as LOW). MEDIUM-vs-LOW disagreements are
 *     tolerated since the deterministic rules are heuristic; HIGH-vs-LOW is
 *     a hard fail because every HIGH rule maps to a destructive op.
 */
export function validateAnnotation(call: AnnotatedBashCall): AnnotationValidation {
  const classified = classifyRisk(call.cmd);
  if (typeof call.cmd !== 'string' || call.cmd.trim().length === 0) {
    return { ok: false, error: 'cmd required (non-empty string)', classified: classified.level, reason: classified.reason };
  }
  if (!['low', 'medium', 'high', 'unknown'].includes(call.risk)) {
    return { ok: false, error: 'risk must be one of low | medium | high | unknown', classified: classified.level, reason: classified.reason };
  }
  if (typeof call.justification !== 'string' || call.justification.trim().length < 5) {
    return { ok: false, error: 'justification required (min 5 chars)', classified: classified.level, reason: classified.reason };
  }
  if (classified.level === 'high' && call.risk === 'low') {
    return {
      ok: false,
      error: `command pattern matches HIGH (${classified.reason}) but agent rated LOW`,
      classified: classified.level,
      reason: classified.reason,
    };
  }
  return { ok: true, classified: classified.level, reason: classified.reason };
}
