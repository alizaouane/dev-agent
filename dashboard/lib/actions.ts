'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Octokit } from '@octokit/rest';

import { getOctokit, getCurrentUsername } from './gh';
import { ForbiddenError } from './errors';
import { WIRE_UP_FILES } from './wire-up-template';
import { pushRepoSecret } from './gh-secrets';
import { snoozeProposalId, unsnoozeProposalId } from './scout/snooze';
import { evictRecommendationsForUser } from './next-cache';
import {
  SCHEDULE_PRESETS,
  writeBugScoutSchedule,
  type SchedulePreset,
} from './bug-scout-schedule';
import { appendApprovedScopeEntry } from './session-log';

/**
 * Extract the "Agreed scope" section from the PM agent's final message.
 * Tolerant of minor PM-emission variations:
 *   - 2+ leading hashes (`##`, `###`)
 *   - case insensitive (`Agreed Scope`, `AGREED SCOPE`)
 *   - optional trailing punctuation (`Agreed scope:`, `Agreed scope.`)
 *   - extra whitespace around the heading
 *
 * Body extraction stops at the next `## `-or-deeper heading so a later
 * `## pm.md update` block doesn't get accidentally swallowed into the
 * scope. Returns null if no such section is present.
 */
function extractAgreedScope(pmMessage: string): string | null {
  const headingRe = /^#{2,}\s*Agreed\s+Scope\s*[:\-—]?\s*$/im;
  const headingMatch = pmMessage.match(headingRe);
  if (!headingMatch || headingMatch.index === undefined) return null;
  const after = pmMessage.slice(headingMatch.index + headingMatch[0].length);
  // Stop at the next H2-or-deeper heading (so unrelated trailing
  // sections like `## pm.md update` don't bleed into the scope).
  const stopMatch = after.match(/^#{2,}\s+\S/m);
  const body = (stopMatch && stopMatch.index !== undefined ? after.slice(0, stopMatch.index) : after).trim();
  return body.length > 0 ? body : null;
}

/**
 * Verify `username` has at least `write` permission on `owner/repo`. Uses
 * `repos.getCollaboratorPermissionLevel` — the canonical GH API for this
 * check — which returns one of `admin | maintain | write | triage | read | none`.
 *
 * Internal helper: every server action calls this BEFORE mutating, so a
 * read-only collaborator (or someone who only has access via a fork) cannot
 * drive the pipeline.
 *
 * @throws ForbiddenError if the user's permission level is below `write`.
 */
async function assertWritePermission(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string,
): Promise<void> {
  const perm = await octokit.repos.getCollaboratorPermissionLevel({ owner, repo, username });
  const level = perm.data.permission;
  if (!['admin', 'maintain', 'write'].includes(level)) {
    throw new ForbiddenError(
      `User ${username} lacks write permission on ${owner}/${repo} (has: ${level})`,
    );
  }
}

/**
 * Server Action: create a new "user intent" issue in `owner/repo`, labelled
 * `kind:user-intent` + `state:scoping`, then redirect to its dashboard page.
 *
 * The issue body embeds the slash-command the user should run from inside
 * their repo's Claude Code session to kick off the spec brainstorm — there is
 * no automated handoff yet, by design.
 *
 * Form fields:
 *  - `repo`   — `owner/name` (required)
 *  - `intent` — free-text intent (required, used as title + body)
 *
 * @throws Error on bad form input
 * @throws UnauthorizedError if no session
 * @throws ForbiddenError if user lacks write perm on the target repo
 */
export async function dropIntent(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = (formData.get('repo') as string).trim();
  const intent = (formData.get('intent') as string).trim();
  if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
  if (!intent) throw new Error('intent cannot be empty');
  const [owner, repo] = repoFull.split('/');
  await assertWritePermission(octokit, owner, repo, session_username);

  const body = `${intent}\n\n---\n\n**Next step:** the spec brainstorm is an interactive session in Claude Code.\nFrom the \`${repoFull}\` repo, run:\n\n\`\`\`\n/develop https://github.com/${owner}/${repo}/issues/<this-issue-number>\n\`\`\``;
  const created = await octokit.issues.create({
    owner,
    repo,
    title: intent.slice(0, 100),
    body,
    labels: ['kind:user-intent', 'state:scoping'],
  });
  revalidatePath('/');
  redirect(`/features/${created.data.number}?repo=${encodeURIComponent(repoFull)}`);
}

/**
 * Server Action: advance an issue through a human-approval gate by flipping
 * its `state:*` label and posting an audit comment.
 *
 * Allowed transitions:
 *  - `state:ready-to-promote` → `state:promoting`   (when `promote=1`)
 *  - `state:spec-ready`       → `state:implementing`
 *  - `state:pr-review`        → `state:staging-deployed`
 *
 * Any other current state — or `promote=1` from a non-promote-ready state —
 * is a 4xx-equivalent: we throw rather than silently no-op, so the UI can
 * surface "you cannot approve from this state" instead of leaving the user
 * wondering why nothing happened.
 *
 * Form fields:
 *  - `repo`    — `owner/name`
 *  - `issue`   — issue number (string, parsed)
 *  - `promote` — `'1'` to use the promote gate, anything else for non-promote
 */
export async function approveGate(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = formData.get('repo') as string;
  const issueStr = formData.get('issue') as string;
  const promote = formData.get('promote') === '1';
  const [owner, repo] = repoFull.split('/');
  const issue_number = parseInt(issueStr, 10);
  await assertWritePermission(octokit, owner, repo, session_username);

  const issue = await octokit.issues.get({ owner, repo, issue_number });
  const labels = issue.data.labels
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter(Boolean) as string[];
  const currentState = labels.find((l) => l.startsWith('state:'));
  if (!currentState) throw new Error('issue has no state:* label');

  let nextState: string | null = null;
  if (promote && currentState === 'state:ready-to-promote') nextState = 'state:promoting';
  else if (!promote && currentState === 'state:spec-ready') nextState = 'state:implementing';
  else if (!promote && currentState === 'state:pr-review') nextState = 'state:staging-deployed';
  if (!nextState) throw new Error(`cannot ${promote ? 'promote' : 'approve'} from ${currentState}`);

  const newLabels = labels.filter((l) => !l.startsWith('state:')).concat(nextState);
  await octokit.issues.setLabels({ owner, repo, issue_number, labels: newLabels });
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number,
    body: `🛂 Approved at ${promote ? '\`--promote\`' : 'gate'} by @${session_username} at ${new Date().toISOString()}.`,
  });

  revalidatePath('/');
  revalidatePath(`/features/${issue_number}`);
}

/**
 * Server Action: mark an issue as abandoned (label flip to `state:abandoned`,
 * audit comment, then close). Idempotent-ish: re-running on an already-closed
 * abandoned issue is a no-op label set + duplicate comment.
 *
 * Form fields:
 *  - `repo`   — `owner/name`
 *  - `issue`  — issue number
 *  - `reason` — optional free-text reason (defaults to `unspecified`)
 */
export async function abandonFeature(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = formData.get('repo') as string;
  const issue_number = parseInt(formData.get('issue') as string, 10);
  const reason = (formData.get('reason') as string | null) ?? '';
  const [owner, repo] = repoFull.split('/');
  await assertWritePermission(octokit, owner, repo, session_username);

  const issue = await octokit.issues.get({ owner, repo, issue_number });
  const labels = issue.data.labels
    .map((l) => (typeof l === 'string' ? l : l.name))
    .filter(Boolean) as string[];
  const newLabels = labels.filter((l) => !l.startsWith('state:')).concat('state:abandoned');
  await octokit.issues.setLabels({ owner, repo, issue_number, labels: newLabels });
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number,
    body: `🚫 Abandoned by @${session_username} at ${new Date().toISOString()}. Reason: ${reason || 'unspecified'}.`,
  });
  await octokit.issues.update({ owner, repo, issue_number, state: 'closed' });

  revalidatePath('/');
  revalidatePath(`/features/${issue_number}`);
}

/**
 * Server Action: dispatch the `phase-rollback.yml` workflow on the
 * consumer's default branch for a given issue, then post an audit
 * comment so the timeline records who triggered it.
 *
 * Inputs are typed by the workflow's `workflow_dispatch.inputs` schema, so
 * this is not a shell-injection vector — the workflow consumes them as
 * named inputs, not interpolated into a command line.
 *
 * Form fields:
 *  - `repo`  — `owner/name`
 *  - `issue` — issue number
 */
export async function dispatchRollback(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = formData.get('repo') as string;
  const issue_number = parseInt(formData.get('issue') as string, 10);
  const [owner, repo] = repoFull.split('/');
  await assertWritePermission(octokit, owner, repo, session_username);

  // Dispatch on the consumer's actual default branch (which is staging
  // in the dev-agent two-branch model). Hardcoding `'main'` here used to
  // 404 on any consumer whose default branch was named anything else.
  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: 'phase-rollback.yml',
    ref: default_branch,
    inputs: { issue_number: String(issue_number), invocation_mode: 'live' },
  });
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number,
    body: `🔁 Rollback dispatched by @${session_username} at ${new Date().toISOString()}.`,
  });

  revalidatePath('/');
  revalidatePath(`/features/${issue_number}`);
}

/**
 * Server Action: wire up dev-agent on `owner/repo` by committing the
 * onboarding files directly to the default branch.
 *
 * Files dropped:
 *  - .dev-agent.yml
 *  - .github/workflows/dev-agent.yml
 *  - .dev-agent/pm.md
 *
 * Flow:
 *  1. Verify the user has write permission.
 *  2. Pre-check: if .dev-agent.yml already exists on the default
 *     branch, bail out (the repo is already wired up).
 *  3. Push the dashboard's ANTHROPIC_API_KEY into the consumer's
 *     Actions secrets (if the dashboard env has it).
 *  4. Commit each WIRE_UP_FILES entry directly to the default branch.
 *     `createOrUpdateFileContents` without a `branch` arg targets the
 *     repo default; it also handles the empty-repo case by creating
 *     the initial commit + branch ref.
 *  5. Redirect back to /repos so the user lands somewhere actionable
 *     in the dashboard, not on a github.com page.
 *
 * **No PR is opened.** The wire-up files are well-tested in the
 * engine repo, the user is the only reviewer, and a PR for two
 * config files just adds friction. If the consumer's default branch
 * is protected (requires PRs), `createOrUpdateFileContents` will 422
 * and the error surfaces in the wire-up button's inline error state
 * — the user can either relax protection or manually drop the
 * template files from `examples/web-app-template/`.
 *
 * Form fields:
 *  - `owner` — repo owner (org or user)
 *  - `repo`  — repo name
 *  - `default_branch` — defaults to `main` if absent
 *
 * @throws Error if the repo already has .dev-agent.yml on the default branch.
 * @throws ForbiddenError if user lacks write perm.
 */
export async function wireUpRepo(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const owner = (formData.get('owner') as string).trim();
  const repo = (formData.get('repo') as string).trim();
  const default_branch = (formData.get('default_branch') as string)?.trim() || 'main';

  if (!owner || !repo) throw new Error('owner and repo are required');
  await assertWritePermission(octokit, owner, repo, session_username);

  // Defensive: if the repo already has .dev-agent.yml on its default branch,
  // bail out. /repos derives `wired_up` server-side so this is mostly a
  // TOCTOU guard.
  try {
    await octokit.repos.getContent({ owner, repo, path: '.dev-agent.yml', ref: default_branch });
    throw new Error(`${owner}/${repo} is already wired up`);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404) throw err;
    // 404 is the happy path: file doesn't exist, proceed.
  }

  // Push the dashboard's ANTHROPIC_API_KEY into the consumer repo's Actions
  // secrets so the user doesn't have to paste it manually. Failures (e.g.,
  // user has write but not admin perm — secrets require admin) are non-
  // fatal; we log and continue. The user will see a workflow run fail later
  // with a missing-secret error if push didn't succeed.
  const dashboardKey = process.env.ANTHROPIC_API_KEY;
  if (dashboardKey) {
    try {
      await pushRepoSecret({
        octokit,
        owner,
        repo,
        name: 'ANTHROPIC_API_KEY',
        value: dashboardKey,
      });
    } catch (err) {
      console.warn(`wireUpRepo: pushRepoSecret failed for ${owner}/${repo}:`, err);
    }
  }

  // Direct-commit each template file to the default branch. Without a
  // `branch` arg, createOrUpdateFileContents targets the repo's default
  // and handles both populated and empty repos uniformly.
  // ESLint disable: per-file commits are intentionally serial — Octokit's
  // createOrUpdateFileContents takes a branch HEAD lock per call, so
  // parallel calls would race on the same branch ref.
  // eslint-disable-next-line no-restricted-syntax
  for (const f of WIRE_UP_FILES) {
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: f.path,
      message: `chore(dev-agent): add ${f.path}`,
      content: Buffer.from(f.content, 'utf8').toString('base64'),
    });
  }

  // Suppress "unused" on session_username — kept here in case we want to
  // audit-log the wire-up later.
  void session_username;

  revalidatePath('/repos');
  redirect('/repos');
}

/**
 * Server Action: end of the PM brainstorm chat. The user has agreed on a
 * scope and clicked "Approve and start." We:
 *
 *   1. Extract the "Agreed scope" section from the PM's final message;
 *      reject if missing (the chat hasn't converged yet).
 *   2. Verify write permission on the target repo.
 *   3. Create a GitHub issue carrying:
 *        - the scope as the body (the implement workflow uses the issue
 *          body as spec when no `docs/specs/<slug>.md` is linked — the
 *          drill issues already validate this path)
 *        - labels `kind:user-intent` + `state:implementing` (skipping
 *          state:scoping/state:spec-ready because we already converged).
 *   4. Dispatch `dev-agent.yml` on the consumer repo with phase=implement.
 *      The wrapper workflow (installed by wireUpRepo) forwards to the
 *      reusable phase-implement.yml@v1.
 *   5. Redirect to the dashboard's feature page so the user sees telemetry
 *      flow as the agent runs.
 *
 * Form fields:
 *  - `repo`           — owner/name of the wired-up consumer
 *  - `title`          — short feature title (used as the issue title)
 *  - `pm_final_message` — the PM agent's last message containing the
 *                         "## Agreed scope" block.
 */
export async function approveAndStart(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = (formData.get('repo') as string).trim();
  const title = ((formData.get('title') as string) ?? '').trim();
  const pmFinalMessage = ((formData.get('pm_final_message') as string) ?? '').trim();

  if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
  if (!title) throw new Error('title cannot be empty');
  const scope = extractAgreedScope(pmFinalMessage);
  if (!scope) {
    throw new Error(
      'no "## Agreed scope" section found in the PM\'s final message — the chat has not converged yet',
    );
  }

  const [owner, repo] = repoFull.split('/');
  await assertWritePermission(octokit, owner, repo, session_username);

  // Resolve the consumer's actual default branch BEFORE creating the
  // issue — that way if `repos.get` 403s (perms) or the repo is missing,
  // we fail fast without leaving an orphan issue. The default branch is
  // staging in the dev-agent two-branch model; hardcoding `'main'` used
  // to 404 the workflow_dispatch on any consumer that named theirs
  // differently (which was the production-blocking bug.)
  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  // Issue body doubles as the spec the implement agent reads. Phase 2a's
  // "spec_path = placeholder, treat issue body as spec" path handles the
  // missing docs/specs/<slug>.md case; we lean on that here.
  const issueBody = [
    `Approved by @${session_username} via the dashboard PM brainstorm.`,
    ``,
    `## Agreed scope`,
    ``,
    scope,
  ].join('\n');

  const issue = await octokit.issues.create({
    owner,
    repo,
    title: title.slice(0, 100),
    body: issueBody,
    labels: ['kind:user-intent', 'state:implementing'],
  });

  // Record the human decision in SESSION_LOG.md BEFORE dispatching the
  // workflow. If the workflow run later fails, the audit trail still
  // shows that the user approved scope X for issue #N at this time.
  // Best-effort — a 403 / rate-limit / network error here shouldn't
  // block the dispatch (the issue + workflow are the durable state;
  // the log is the human-readable mirror).
  try {
    await appendApprovedScopeEntry(octokit, owner, repo, default_branch, {
      issue: issue.data.number,
      approver: session_username,
      title: title.slice(0, 100),
      scope,
    });
  } catch (err) {
    console.warn(
      `approveAndStart: SESSION_LOG.md append failed for ${owner}/${repo}#${issue.data.number}:`,
      err,
    );
  }

  // Dispatch the consumer's wrapper workflow to start the implement phase.
  // The wrapper exposes phase as a `choice` input; we send phase=implement
  // and the new issue number.
  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: 'dev-agent.yml',
    ref: default_branch,
    inputs: {
      phase: 'implement',
      issue_number: String(issue.data.number),
      invocation_mode: 'live',
    },
  });

  revalidatePath('/');
  redirect(`/features/${issue.data.number}?repo=${encodeURIComponent(repoFull)}`);
}

/**
 * Server Action: open a PR replacing `.dev-agent/pm.md` with the PM's
 * proposed content. Compounds the PM's value over time — each
 * meaningful chat can leave the PM smarter for next time without the
 * user manually editing pm.md.
 *
 * Flow:
 *  1. Verify write permission on the target repo.
 *  2. Read the current pm.md (used to detect no-op updates and to
 *     anchor the PR description).
 *  3. Create branch `chore/pm-md-update-<timestamp>` off the default
 *     branch. Timestamp suffix avoids collisions when multiple chats
 *     produce updates within the same minute.
 *  4. Commit the new file content.
 *  5. Open a PR with body explaining what the PM proposed.
 *
 * Form fields:
 *  - `repo`        — `owner/name`
 *  - `new_content` — the full replacement file body (frontmatter + body)
 *  - `summary`     — one-line summary the PM provided alongside the
 *                    block, used as the PR title and commit message.
 *                    Optional; falls back to a generic title.
 *
 * @throws if `new_content` is empty after trimming
 * @throws ForbiddenError if user lacks write perm
 */
export async function applyPmMdUpdate(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = (formData.get('repo') as string).trim();
  const newContent = (formData.get('new_content') as string).trim();
  const summary = ((formData.get('summary') as string) ?? '').trim();

  if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
  if (!newContent) throw new Error('new_content is empty — nothing to apply');

  const [owner, repo] = repoFull.split('/');
  await assertWritePermission(octokit, owner, repo, session_username);

  // Resolve the default branch tip. If pm.md doesn't exist or the repo
  // is empty, the PR will create the file fresh.
  const repoInfo = await octokit.repos.get({ owner, repo });
  const default_branch = repoInfo.data.default_branch ?? 'main';
  const ref = await octokit.git.getRef({
    owner,
    repo,
    ref: `heads/${default_branch}`,
  });
  const tipSha = ref.data.object.sha;

  // Read the existing pm.md (if any) so the commit can be a true update
  // — createOrUpdateFileContents requires the current SHA when the file
  // already exists, otherwise it 422s.
  let existingSha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({
      owner,
      repo,
      path: '.dev-agent/pm.md',
      ref: default_branch,
    });
    if (!Array.isArray(existing.data) && 'sha' in existing.data) {
      existingSha = existing.data.sha as string;
    }
  } catch {
    // 404: file doesn't exist yet (e.g., wire-up PR still pending).
    // The commit below will create it.
  }

  // Branch name with a date suffix so concurrent updates don't collide
  // and so the PR list is naturally ordered.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branchName = `chore/pm-md-update-${stamp}`;

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: tipSha,
  });

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: '.dev-agent/pm.md',
    message: summary || 'chore(pm.md): update PM agent memory',
    content: Buffer.from(newContent, 'utf8').toString('base64'),
    branch: branchName,
    sha: existingSha,
  });

  const prBody = [
    `Updates \`.dev-agent/pm.md\` with content the PM agent proposed during a brainstorm chat.`,
    ``,
    `Triggered by @${session_username} from the dev-agent dashboard.`,
    ``,
    `Review the diff carefully — the PM's proposal reflects what it learned from the conversation, but you own the final state of pm.md.`,
  ].join('\n');

  const pr = await octokit.pulls.create({
    owner,
    repo,
    title: summary || 'chore(pm.md): update PM agent memory',
    head: branchName,
    base: default_branch,
    body: prBody,
  });

  redirect(pr.data.html_url);
}

/**
 * Server Action: snooze a proposal so it stops appearing on /proposals
 * for ~a week. In-memory store; no consumer-repo write.
 *
 * Form fields:
 *  - `proposal_id` — the stable id from the Proposal type
 */
export async function snoozeProposal(formData: FormData): Promise<void> {
  const username = await getCurrentUsername();
  const proposalId = ((formData.get('proposal_id') as string) ?? '').trim();
  if (!proposalId) throw new Error('proposal_id required');
  snoozeProposalId(username, proposalId);
  revalidatePath('/proposals');
}

/**
 * Server Action: undo a snooze (used by the "Show snoozed" view's
 * Un-snooze button). Idempotent — succeeds even if the entry doesn't
 * exist anymore (e.g., expired before the user clicked).
 *
 * Form fields:
 *  - `proposal_id`
 */
export async function unsnoozeProposal(formData: FormData): Promise<void> {
  const username = await getCurrentUsername();
  const proposalId = ((formData.get('proposal_id') as string) ?? '').trim();
  if (!proposalId) throw new Error('proposal_id required');
  unsnoozeProposalId(username, proposalId);
  revalidatePath('/proposals');
}

/**
 * Server Action: drop the user's cached /next recommendations and
 * revalidate so the next page load runs a fresh PM call.
 *
 * Used by the "Regenerate" button on /next when the user wants a
 * fresh recommendation without waiting for the 30-min TTL or for
 * the proposal queue to change.
 */
export async function regenerateRecommendation(): Promise<void> {
  const username = await getCurrentUsername();
  evictRecommendationsForUser(username);
  revalidatePath('/next');
}

/**
 * Server Action: change the bug-scout cron schedule for a wired-up repo.
 *
 * Edits `.github/workflows/dev-agent-bug-scout.yml` on the default branch
 * — GitHub Actions doesn't allow dynamic crons, so the schedule lives in
 * the workflow file itself and changing it means a commit. Direct-commit
 * (no PR) matches the wire-up flow's "this is your config, you don't
 * need to PR-review your own settings" stance.
 *
 * Form fields:
 *  - `repo`    — `owner/name`
 *  - `preset`  — one of `daily | weekdays | weekly | off`
 *
 * @throws Error on bad input
 * @throws ForbiddenError if user lacks write perm on the target repo
 * @throws Error if the bug-scout workflow file isn't installed yet
 */
export async function setBugScoutSchedule(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = (formData.get('repo') as string)?.trim() ?? '';
  const presetRaw = (formData.get('preset') as string)?.trim() ?? '';
  if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
  if (!SCHEDULE_PRESETS.includes(presetRaw as SchedulePreset)) {
    throw new Error(`invalid preset: ${presetRaw}`);
  }
  const preset = presetRaw as SchedulePreset;
  const [owner, repo] = repoFull.split('/');
  await assertWritePermission(octokit, owner, repo, session_username);

  // Pull the repo's default branch — `repos/[name]` doesn't carry it through
  // form fields, and trusting client input here would let the form rewrite
  // any branch the user can write to.
  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  await writeBugScoutSchedule(octokit, owner, repo, default_branch, preset);

  revalidatePath(`/repos/${encodeURIComponent(repoFull)}`);
}

/**
 * Server Action: fire a one-shot "Scan with PM" — dispatches the
 * unfinished-work-scout workflow on the consumer repo. The workflow
 * runs an LLM agent (~$0.10–0.30) that reads the repo with read-only
 * tools and files findings as `kind:unfinished-work` issues, which
 * then surface on `/proposals` via `scoutUnfinishedWorkFindings`.
 *
 * The button is disabled in the UI for ~10 minutes after each click
 * (via the redirect to /repos/<name>?scan_started=<timestamp>) to
 * prevent the user accidentally double-firing an expensive run.
 *
 * Form fields:
 *  - `repo` — `owner/name`
 *
 * @throws Error on bad input
 * @throws ForbiddenError if user lacks write perm on the target repo
 */
export async function triggerUnfinishedWorkScan(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = (formData.get('repo') as string)?.trim() ?? '';
  if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
  const [owner, repo] = repoFull.split('/');
  await assertWritePermission(octokit, owner, repo, session_username);

  // Read default branch from the repo rather than trusting form input —
  // same as setBugScoutSchedule. Prevents the form from triggering
  // workflows on arbitrary branches the user can write to.
  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: 'dev-agent-unfinished-work-scout.yml',
    ref: default_branch,
    inputs: {},
  });

  void session_username;

  revalidatePath(`/repos/${encodeURIComponent(repoFull)}`);
}
