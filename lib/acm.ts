/**
 * Acceptance-Criteria Manifest (ACM) — the deterministic core of Pillar 1.
 *
 * Specs at `docs/specs/*.md` carry an `## Acceptance criteria` section
 * (lowercase) with `- [ ]` / `- [x]` checkbox bullets, one criterion per
 * bullet. This module extracts those bullets, lints them for testability,
 * and produces / validates the manifest that binds each criterion to its
 * generated test file.
 *
 * Everything here is deterministic. The only model call in the ACM phase is
 * the test-stub generation step (a separate test-agent with its own
 * context — see Augment's circular-validation fix). Extraction, linting,
 * hashing, and manifest validation must all be reproducible from the
 * spec text alone.
 */

import * as crypto from 'node:crypto';

export interface AcceptanceCriterion {
  /** Stable id, generated as `AC-{n}` in spec order. */
  id: string;
  /** Cleaned bullet text, with the leading `- [ ]` / `- [x]` stripped. */
  text: string;
  /** Verbatim line from the spec, including the marker. */
  raw: string;
  /** True if the bullet was authored as `- [x]` (already-completed). */
  checked: boolean;
}

/** A criterion plus its generated test binding (added during phase-acm). */
export interface CriterionBinding extends AcceptanceCriterion {
  test_file?: string;
  test_name?: string;
  test_sha256?: string;
}

export interface ACMManifest {
  /** Path of the spec relative to the repo root, e.g. `docs/specs/2026-05-06-x.md`. */
  spec_path: string;
  /** SHA-256 of the spec's UTF-8 bytes at generation time (for drift detection). */
  spec_sha256: string;
  /** ISO-8601 UTC timestamp when the manifest was generated. */
  generated_at: string;
  /** All criteria, in spec order. */
  criteria: CriterionBinding[];
}

const HEADING_RE = /^#{2,3}\s+acceptance\s+criteria\s*$/i;
const ANY_HEADING_RE = /^#{1,6}\s/;
const BULLET_RE = /^\s*-\s+\[([ x])\]\s+(.+)$/;

/**
 * Parse the spec markdown and return the criteria found under the
 * `## Acceptance criteria` heading (heading-case-insensitive). Empty array
 * if the section is missing.
 *
 * Stops at the next markdown heading at any level — sub-section bullets
 * past the first heading are *not* included, to keep the contract tight.
 */
export function extractAcceptanceCriteria(specMarkdown: string): AcceptanceCriterion[] {
  const lines = specMarkdown.split('\n');
  const headingIdx = lines.findIndex((l) => HEADING_RE.test(l));
  if (headingIdx < 0) return [];

  const out: AcceptanceCriterion[] = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (ANY_HEADING_RE.test(line)) break;
    const m = BULLET_RE.exec(line);
    if (!m) continue;
    out.push({
      id: `AC-${out.length + 1}`,
      text: m[2].trim(),
      raw: line,
      checked: m[1] === 'x',
    });
  }
  return out;
}

/** A single lint complaint about a criterion. `error` blocks ACM; `warning` is advisory. */
export interface LintFinding {
  id: string;
  level: 'error' | 'warning';
  rule: string;
  message: string;
}

const VAGUE_TERMS = /\b(?:better|cleaner|faster|nicer|smoother|prettier|improve(?:d|s|ment)?|enhance(?:d|s|ment)?)\b/i;
const MEASURABLE_TERMS = /\b(?:by|to|than|≥|>=|>|<|≤|<=|==|=|within|under|over|exactly)\b|\d/;
const OBSERVABLE_NOUNS = /\b(?:returns?|emits?|logs?|labels?|files?|metric|metrics|status|response|payload|event|events|error|errors|exception|stdout|stderr|output|writes?|appends?|posts?|sends?|stores?|persists?|displays?|renders?|navigates?|redirects?|clickable|visible|equals?|matches?)\b/i;

/**
 * Lint extracted criteria for testability. Errors (must fix):
 *   - too short (< 5 words) — usually means `- [ ] tests`
 *   - vague language without a measurable threshold (e.g. "make it better")
 *
 * Warnings (advisory, but should be addressed):
 *   - multiple `and`s — likely a compound criterion that should split
 *   - no observable noun — criterion can't be bound to an assertion
 */
export function lintCriteria(criteria: AcceptanceCriterion[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const c of criteria) {
    const text = c.text;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 5) {
      out.push({ id: c.id, level: 'error', rule: 'too-short', message: 'criterion too short (< 5 words)' });
    }
    if (VAGUE_TERMS.test(text) && !MEASURABLE_TERMS.test(text)) {
      out.push({
        id: c.id,
        level: 'error',
        rule: 'vague-no-threshold',
        message: 'vague language without measurable threshold (e.g. "make it better" with no number/comparator)',
      });
    }
    const andCount = (text.match(/\band\b/gi) ?? []).length;
    if (andCount >= 2) {
      out.push({ id: c.id, level: 'warning', rule: 'compound', message: 'multiple "and" — consider splitting into separate criteria' });
    }
    if (!OBSERVABLE_NOUNS.test(text)) {
      out.push({
        id: c.id,
        level: 'warning',
        rule: 'no-observable',
        message: 'no observable noun (returns/emits/logs/labels/files/metric/...) detected',
      });
    }
  }
  return out;
}

/** SHA-256 of UTF-8 bytes, hex-encoded. Used for spec drift + test-lock checks. */
export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Convenience helper that hashes a map of `{path: content}`. */
export function computeFileHashes(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) out[p] = computeSha256(c);
  return out;
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate that a manifest is internally consistent and covers every
 * criterion in the current spec.
 *
 *   - Every spec criterion must have a manifest entry (id match).
 *   - Every manifest entry must have `test_file` + `test_sha256`.
 *   - Manifest must declare `spec_path` + `spec_sha256` + `generated_at`.
 *
 * The `spec_sha256` *value* is not re-computed here — that's the caller's
 * job (drift check requires reading the spec from disk). This function
 * only checks structural completeness.
 */
export function validateManifest(
  manifest: ACMManifest,
  specCriteria: AcceptanceCriterion[],
): ManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!manifest.spec_path) errors.push('manifest.spec_path missing');
  if (!manifest.spec_sha256) errors.push('manifest.spec_sha256 missing');
  if (!manifest.generated_at) errors.push('manifest.generated_at missing');

  const manifestById = new Map(manifest.criteria.map((c) => [c.id, c]));
  for (const c of specCriteria) {
    const entry = manifestById.get(c.id);
    if (!entry) {
      errors.push(`criterion ${c.id} (${c.text.slice(0, 40)}…) missing from manifest`);
      continue;
    }
    if (!entry.test_file) errors.push(`${c.id}: missing test_file`);
    if (!entry.test_sha256) errors.push(`${c.id}: missing test_sha256`);
  }

  // Manifest may carry stale criteria the spec no longer has — flag as warning.
  const specIds = new Set(specCriteria.map((c) => c.id));
  for (const c of manifest.criteria) {
    if (!specIds.has(c.id)) warnings.push(`manifest carries ${c.id} not present in current spec`);
  }

  return { ok: errors.length === 0, errors, warnings };
}
