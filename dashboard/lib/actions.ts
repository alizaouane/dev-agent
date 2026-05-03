'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Octokit } from '@octokit/rest';

import { getOctokit, getCurrentUsername } from './gh';
import { ForbiddenError } from './errors';

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
 * Server Action: dispatch the `phase-rollback.yml` workflow on `main` for a
 * given issue, then post an audit comment so the timeline records who
 * triggered it.
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

  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: 'phase-rollback.yml',
    ref: 'main',
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
