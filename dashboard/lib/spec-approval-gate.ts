import 'server-only';

import type { Octokit } from '@octokit/rest';

import {
  OVERRIDE_LABEL,
  approvalPathForSpec,
  dispatchGateDecision,
  hashSpecAndPlan,
  resolveRefusal,
  type DispatchGateDecision,
} from '@/lib/spec-approval';

/**
 * Server-side half of the spec-approval gate: fetch the three documents the
 * decision needs from the consumer repo, then hand them to the pure decision
 * function in `@/lib/spec-approval`.
 *
 * Kept apart from `actions.ts` so the network shape and the policy stay
 * separately testable — the policy has no Octokit in it, and this file has no
 * branching logic in it beyond fail-closed error handling.
 */

/** Spec and plan paths as declared in an issue body. */
export interface SpecRefs {
  spec_path: string;
  /** Null on the quick-dev route, whose issues carry a spec and no plan. */
  plan_path: string | null;
}

/**
 * Pull the `Spec:` and `Plan:` paths out of a handoff issue body.
 *
 * Fenced code blocks and inline backtick spans are stripped first, matching
 * what the tier2-smoke workflow does when it resolves the same paths: a stale
 * path quoted inside an example must not outrank the canonical link.
 *
 * The `Plan:` line is optional: quick-dev files a spec with no plan. A missing
 * `Spec:` line is fatal, because there is then nothing to check an approval
 * against.
 *
 * @param body - The issue body, or null for an empty issue.
 * @returns The declared paths, or null when no `Spec:` line is present.
 */
export function parseSpecRefs(body: string | null | undefined): SpecRefs | null {
  if (!body) return null;
  const cleaned = body
    .split('\n')
    .reduce<{ out: string[]; skip: boolean }>(
      (acc, line) => {
        if (/^ {0,3}(```|~~~)/.test(line)) return { out: acc.out, skip: !acc.skip };
        if (!acc.skip) acc.out.push(line);
        return acc;
      },
      { out: [], skip: false },
    )
    .out.join('\n')
    .replace(/`[^`]*`/g, '');

  const spec = cleaned.match(/^\s*Spec:\s*(\S+\.md)\s*$/m)?.[1];
  if (!spec) return null;
  const plan = cleaned.match(/^\s*Plan:\s*(\S+\.md)\s*$/m)?.[1];
  return { spec_path: spec, plan_path: plan ?? null };
}

/**
 * Read a repo file's contents at a ref.
 *
 * @returns The decoded text, or null when the path does not exist (404).
 * @throws On any non-404 API error — an unreadable repo must not read as an
 *   absent approval, which would be indistinguishable from an unapproved spec
 *   only by luck.
 */
async function fetchText(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || !('content' in data)) return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/**
 * Decide whether an issue's spec is approved for implementation.
 *
 * Fails closed on every path it cannot complete: an issue with no spec link, a
 * spec or plan missing from the branch, or an API error all refuse rather than
 * fall through to a dispatch.
 *
 * @param input.octokit - Authenticated client for the consumer repo.
 * @param input.owner - Repo owner.
 * @param input.repo - Repo name.
 * @param input.ref - Branch the implement run would use.
 * @param input.issueBody - Body of the handoff issue.
 * @param input.labels - The issue's labels, checked for the override label.
 * @returns The gate decision, ready to surface to the operator.
 */
export async function evaluateSpecApproval(input: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  issueBody: string | null | undefined;
  labels: string[];
}): Promise<DispatchGateDecision> {
  const { octokit, owner, repo, ref, issueBody, labels } = input;
  const overrideRequested = labels.includes(OVERRIDE_LABEL);

  const refs = parseSpecRefs(issueBody);
  if (!refs) {
    return resolveRefusal(
      'missing',
      'the issue body has no `Spec:` line, so there is nothing to check an approval ' +
        'against. File the issue through the intake session, which writes the link.',
      overrideRequested,
    );
  }

  let specText: string | null;
  let planText: string | null;
  let approvalRaw: string | null;
  try {
    [specText, planText, approvalRaw] = await Promise.all([
      fetchText(octokit, owner, repo, refs.spec_path, ref),
      refs.plan_path === null
        ? Promise.resolve(null)
        : fetchText(octokit, owner, repo, refs.plan_path, ref),
      fetchText(octokit, owner, repo, approvalPathForSpec(refs.spec_path), ref),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return resolveRefusal(
      'malformed',
      `could not read the spec, plan, or approval from ${owner}/${repo}@${ref}: ${detail}`,
      overrideRequested,
    );
  }

  if (specText === null || (refs.plan_path !== null && planText === null)) {
    const missing = specText === null ? refs.spec_path : refs.plan_path;
    return resolveRefusal(
      'missing',
      `${missing} is not on ${ref}, so the approved text cannot be verified. Push the spec ` +
        'and plan to the branch the implement run will use.',
      overrideRequested,
    );
  }

  return dispatchGateDecision({
    approvalRaw,
    currentSpecHash: hashSpecAndPlan(specText, planText),
    specPath: refs.spec_path,
    planPath: refs.plan_path,
    overrideRequested,
  });
}
