import { createHash } from 'node:crypto';

/**
 * Spec approval — the durable record that a human accepted a reviewed spec.
 *
 * The operating model this implements: the user does not read specs. An
 * independent adversarial review (`dev-agent:spec-review`) reads them, the spec
 * is corrected and re-reviewed until the review is clean, and only then does the
 * user approve. The dashboard's job is to START the approved work, not to
 * approve it — so "approved" has to be something the dispatch path can verify
 * rather than a label a human remembered to set.
 *
 * Two properties make the record worth checking:
 *
 *  1. It names the verdict it was given against, so an approval cannot be
 *     harvested from a run that ended on a blocker.
 *  2. It is bound to a hash of the spec AND plan, so editing either after
 *     approval invalidates it. Without the hash, "approved" degrades into
 *     "was approved once, in some earlier form" — which is how unreviewed
 *     text reaches an implement agent.
 *
 * The plan is optional: the `quick-dev` route files a three-paragraph spec with
 * no separate plan, and exempting that route from the gate would leave exactly
 * one unguarded way into the implement workflow.
 *
 * The engine writes this file (see `lib/cli/approve-spec.ts`); the dashboard
 * reads it (see `dashboard/lib/spec-approval.ts`, a mirrored copy kept aligned
 * by `tests/unit/spec-approval-drift.test.ts`).
 */

/** Schema version of the approval artifact; bump on any breaking field change. */
export const SPEC_APPROVAL_SCHEMA_VERSION = 1;

/** Issue label that lets a human dispatch past a refused gate, on the record. */
export const OVERRIDE_LABEL = 'spec-approval:override';

/** Verdict emitted by the `dev-agent:spec-review` skill. */
export type ReviewVerdict = 'ok' | 'concerns' | 'blocker';

/** A recorded human approval of a reviewed spec, as stored on disk. */
export interface SpecApproval {
  /** Schema version of this record. */
  schema_version: number;
  /** Repo-relative path of the spec that was approved. */
  spec_path: string;
  /** Repo-relative path of the plan, or null when the spec carries no plan. */
  plan_path: string | null;
  /** sha256 over the spec and plan contents at approval time. */
  spec_sha256: string;
  /** The review verdict the approval was given against. */
  review_verdict: ReviewVerdict;
  /** How many review-and-correct rounds it took to reach that verdict. */
  review_rounds: number;
  /** Who approved, for the audit trail (git identity of the intake session). */
  approved_by: string;
  /** ISO-8601 timestamp of the approval. */
  approved_at: string;
}

/** Why a dispatch was allowed or refused. */
export type GateReason =
  | 'ok'
  | 'override'
  | 'missing'
  | 'malformed'
  | 'schema-too-new'
  | 'blocker-verdict'
  | 'spec-changed'
  | 'path-mismatch';

/** The decision the dispatch path reached, with an operator-facing message. */
export interface DispatchGateDecision {
  allow: boolean;
  reason: GateReason;
  /** One paragraph, safe to render verbatim in the dashboard. */
  message: string;
}

/**
 * Derive the approval artifact's path from the spec's path.
 *
 * Keyed off the spec rather than a single repo-wide file so two features in
 * flight cannot overwrite each other's approval.
 *
 * @param specPath - Repo-relative path to the spec, ending in `.md`.
 * @returns The sibling approval path, ending in `.approval.json`.
 * @throws If `specPath` does not end in `.md`.
 */
export function approvalPathForSpec(specPath: string): string {
  if (!specPath.endsWith('.md')) {
    throw new Error(`spec path must end in .md, got: ${specPath}`);
  }
  return `${specPath.slice(0, -'.md'.length)}.approval.json`;
}

/**
 * Domain separator between the spec and plan bytes. A NUL cannot appear in
 * either document, so no shift of text across the boundary can produce the
 * same digest as a different spec/plan split.
 */
const SEPARATOR = '\u0000';

/**
 * Hash the spec and plan together, so approval binds to both documents.
 *
 * The plan is included deliberately: approving a spec whose plan is then
 * rewritten would authorize work nobody reviewed. The separator byte prevents
 * a shift of text across the spec/plan boundary from producing the same digest.
 *
 * @param specText - Full spec contents.
 * @param planText - Full plan contents, or null when the spec carries no plan.
 * @returns Lowercase hex sha256 over both documents.
 */
export function hashSpecAndPlan(specText: string, planText: string | null): string {
  return createHash('sha256')
    .update(specText, 'utf8')
    .update(SEPARATOR, 'utf8')
    .update(planText ?? '', 'utf8')
    .digest('hex');
}

/** Result of reading an approval artifact off disk or out of the repo. */
export type ParseResult =
  | { ok: true; approval: SpecApproval }
  | { ok: false; error: string };

const VERDICTS: readonly string[] = ['ok', 'concerns', 'blocker'];

/**
 * Parse and validate an approval artifact's JSON text.
 *
 * Fails closed on anything it cannot fully understand — a half-read approval
 * is not an approval, and treating it as one would reintroduce the gap this
 * gate exists to close.
 *
 * @param raw - Raw file contents.
 * @returns The parsed approval, or the reason it was rejected.
 */
export function parseSpecApproval(raw: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'expected a JSON object' };
  }
  const o = value as Record<string, unknown>;

  const version = o.schema_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'schema_version must be a positive integer' };
  }

  const strings = ['spec_path', 'spec_sha256', 'approved_by', 'approved_at'] as const;
  for (const key of strings) {
    const v = o[key];
    if (typeof v !== 'string' || v.trim() === '') {
      return { ok: false, error: `${key} must be a non-empty string` };
    }
  }
  const planPath = o.plan_path;
  if (planPath !== null && (typeof planPath !== 'string' || planPath.trim() === '')) {
    return { ok: false, error: 'plan_path must be a non-empty string or null' };
  }
  if (!/^[0-9a-f]{64}$/.test(o.spec_sha256 as string)) {
    return { ok: false, error: 'spec_sha256 must be a 64-character lowercase hex digest' };
  }
  if (typeof o.review_verdict !== 'string' || !VERDICTS.includes(o.review_verdict)) {
    return { ok: false, error: `review_verdict must be one of ${VERDICTS.join(', ')}` };
  }
  const rounds = o.review_rounds;
  if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1) {
    return { ok: false, error: 'review_rounds must be a positive integer' };
  }

  return {
    ok: true,
    approval: {
      schema_version: version,
      spec_path: o.spec_path as string,
      plan_path: planPath as string | null,
      spec_sha256: o.spec_sha256 as string,
      review_verdict: o.review_verdict as ReviewVerdict,
      review_rounds: rounds,
      approved_by: o.approved_by as string,
      approved_at: o.approved_at as string,
    },
  };
}

/**
 * Render a spec and plan pair for an operator-facing message.
 *
 * @param spec - Spec path.
 * @param plan - Plan path, or null when there is no plan.
 * @returns A phrase naming both documents, or the spec alone.
 */
function describePair(spec: string, plan: string | null): string {
  return plan === null ? `${spec} (no plan)` : `${spec} and ${plan}`;
}

/**
 * Turn a refusal into a decision, honouring the override label.
 *
 * Shared by the pure gate below and by the dashboard's I/O wrapper, so an
 * override reads identically no matter which check refused — including the
 * checks that happen before the artifact is even read.
 *
 * @param reason - Why the gate refused.
 * @param message - The refusal text, phrased as a lowercase clause so it reads
 *   correctly both alone and appended to the override preamble.
 * @param overrideRequested - True when the issue carries `OVERRIDE_LABEL`.
 * @returns A refusal, or an allowing decision that states what was overridden.
 */
export function resolveRefusal(
  reason: GateReason,
  message: string,
  overrideRequested?: boolean,
): DispatchGateDecision {
  if (overrideRequested) {
    return {
      allow: true,
      reason: 'override',
      message: `Gate overridden by the ${OVERRIDE_LABEL} label. It would otherwise have refused: ${message}`,
    };
  }
  return { allow: false, reason, message };
}

/**
 * Decide whether implementation work may START on an issue.
 *
 * Replaces "the issue carries `state:spec-ready`, so dispatch". That label only
 * records which stage the issue reached; it says nothing about whether a review
 * ran, whether it passed, whether a human approved it, or whether the text
 * still matches what was approved.
 *
 * @param input.approvalRaw - Contents of the approval artifact, or null when the
 *   repo has no such file at the derived path.
 * @param input.currentSpecHash - `hashSpecAndPlan` over the spec and plan as
 *   they stand on the branch that would be implemented.
 * @param input.specPath - Spec path taken from the issue body.
 * @param input.planPath - Plan path taken from the issue body, or null when the
 *   issue declares no plan (the `quick-dev` route).
 * @param input.overrideRequested - True when the issue carries `OVERRIDE_LABEL`.
 * @returns Whether to dispatch, and the reason to show the operator.
 */
export function dispatchGateDecision(input: {
  approvalRaw: string | null;
  currentSpecHash: string;
  specPath: string;
  planPath: string | null;
  overrideRequested?: boolean;
}): DispatchGateDecision {
  const { approvalRaw, currentSpecHash, specPath, planPath, overrideRequested } = input;

  const refuse = (reason: GateReason, message: string): DispatchGateDecision =>
    resolveRefusal(reason, message, overrideRequested);

  if (approvalRaw === null) {
    return refuse(
      'missing',
      `no approval recorded at ${approvalPathForSpec(specPath)}. Specs are approved in the ` +
        'Claude Code intake session, after the independent review comes back clean. The ' +
        'dashboard starts approved work; it does not approve it.',
    );
  }

  const parsed = parseSpecApproval(approvalRaw);
  if (!parsed.ok) {
    return refuse(
      'malformed',
      `the approval at ${approvalPathForSpec(specPath)} could not be read (${parsed.error}). ` +
        'Re-run the intake session to record a valid approval.',
    );
  }
  const approval = parsed.approval;

  if (approval.schema_version > SPEC_APPROVAL_SCHEMA_VERSION) {
    return refuse(
      'schema-too-new',
      `the approval declares schema version ${approval.schema_version}, but this dashboard ` +
        `understands up to ${SPEC_APPROVAL_SCHEMA_VERSION}. Upgrade the dashboard rather than ` +
        'guessing at fields it does not know.',
    );
  }

  if (approval.review_verdict === 'blocker') {
    return refuse(
      'blocker-verdict',
      'the approval was recorded against a blocking review. Correct the spec and plan, ' +
        're-run the review until it is clean, and approve that result.',
    );
  }

  if (approval.spec_path !== specPath || approval.plan_path !== planPath) {
    return refuse(
      'path-mismatch',
      `the approval covers ${describePair(approval.spec_path, approval.plan_path)}, but the ` +
        `issue points at ${describePair(specPath, planPath)}. Approve the documents this ` +
        'issue names.',
    );
  }

  if (approval.spec_sha256 !== currentSpecHash) {
    return refuse(
      'spec-changed',
      'the spec or plan changed after approval, so the approval no longer covers what would ' +
        'be built. Re-run the review and approve the current text.',
    );
  }

  const caveat =
    approval.review_verdict === 'concerns'
      ? ' The review returned concerns, which the approver accepted.'
      : '';
  return {
    allow: true,
    reason: 'ok',
    message:
      `Approved by ${approval.approved_by} on ${approval.approved_at}, against a clean ` +
      `'${approval.review_verdict}' review after ${approval.review_rounds} round(s).${caveat}`,
  };
}
