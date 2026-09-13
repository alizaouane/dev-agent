#!/usr/bin/env tsx
/**
 * verify-approval — refuse to implement a spec nobody approved.
 *
 * This is the enforcing half of the spec-approval gate. The dashboard runs the
 * same check before it dispatches, but that check is a courtesy: it tells the
 * operator early, in the UI, why a button will not work. It cannot be the only
 * check, for two reasons.
 *
 * First, the dashboard is not the only way to start a run — `gh workflow run`,
 * a consumer's own wrapper, and a re-dispatch from the Actions tab all reach
 * this workflow directly.
 *
 * Second, and less obvious: the dashboard and the workflow each resolve the
 * spec path from the issue body, with different code. The dashboard anchors on
 * the `Spec:` line after stripping code fences; the workflow greps the raw body
 * for the first path that exists on disk. Two resolvers that agree today drift
 * apart the moment either body format or either regex changes, and the failure
 * is silent: the gate approves one file while the agent implements another.
 * Running this against the path the workflow ACTUALLY resolved makes that
 * divergence harmless — whichever spec the workflow picked, it has to be one a
 * human approved.
 *
 * Required env (exactly one of the following two — never both, never neither):
 *   SPEC_PATH        The spec path the workflow resolved, relative to the
 *                    checkout. This must be the same value handed to the
 *                    implement agent, not a re-derivation of it.
 *   STORY_PATH       The sharded story path the workflow resolved, relative
 *                    to the checkout, when the issue is a story-level unit of
 *                    work rather than a program-level spec. Same "same value
 *                    handed to the implement agent" requirement as SPEC_PATH.
 *
 * An issue is one kind or the other. Setting both is refused as a usage
 * error rather than guessed at, because guessing which one to honour is how
 * the wrong document ends up approved.
 *
 * Optional env:
 *   PLAN_PATH        The resolved plan path. Empty or unset means no plan.
 *                     Only consulted alongside SPEC_PATH; a story carries no
 *                     separate plan of its own.
 *   ISSUE_LABELS     Newline- or comma-separated issue labels, checked for
 *                    the `spec-approval:override` escape hatch.
 *   REPO_ROOT        Checkout root the paths are relative to. Defaults to cwd.
 *
 * Output: a one-line verdict to stdout, and the full reason to stderr.
 * Exit code: 0 when the run may proceed, 1 when it may not, 2 on a usage error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OVERRIDE_LABEL,
  approvalPathForSpec,
  dispatchGateDecision,
  hashSpecAndPlan,
  type DispatchGateDecision,
} from '../spec-approval';
import {
  approvalPathForStory,
  canonicalStoryPath,
  hashStory,
  storyDispatchGateDecision,
} from '../story-approval';

/** Inputs for one verification, already resolved from env. */
export interface VerifyApprovalInput {
  specPath: string;
  planPath: string | null;
  labels: string[];
  repoRoot: string;
}

/**
 * Read a repo-relative file, or null when it is not on this checkout.
 *
 * @param repoRoot - Checkout root.
 * @param rel - Repo-relative path.
 * @returns The file's text, or null when absent.
 */
function readOrNull(repoRoot: string, rel: string): string | null {
  const abs = resolve(repoRoot, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

/**
 * Decide whether this checkout's spec is approved for implementation.
 *
 * A spec that is not on the checkout refuses rather than throws, so the
 * workflow's placeholder-spec fallback cannot slip through as "nothing to
 * check".
 *
 * @param input - Resolved paths, labels, and checkout root.
 * @returns The gate decision.
 */
export function verifyApproval(input: VerifyApprovalInput): DispatchGateDecision {
  const { specPath, planPath, labels, repoRoot } = input;
  const overrideRequested = labels.includes(OVERRIDE_LABEL);

  const specText = readOrNull(repoRoot, specPath);
  if (specText === null) {
    return {
      allow: overrideRequested,
      reason: overrideRequested ? 'override' : 'missing',
      message: `${specPath} is not on this checkout, so there is no approved text to implement.`,
    };
  }

  const planText = planPath === null ? null : readOrNull(repoRoot, planPath);
  if (planPath !== null && planText === null) {
    return {
      allow: overrideRequested,
      reason: overrideRequested ? 'override' : 'missing',
      message: `${planPath} is not on this checkout, so the approved plan cannot be verified.`,
    };
  }

  return dispatchGateDecision({
    approvalRaw: readOrNull(repoRoot, approvalPathForSpec(specPath)),
    currentSpecHash: hashSpecAndPlan(specText, planText),
    specPath,
    planPath,
    overrideRequested,
  });
}

/** Inputs for one story verification, already resolved from env. */
export interface VerifyStoryApprovalInput {
  storyPath: string;
  labels: string[];
  repoRoot: string;
}

/**
 * Decide whether this checkout's story is approved for implementation.
 *
 * Mirrors `verifyApproval` above: a story not on the checkout refuses rather
 * than throws, so a missing file cannot slip through as "nothing to check".
 * Unlike the spec path, there is no plan to also read — a sharded story
 * carries no plan of its own — and `storyDispatchGateDecision` never
 * consults the story's source spec, so one late amendment to a program spec
 * cannot invalidate a story already approved against it.
 *
 * @param input - Resolved story path, labels, and checkout root.
 * @returns The gate decision.
 */
export function verifyStoryApproval(input: VerifyStoryApprovalInput): DispatchGateDecision {
  const { labels, repoRoot } = input;
  // Same canonicalisation the dashboard's parser applies and the approval
  // command already applied when it wrote the record, so all three readers
  // compare one spelling.
  const storyPath = canonicalStoryPath(input.storyPath);
  const overrideRequested = labels.includes(OVERRIDE_LABEL);

  const storyText = readOrNull(repoRoot, storyPath);
  if (storyText === null) {
    // Not overridable, unlike every other refusal on this path. The override
    // authorises dispatch past a problem with the RECORD; it cannot supply the
    // document the agent must read. The implement workflow's story resolution
    // exits before this check is ever reached when the story is absent, so
    // honouring the label here would only disagree with the step above it —
    // and with the dashboard gate, which refuses the same case.
    return {
      allow: false,
      reason: 'missing',
      message:
        `${storyPath} is not on this checkout, so there is no approved text to implement. ` +
        'The override label does not apply: it authorises dispatch past an approval problem, ' +
        'not past a story that is not there.',
    };
  }

  return storyDispatchGateDecision({
    approvalRaw: readOrNull(repoRoot, approvalPathForStory(storyPath)),
    currentStoryHash: hashStory(storyText),
    storyPath,
    overrideRequested,
  });
}

/**
 * Split a labels env value on newlines or commas.
 *
 * @param raw - The raw env value, possibly unset.
 * @returns Trimmed, non-empty label names.
 */
export function parseLabels(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/**
 * CLI entry point: verify, report, and set the exit code.
 *
 * @returns Nothing; exits the process.
 */
function main(): void {
  const specPath = process.env.SPEC_PATH?.trim() || undefined;
  const storyPath = process.env.STORY_PATH?.trim() || undefined;

  if (specPath && storyPath) {
    throw new Error(
      `SPEC_PATH and STORY_PATH are mutually exclusive, but both are set ` +
        `(SPEC_PATH=${specPath}, STORY_PATH=${storyPath}). An issue is one kind or the ` +
        'other; guessing which to honour is how the wrong document gets approved.',
    );
  }
  if (!specPath && !storyPath) {
    throw new Error('one of SPEC_PATH or STORY_PATH is required');
  }

  const repoRoot = process.env.REPO_ROOT ?? process.cwd();
  const labels = parseLabels(process.env.ISSUE_LABELS);

  let decision: DispatchGateDecision;
  if (storyPath) {
    decision = verifyStoryApproval({ storyPath, labels, repoRoot });
  } else if (specPath) {
    decision = verifyApproval({
      specPath,
      planPath: process.env.PLAN_PATH?.trim() || null,
      labels,
      repoRoot,
    });
  } else {
    // Unreachable: the mutual-exclusivity checks above have already thrown
    // for every other combination of specPath/storyPath, so this branch
    // exists only to let TypeScript prove `decision` is always assigned.
    throw new Error('unreachable: neither SPEC_PATH nor STORY_PATH was set');
  }

  process.stderr.write(`${decision.message}\n`);
  process.stdout.write(`${decision.allow ? 'approved' : 'refused'} (${decision.reason})\n`);
  process.exit(decision.allow ? 0 : 1);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `verify-approval failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}
