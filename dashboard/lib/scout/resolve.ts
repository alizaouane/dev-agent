import 'server-only';

import type { Octokit } from '@octokit/rest';

import { parseRepoFromProposalId } from './snooze';

/**
 * Per-source `Resolve` action backend for `/proposals`.
 *
 * Snooze lets the user say "not now"; Resolve lets them say "I'm done
 * with this — drop it forever." Without Resolve, plan-checkbox items
 * accumulate forever in the queue (the user has to manually open the
 * file in GitHub, flip `[ ]` → `[x]`, commit) — most don't, so triage
 * compounds even when work shipped.
 *
 * **Routing.** Each proposal id has shape `<source>:<owner>/<repo>:<key>`.
 * The source segment determines the resolution strategy:
 *
 *   - `unfinished_plan` (per-item: `...#L<n>`) → flip the checkbox in
 *     the underlying file via Octokit commit.
 *   - `pending_spec` → file a `state:scoping` user-intent issue
 *     referencing the spec; the user can then take it through the
 *     normal pipeline.
 *   - `bug_scout_finding` / `unfinished_work_finding` / `untriaged_issue`
 *     (all issue-backed) → close the underlying issue with an audit
 *     comment.
 *
 * **Deferred to v2.** Rolled-up `unfinished_plan` (whole-file), `spec_drift`,
 * and `competitor_watch`. The action throws a friendly "use snooze
 * instead" error for those — the form just snoozes long-term.
 *
 * Caller's responsibility: assert write permission BEFORE calling
 * any of these. The resolvers themselves don't gate.
 */

export type ResolveContext = {
  proposalId: string;
  /** Username invoking the resolve, for audit-comment attribution. */
  username: string;
  /**
   * Source-specific metadata the proposal originally carried, passed
   * back via hidden form inputs. Different sources need different
   * fields; the union is intentional.
   */
  meta: {
    plan_file?: string;
    line?: number;
    spec_path?: string;
  };
};

export type ResolveOutcome = {
  /** Short label for the audit log / toast. */
  kind: 'plan_checkbox_flipped' | 'spec_filed_as_issue' | 'issue_closed' | 'unsupported';
  /** Human-readable summary. */
  description: string;
};

export async function resolveProposal(
  octokit: Octokit,
  ctx: ResolveContext,
): Promise<ResolveOutcome> {
  const route = parseRepoFromProposalId(ctx.proposalId);
  if (!route) {
    throw new Error(
      `cannot resolve: proposal id "${ctx.proposalId}" doesn't include owner/repo`,
    );
  }
  const { owner, repo } = route;

  const sourceMatch = ctx.proposalId.match(/^([a-z_]+):/);
  if (!sourceMatch) {
    throw new Error(`cannot resolve: proposal id "${ctx.proposalId}" has no source prefix`);
  }
  const source = sourceMatch[1];

  switch (source) {
    case 'unfinished_plan':
      return resolveUnfinishedPlan(octokit, owner, repo, ctx);
    case 'pending_spec':
      return resolvePendingSpec(octokit, owner, repo, ctx);
    case 'bug_scout_finding':
    case 'unfinished_work_finding':
    case 'untriaged_issue':
      return resolveIssueBacked(octokit, owner, repo, ctx, source);
    default:
      // Unsupported sources fall through to a friendly error so the UI
      // can render "Use 'Snooze 7d' instead — Resolve isn't wired for
      // <source> yet."
      throw new Error(
        `Resolve isn't wired for source "${source}" yet. Use Snooze instead, or close the underlying artifact manually.`,
      );
  }
}

// ---------------------------------------------------------------------
// Per-source resolvers
// ---------------------------------------------------------------------

/**
 * Flip `- [ ]` (or `* [ ]` / `1. [ ]`) to `[x]` at the proposal's line.
 * Mirrors the bullet-marker set the plans scout's `parseUncheckedItems`
 * accepts so we don't refuse to resolve proposals it surfaces.
 *
 * Idempotent: if the line is already `[x]` (someone resolved it via
 * GitHub directly between scout pass and Resolve click), returns
 * success with a noop description. We don't surface this as an error
 * because the user-visible outcome — "this proposal is gone" — is
 * what they wanted.
 */
async function resolveUnfinishedPlan(
  octokit: Octokit,
  owner: string,
  repo: string,
  ctx: ResolveContext,
): Promise<ResolveOutcome> {
  // Rolled-up entries (no `#L<n>` in the id) cover N items; flipping
  // all `[ ]` in the file would over-resolve. Refuse with a friendly
  // error.
  if (!ctx.proposalId.includes('#L')) {
    throw new Error(
      'Resolve is per-line. This is a rolled-up entry (5+ items in one file). Click the link to open the file and check items individually, or use Snooze.',
    );
  }
  const planFile = ctx.meta.plan_file;
  const line = ctx.meta.line;
  if (!planFile || typeof line !== 'number') {
    throw new Error(
      `Resolve needs plan_file + line in form data. Got plan_file=${String(planFile)}, line=${String(line)}.`,
    );
  }

  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  const fileResp = await octokit.repos.getContent({
    owner,
    repo,
    path: planFile,
    ref: default_branch,
  });
  const data = fileResp.data as { content?: string; encoding?: string; sha?: string; type?: string };
  if (data.type !== 'file' || !data.content || data.encoding !== 'base64') {
    throw new Error(`plan file ${planFile} is not a regular file`);
  }
  const raw = Buffer.from(data.content, 'base64').toString('utf8');
  const lines = raw.split('\n');
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) {
    throw new Error(`line ${line} is out of range for ${planFile} (file has ${lines.length} lines)`);
  }

  // Flip `- [ ]` / `* [ ]` / `1. [ ]` → ...`[x]`. Preserve indentation
  // and the rest of the line verbatim. Idempotent: already-checked
  // lines are a no-op success.
  const original = lines[idx];
  const uncheckedRe = /^(\s*(?:[-*]|\d+\.)\s+)\[\s\](\s+.+)$/;
  const checkedRe = /^(\s*(?:[-*]|\d+\.)\s+)\[[xX]\](\s+.+)$/;
  if (checkedRe.test(original)) {
    return {
      kind: 'plan_checkbox_flipped',
      description: `Already checked: ${planFile}:${line}`,
    };
  }
  const flipped = original.replace(uncheckedRe, '$1[x]$2');
  if (flipped === original) {
    throw new Error(
      `Line ${line} of ${planFile} doesn't look like an unchecked checkbox. Got: ${original.slice(0, 80)}…`,
    );
  }
  lines[idx] = flipped;

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: planFile,
    message: `chore(dev-agent): mark plan item done — ${planFile}:${line} (resolved by @${ctx.username} via /proposals)`,
    content: Buffer.from(lines.join('\n'), 'utf8').toString('base64'),
    sha: data.sha,
  });

  return {
    kind: 'plan_checkbox_flipped',
    description: `Checked off ${planFile}:${line}`,
  };
}

/**
 * Promote a pending spec to a tracked feature: file a new issue with
 * the spec content as the body, labels `kind:user-intent` +
 * `state:scoping`. The user (or the implement workflow) takes it from
 * there. The spec file itself is unchanged — it's still the source of
 * truth; the issue is just the tracking handle.
 */
async function resolvePendingSpec(
  octokit: Octokit,
  owner: string,
  repo: string,
  ctx: ResolveContext,
): Promise<ResolveOutcome> {
  const specPath = ctx.meta.spec_path;
  if (!specPath) {
    throw new Error('Resolve needs spec_path in form data for pending_spec sources.');
  }

  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  // Pull the spec's H1 as the issue title (or fall back to the slug).
  let title = ctx.proposalId.split(':').pop() ?? specPath;
  try {
    const fileResp = await octokit.repos.getContent({
      owner,
      repo,
      path: specPath,
      ref: default_branch,
    });
    const data = fileResp.data as { content?: string; encoding?: string };
    if (data.content && data.encoding === 'base64') {
      const raw = Buffer.from(data.content, 'base64').toString('utf8');
      const h1 = raw.match(/^#\s+(.+?)\s*$/m);
      if (h1) title = h1[1].trim();
    }
  } catch {
    // Fall back to slug; non-fatal.
  }

  const body = [
    `Tracking issue for spec at \`${specPath}\`.`,
    '',
    `Filed by @${ctx.username} via the dashboard's Resolve action on /proposals.`,
    '',
    `**Next:** the implement workflow consumes the spec at the path above. Approve via the dashboard's PM brainstorm flow, or run \`gh workflow run dev-agent.yml -f phase=implement -f issue_number=<this issue>\` once you're ready.`,
  ].join('\n');

  const issue = await octokit.issues.create({
    owner,
    repo,
    title: title.slice(0, 100),
    body,
    labels: ['kind:user-intent', 'state:scoping'],
  });

  return {
    kind: 'spec_filed_as_issue',
    description: `Filed issue #${issue.data.number} tracking ${specPath}`,
  };
}

/**
 * Close an issue-backed proposal (bug-scout / unfinished-work / untriaged)
 * with an audit comment. The dashboard scouts filter on `state:proposed`
 * (or on no-state-label for untriaged), so a closed issue automatically
 * stops appearing.
 *
 * Idempotent: re-running on an already-closed issue is a no-op (we still
 * post the comment so the audit trail records the click).
 */
async function resolveIssueBacked(
  octokit: Octokit,
  owner: string,
  repo: string,
  ctx: ResolveContext,
  source: string,
): Promise<ResolveOutcome> {
  // Issue-backed ids end in `:<number>`. Parse the trailing segment.
  const issueMatch = ctx.proposalId.match(/:(\d+)$/);
  if (!issueMatch) {
    throw new Error(
      `cannot resolve: ${source} id "${ctx.proposalId}" doesn't end with :<issue-number>`,
    );
  }
  const issue_number = parseInt(issueMatch[1], 10);

  const sourceLabel = source.replace(/_/g, '-');
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number,
    body: `🛂 Resolved by @${ctx.username} via the dashboard /proposals page (${sourceLabel}).`,
  });
  await octokit.issues.update({
    owner,
    repo,
    issue_number,
    state: 'closed',
    state_reason: 'completed',
  });

  return {
    kind: 'issue_closed',
    description: `Closed issue #${issue_number}`,
  };
}
