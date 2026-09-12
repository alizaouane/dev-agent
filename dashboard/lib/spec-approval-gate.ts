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
import { approvalPathForStory, hashStory, storyDispatchGateDecision } from '@/lib/story-approval';

/**
 * Server-side half of the spec-approval gate: fetch the three documents the
 * decision needs from the consumer repo, then hand them to the pure decision
 * function in `@/lib/spec-approval`.
 *
 * Kept apart from `actions.ts` so the network shape and the policy stay
 * separately testable — the policy has no Octokit in it, and this file has no
 * branching logic in it beyond fail-closed error handling.
 */

/**
 * Strip fenced blocks and inline backtick spans from an issue body.
 *
 * Both reference parsers run against this, so a path quoted inside an example
 * cannot outrank the canonical link — and, more importantly, cannot differ
 * between the two parsers.
 *
 * Only fences that actually close are stripped. A stray opener with no
 * partner would otherwise swallow the rest of the body, including the real
 * reference.
 *
 * @param body - The issue body.
 * @returns The body with quoted regions removed.
 */
function stripQuotedRegions(body: string): string {
  const lines = body.split(/\r?\n/);
  const fences = lines.flatMap((line, i) => (/^ {0,3}(```|~~~)/.test(line) ? [i] : []));
  const stripped = new Set<number>();
  for (let i = 0; i + 1 < fences.length; i += 2) {
    for (let n = fences[i]; n <= fences[i + 1]; n++) stripped.add(n);
  }
  return lines
    .filter((_line, i) => !stripped.has(i))
    .join('\n')
    .replace(/`[^`]*`/g, '');
}

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
  const cleaned = stripQuotedRegions(body);

  const spec = cleaned.match(/^\s*Spec:\s*(\S+\.md)\s*$/m)?.[1];
  if (!spec) return null;
  const plan = cleaned.match(/^\s*Plan:\s*(\S+\.md)\s*$/m)?.[1];
  return { spec_path: spec, plan_path: plan ?? null };
}

/** The story a handoff issue declares. */
export interface StoryRef {
  /** Repo-relative path to the story. */
  story_path: string;
}

/**
 * Pull the `Story:` path out of a handoff issue body.
 *
 * A story-based issue carries `Story:` where a spec-based issue carries
 * `Spec:` and `Plan:`. The gate branches on which is present, so this
 * returning null is how a spec issue is recognised, not an error.
 *
 * @param body - The issue body, or null for an empty issue.
 * @returns The declared story, or null when there is no `Story:` line.
 */
export function parseStoryRef(body: string | null | undefined): StoryRef | null {
  if (!body) return null;
  const story = stripQuotedRegions(body).match(/^\s*Story:\s*(\S+\.md)\s*$/m)?.[1];
  return story ? { story_path: story } : null;
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

  // A story-based issue is checked against the story alone. Its source spec
  // was a precondition when the story was approved and is lineage afterwards,
  // so re-reading it here would let one late amendment to a program spec
  // invalidate every story derived from it.
  const storyRef = parseStoryRef(issueBody);
  if (storyRef) {
    const storyText = await fetchText(octokit, owner, repo, storyRef.story_path, ref);
    if (storyText === null) {
      return resolveRefusal(
        'missing',
        `the issue names ${storyRef.story_path}, which is not on ${ref}. Check the story ` +
          'was committed before the issue was filed.',
        overrideRequested,
      );
    }
    const approvalRaw = await fetchText(
      octokit, owner, repo, approvalPathForStory(storyRef.story_path), ref,
    );
    return storyDispatchGateDecision({
      approvalRaw,
      currentStoryHash: hashStory(storyText),
      storyPath: storyRef.story_path,
      overrideRequested,
    });
  }

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
