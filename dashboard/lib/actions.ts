'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Octokit } from '@octokit/rest';

import { getOctokit, getCurrentUsername } from './gh';
import { ForbiddenError } from './errors';
import type { ScanRunStatus } from './scan-run';
import {
  WIRE_UP_FILES,
  INSTALLABLE_WORKFLOWS,
  WORKFLOW_KEYS,
  type WorkflowKey,
} from './wire-up-template';
import { pushRepoSecret } from './gh-secrets';
import {
  parseRepoFromProposalId,
  snoozeProposalPersistent,
  unsnoozeProposalPersistent,
} from './scout/snooze';
import { resolveProposal } from './scout/resolve';
import { evictRecommendationsForUser } from './next-cache';
import { fetchActiveRunsForIssue } from './active-runs';
import {
  SCHEDULE_PRESETS,
  writeBugScoutSchedule,
  type SchedulePreset,
} from './bug-scout-schedule';

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
 * Returns `{ error }` (does not throw) on failure: production masks any
 * thrown server-action error with the generic "Server Components render"
 * string, which strands the user with no actionable info. Same pattern
 * as `dispatchExistingIssue`. On success, falls through to `redirect('/repos')`
 * which throws NEXT_REDIRECT for the framework.
 */
export async function wireUpRepo(
  formData: FormData,
): Promise<{ error: string } | void> {
  try {
    const session_username = await getCurrentUsername();
    const octokit = await getOctokit();
    const owner = ((formData.get('owner') as string | null) ?? '').trim();
    const repo = ((formData.get('repo') as string | null) ?? '').trim();

    if (!owner || !repo) throw new Error('owner and repo are required');
    await assertWritePermission(octokit, owner, repo, session_username);

    // Resolve the repo's actual default branch server-side instead of
    // trusting the form's hidden input — same pattern as setBugScoutSchedule
    // / triggerUnfinishedWorkScan / dispatchRollback. A tampered form value
    // here would either bypass the "already wired" pre-check (data-loss
    // risk: re-overwriting an existing config) or 404 the probe.
    const repoData = await octokit.repos.get({ owner, repo });
    const default_branch = repoData.data.default_branch ?? 'main';

    // Defensive: if the repo already has .dev-agent.yml on its default branch,
    // bail out. /repos derives `wired_up` server-side so this is mostly a
    // TOCTOU guard — but it ALSO catches the case where the dashboard's repo
    // probe returned a transient error that bucketed an already-wired repo
    // into "Available to wire up". Bust the path cache so the next render
    // re-probes (likely correctly this time).
    let alreadyWired = false;
    try {
      await octokit.repos.getContent({ owner, repo, path: '.dev-agent.yml', ref: default_branch });
      alreadyWired = true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404) throw err;
      // 404 is the happy path: file doesn't exist, proceed.
    }
    if (alreadyWired) {
      revalidatePath('/repos');
      throw new Error(
        `${owner}/${repo} is already wired up — open it from the "Wired up" section of /repos (refresh the page if it still appears under "Available to wire up").`,
      );
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
    //
    // Per-file sha probe: GitHub's Contents API requires the existing
    // file's sha on update (422 "sha wasn't supplied" otherwise) but
    // forbids it on create. The pre-check above only guards `.dev-agent.yml`,
    // so any *other* template file left over from a partial prior wire-up
    // (e.g., a cleanup commit that removed `.dev-agent.yml` but not the
    // scout workflows) would 422 mid-loop and wedge the repo half-wired.
    // We probe each path and forward sha when present.
    //
    // ESLint disable: per-file commits are intentionally serial — Octokit's
    // createOrUpdateFileContents takes a branch HEAD lock per call, so
    // parallel calls would race on the same branch ref.
    // eslint-disable-next-line no-restricted-syntax
    for (const f of WIRE_UP_FILES) {
      const sha = await fetchExistingFileSha(octokit, owner, repo, f.path, default_branch);
      await wrapStep(`committing ${f.path}`, () =>
        octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: f.path,
          message: `chore(dev-agent): add ${f.path}`,
          content: Buffer.from(f.content, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      );
    }

    // Suppress "unused" on session_username — kept here in case we want to
    // audit-log the wire-up later.
    void session_username;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[wireUpRepo] failed', {
      message,
      raw: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
    });
    return { error: message };
  }

  // Outside the try/catch so `redirect()`'s NEXT_REDIRECT signal
  // propagates to the framework — wrapping it would swallow the redirect.
  revalidatePath('/repos');
  redirect('/repos');
}

/**
 * Server Action: install a single workflow file on a repo that was wired up
 * before the workflow existed. Backfills bug-scout / unfinished-work / cleanup
 * / verification workflows without forcing a full re-wire (which would require
 * deleting `.dev-agent.yml` first to clear the already-wired guard).
 *
 * Returns `{ error }` instead of throwing so production's Server Components
 * mask doesn't strand the user with no actionable info — same pattern as
 * `dispatchExistingIssue` / `redispatchPhase`.
 *
 * Form fields:
 *  - `repo`     — `owner/name`
 *  - `workflow` — one of `bug-scout | unfinished-work | cleanup | verification`
 */
export async function installWorkflow(
  formData: FormData,
): Promise<{ error: string } | void> {
  try {
    const session_username = await getCurrentUsername();
    const octokit = await getOctokit();
    const repoFull = ((formData.get('repo') as string | null) ?? '').trim();
    const workflowRaw = ((formData.get('workflow') as string | null) ?? '').trim();

    if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
    if (!WORKFLOW_KEYS.includes(workflowRaw as WorkflowKey)) {
      throw new Error(
        `unknown workflow: ${workflowRaw} (expected one of ${WORKFLOW_KEYS.join(', ')})`,
      );
    }
    const workflow = workflowRaw as WorkflowKey;
    const spec = INSTALLABLE_WORKFLOWS[workflow];

    const [owner, repo] = repoFull.split('/');
    await assertWritePermission(octokit, owner, repo, session_username);

    // Resolve default branch server-side — same reason as wireUpRepo /
    // setBugScoutSchedule. Don't trust client-supplied branch hints.
    const repoData = await octokit.repos.get({ owner, repo });
    const default_branch = repoData.data.default_branch ?? 'main';

    // Idempotency guard: refuse if the workflow file is already there
    // (TOCTOU between the page render and the click). Distinguishes a
    // genuine "missing" (404 → proceed) from any other error (re-throw,
    // surface to user).
    try {
      await octokit.repos.getContent({
        owner,
        repo,
        path: spec.path,
        ref: default_branch,
      });
      throw new Error(
        `${spec.label} workflow is already installed at ${spec.path} on ${default_branch}.`,
      );
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404) throw err;
    }

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: spec.path,
      message: `chore(dev-agent): install ${spec.label} workflow`,
      content: Buffer.from(spec.content, 'utf8').toString('base64'),
    });

    void session_username;
    revalidatePath(`/repos/${encodeURIComponent(repoFull)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[installWorkflow] failed', {
      message,
      raw: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
    });
    return { error: message };
  }
}

/**
 * Returned (not thrown) when a step in `dispatchExistingIssue` fails.
 * Returning the error keeps the message visible to the user even in
 * production — Next.js masks any error thrown out of a server action with
 * the generic "An error occurred in the Server Components render" string,
 * which strands the user with no actionable info. `issue_url` is set when
 * the issue context was resolved before the failure, so the user can
 * resume manually rather than losing the work.
 *
 * Name retained for git-history continuity; `dispatchExistingIssue` is the
 * only producer now that the PM-chat-driven `approveAndStart` is gone.
 */
export type ApproveAndStartError = { error: string; issue_url?: string };

/**
 * Server Action: dispatch the implement workflow for an issue that is
 * already at `state:spec-ready` — the path used when a user filed the
 * issue via the `/develop` slash command in their repo's Claude Code
 * session (which writes the spec + plan and opens the issue directly),
 * and now wants to approve it from the dashboard.
 *
 * The issue already exists; we validate state, dispatch the implement
 * workflow, and flip the state label to `state:implementing`.
 *
 * On success, redirects to the feature page (so `redirect()`'s
 * NEXT_REDIRECT propagates; on failure we return an
 * `ApproveAndStartError` so the message surfaces in the UI rather than
 * getting masked by Next.js's generic server-action error string).
 *
 * Form fields:
 *  - `repo`  — `owner/name`
 *  - `issue` — issue number (string, parsed to int)
 */
export async function dispatchExistingIssue(
  formData: FormData,
): Promise<ApproveAndStartError | void> {
  let issueNumberForRedirect: number | null = null;
  let repoFullForRedirect: string | null = null;
  let issueUrl: string | null = null;

  try {
    const session_username = await getCurrentUsername();
    const octokit = await getOctokit();
    const repoFull = (formData.get('repo') as string).trim();
    const issueStr = (formData.get('issue') as string).trim();
    if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
    // parseStrictInt rejects "42oops" — the loose `parseInt` would
    // coerce it to 42 and silently dispatch the wrong issue.
    const issue_number = parseStrictInt(issueStr, 'issue');

    const [owner, repo] = repoFull.split('/');
    await assertWritePermission(octokit, owner, repo, session_username);

    // Look up the issue and validate it's in the expected state BEFORE
    // we dispatch. Catching a wrong-state issue here keeps us from
    // double-dispatching an already-running implement run or kicking
    // off work on a scoping/abandoned issue.
    const issue = await wrapStep('looking up issue', () =>
      octokit.issues.get({ owner, repo, issue_number }),
    );
    issueUrl = issue.data.html_url;
    const labels = issue.data.labels.map((l) =>
      typeof l === 'string' ? l : (l.name ?? ''),
    );
    if (!labels.includes('state:spec-ready')) {
      const currentState = labels.find((l) => l.startsWith('state:')) ?? 'unknown state';
      return {
        error: `issue is at ${currentState}; expected state:spec-ready`,
        issue_url: issue.data.html_url,
      };
    }

    // Idempotency guard: if a previous approve hit a label-flip failure
    // (issue stuck at state:spec-ready) but the dispatch itself
    // succeeded, a second click would queue a duplicate run. Check
    // active runs first and refuse the dispatch if any are in flight.
    // The implement workflow's own end-of-phase label transition will
    // reconcile the stuck label once the live run completes.
    const activeRuns = await fetchActiveRunsForIssue(octokit, owner, repo, issue_number);
    if (activeRuns.length > 0) {
      const phases = activeRuns.map((r) => r.phase ?? 'unknown').join(', ');
      return {
        error: `dispatch refused — issue already has ${activeRuns.length} active run(s) (${phases}). Wait for them to finish before re-approving.`,
        issue_url: issue.data.html_url,
      };
    }

    const repoData = await wrapStep('looking up repo', () =>
      octokit.repos.get({ owner, repo }),
    );
    const default_branch = repoData.data.default_branch;

    await wrapStep('dispatching implement workflow', () =>
      octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: 'dev-agent.yml',
        ref: default_branch,
        inputs: {
          phase: 'implement',
          issue_number: String(issue_number),
          invocation_mode: 'live',
        },
      }),
    );

    // Flip ALL state:* labels → state:implementing. Stripping every
    // state:* label (not just state:spec-ready) handles the edge case
    // where an issue was manually relabeled and ended up with two state
    // labels — without this, the next downstream consumer that reads
    // "the" state label could pick either one.
    //
    // Best-effort: at this point the workflow is already queued and the
    // dashboard's active-runs view reflects the live run — a label-flip
    // hiccup shouldn't error the whole approve flow. The next
    // user-click is protected by the idempotency guard above; the
    // implement workflow's own end-of-phase label transition will
    // reconcile the stuck label.
    const nextLabels = labels
      .filter((l) => !l.startsWith('state:'))
      .concat('state:implementing');
    try {
      await octokit.issues.setLabels({ owner, repo, issue_number, labels: nextLabels });
    } catch (err) {
      console.warn(
        `dispatchExistingIssue: state:implementing label flip failed for ${owner}/${repo}#${issue_number} (run is already dispatched; idempotency guard will catch a re-click):`,
        err,
      );
    }

    issueNumberForRedirect = issue_number;
    repoFullForRedirect = repoFull;
  } catch (e) {
    const message = formatApproveError(e, issueUrl);
    console.error('[dispatchExistingIssue] failed', {
      message,
      issueUrl,
      raw: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
    });
    return { error: message, ...(issueUrl ? { issue_url: issueUrl } : {}) };
  }

  // Outside the try/catch so `redirect()`'s NEXT_REDIRECT signal
  // propagates to the framework — wrapping it would swallow the redirect.
  revalidatePath('/');
  redirect(
    `/features/${issueNumberForRedirect}?repo=${encodeURIComponent(repoFullForRedirect!)}`,
  );
}

/**
 * Start implementation from a spec + plan that already live on the
 * default branch — the path for specs authored before the `/develop`
 * skill (or anything else that bypassed the normal PM flow). Creates a
 * fresh `state:spec-ready` issue whose body links Spec + Plan in the
 * exact format the implement workflow's prompt-render step expects,
 * then dispatches the workflow immediately and flips the label to
 * `state:implementing`.
 *
 * Returns `{ error }` for surface-able failures (missing file, wrong
 * input) and throws for write-perm refusal — same contract as
 * `dispatchExistingIssue`.
 */
export async function dispatchFromSpec(
  formData: FormData,
): Promise<ApproveAndStartError | void> {
  let issueNumberForRedirect: number | null = null;
  let repoFullForRedirect: string | null = null;
  let issueUrl: string | null = null;

  try {
    const session_username = await getCurrentUsername();
    const octokit = await getOctokit();
    const repoFull = (formData.get('repo') as string).trim();
    const spec_path = (formData.get('spec_path') as string).trim();
    const plan_path = (formData.get('plan_path') as string).trim();
    const title = (formData.get('title') as string).trim();
    if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
    if (!spec_path) return { error: 'spec_path is required' };
    if (!plan_path) return { error: 'plan_path is required' };
    if (!title) return { error: 'title is required' };

    const [owner, repo] = repoFull.split('/');
    await assertWritePermission(octokit, owner, repo, session_username);

    const repoData = await wrapStep('looking up repo', () =>
      octokit.repos.get({ owner, repo }),
    );
    const default_branch = repoData.data.default_branch;

    // Verify both files exist on the default branch before creating the
    // issue. Catching the typo / wrong-path mistake here keeps us from
    // filing an orphan issue that the implement agent would then choke on.
    const specExists = await fileExistsOnBranch(octokit, owner, repo, spec_path, default_branch);
    if (!specExists) {
      return {
        error: `spec_path not found on ${default_branch}: ${spec_path}`,
      };
    }
    const planExists = await fileExistsOnBranch(octokit, owner, repo, plan_path, default_branch);
    if (!planExists) {
      return {
        error: `plan_path not found on ${default_branch}: ${plan_path}`,
      };
    }

    const body = [
      `Spec: ${spec_path}`,
      `Plan: ${plan_path}`,
      '',
      '## TL;DR',
      '',
      `Implementing the spec at \`${spec_path}\` per the plan at \`${plan_path}\`.`,
      '',
      'Filed from the dashboard "Start from existing spec" panel.',
    ].join('\n');

    const created = await wrapStep('creating spec-ready issue', () =>
      octokit.issues.create({
        owner,
        repo,
        title,
        body,
        labels: ['kind:feature', 'state:spec-ready'],
      }),
    );
    const issue_number = created.data.number;
    issueUrl = created.data.html_url;

    await wrapStep('dispatching implement workflow', () =>
      octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: 'dev-agent.yml',
        ref: default_branch,
        inputs: {
          phase: 'implement',
          issue_number: String(issue_number),
          invocation_mode: 'live',
        },
      }),
    );

    // Strip every state:* label and add state:implementing. Same rule as
    // dispatchExistingIssue — keeps downstream consumers from having to
    // disambiguate between two state labels.
    const nextLabels = ['kind:feature', 'state:implementing'];
    try {
      await octokit.issues.setLabels({ owner, repo, issue_number, labels: nextLabels });
    } catch (err) {
      console.warn(
        `dispatchFromSpec: state:implementing label flip failed for ${owner}/${repo}#${issue_number} (run is already dispatched):`,
        err,
      );
    }

    issueNumberForRedirect = issue_number;
    repoFullForRedirect = repoFull;
  } catch (e) {
    const message = formatApproveError(e, issueUrl);
    console.error('[dispatchFromSpec] failed', {
      message,
      issueUrl,
      raw: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : e,
    });
    return { error: message, ...(issueUrl ? { issue_url: issueUrl } : {}) };
  }

  revalidatePath('/');
  redirect(
    `/features/${issueNumberForRedirect}?repo=${encodeURIComponent(repoFullForRedirect!)}`,
  );
}

/**
 * Returns true if `path` resolves to a file (not a directory) on
 * `ref`. 404 → false; other errors propagate so a real API failure
 * doesn't silently look like "file missing."
 */
async function fileExistsOnBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data)) return false;
    return 'type' in data && data.type === 'file';
  } catch (err) {
    if ((err as { status?: number }).status === 404) return false;
    throw err;
  }
}

/**
 * Wrap a single step so its failure carries the step name and the
 * upstream API status. Without this, the user just sees Octokit's bare
 * "HttpError" message and can't tell whether it was the issue create,
 * the workflow dispatch, or the repo lookup that failed.
 */
async function wrapStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new Error(`${step} failed — ${describeGhError(e)}`);
  }
}

/**
 * Probe the default branch for `path`. Returns the existing file's sha
 * (so `createOrUpdateFileContents` treats the commit as an update), or
 * undefined if the file doesn't exist (create-path; sha must be omitted
 * or GitHub 422s on the create).
 *
 * Errors other than 404 propagate — they indicate a real API failure
 * (rate limit, auth, etc.) that the caller should surface, not silently
 * treat as "file absent".
 */
async function fetchExistingFileSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    // `getContent` returns an array for directories. We only care about file
    // sha. A directory at `path` means the template path collides with a
    // user-created dir; let the subsequent commit attempt surface the error.
    if (!Array.isArray(data) && 'sha' in data && data.type === 'file') {
      return data.sha;
    }
    return undefined;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return undefined;
    throw err;
  }
}

function describeGhError(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const err = e as { status?: number; message?: string };
    if (typeof err.status === 'number') {
      const base = `GitHub API ${err.status}`;
      return err.message ? `${base}: ${err.message}` : base;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build the user-facing error string. If the workflow dispatch was the
 * step that failed, append a hint pointing at the most common cause —
 * a stale OAuth grant lacking the `workflow` scope, fixed by signing
 * out and signing back in to re-authorize.
 */
function formatApproveError(e: unknown, issueUrl: string | null): string {
  const base = e instanceof Error ? e.message : String(e);
  const parts = [base];
  if (issueUrl) {
    parts.push(`Issue was created: ${issueUrl}`);
  }
  if (base.includes('dispatching implement workflow')) {
    parts.push(
      'If the GitHub error mentions auth or permissions, try signing out and back in to refresh the OAuth grant (the workflow_dispatch endpoint needs the `workflow` scope).',
    );
  }
  return parts.join(' · ');
}

/**
 * Server Action: snooze a proposal so it stops appearing on /proposals
 * for ~a week. Writes to the consumer repo's `.dev-agent/pm.md`
 * frontmatter `snoozed_proposals` list, so the snooze survives Vercel
 * cold starts (the in-memory Map this used to be evaporated on every
 * cold start, so triage compounded zero).
 *
 * Routing: the proposal id encodes `<source>:<owner>/<repo>:<key>`. We
 * parse owner/repo and write to that repo's pm.md.
 *
 * Form fields:
 *  - `proposal_id` — the stable id from the Proposal type
 */
export async function snoozeProposal(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const proposalId = ((formData.get('proposal_id') as string) ?? '').trim();
  if (!proposalId) throw new Error('proposal_id required');

  const route = parseRepoFromProposalId(proposalId);
  if (!route) {
    throw new Error(
      `cannot snooze: proposal id "${proposalId}" doesn't include owner/repo`,
    );
  }
  await assertWritePermission(octokit, route.owner, route.repo, session_username);

  await snoozeProposalPersistent(octokit, proposalId);
  revalidatePath('/proposals');
}

/**
 * Server Action: undo a snooze (used by the "Show snoozed" view's
 * Un-snooze button). Idempotent — succeeds even if the entry isn't
 * there. Like `snoozeProposal`, this writes the consumer's pm.md.
 *
 * Form fields:
 *  - `proposal_id`
 */
export async function unsnoozeProposal(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const proposalId = ((formData.get('proposal_id') as string) ?? '').trim();
  if (!proposalId) throw new Error('proposal_id required');

  const route = parseRepoFromProposalId(proposalId);
  if (!route) {
    throw new Error(
      `cannot unsnooze: proposal id "${proposalId}" doesn't include owner/repo`,
    );
  }
  await assertWritePermission(octokit, route.owner, route.repo, session_username);

  await unsnoozeProposalPersistent(octokit, proposalId);
  revalidatePath('/proposals');
}

/**
 * Server Action: mark a proposal as handled — the user is done with it
 * and wants it gone forever (not just snoozed).
 *
 * Per-source effect:
 *   - `unfinished_plan` (per-line): flip the underlying file's
 *     checkbox `[ ]` → `[x]` via Octokit commit.
 *   - `pending_spec`: file a `kind:user-intent` + `state:scoping`
 *     issue tracking the spec — the user can then run it through the
 *     normal pipeline.
 *   - `bug_scout_finding` / `unfinished_work_finding` /
 *     `untriaged_issue`: close the underlying issue with an audit
 *     comment.
 *
 * Sources without a Resolve story (rolled-up plans, `spec_drift`,
 * `competitor_watch`) throw a friendly error directing the user to
 * Snooze instead.
 *
 * Form fields:
 *  - `proposal_id`            — required
 *  - `meta_plan_file`         — for unfinished_plan
 *  - `meta_line`              — for unfinished_plan
 *  - `meta_spec_path`         — for pending_spec
 *
 * Permission: requires write on the routed repo. The action throws
 * before mutating anything if the user lacks it.
 */
export async function resolveProposalAction(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const proposalId = ((formData.get('proposal_id') as string) ?? '').trim();
  if (!proposalId) throw new Error('proposal_id required');

  const route = parseRepoFromProposalId(proposalId);
  if (!route) {
    throw new Error(
      `cannot resolve: proposal id "${proposalId}" doesn't include owner/repo`,
    );
  }
  await assertWritePermission(octokit, route.owner, route.repo, session_username);

  const lineRaw = (formData.get('meta_line') as string) ?? '';
  const lineParsed = lineRaw ? parseInt(lineRaw, 10) : NaN;

  await resolveProposal(octokit, {
    proposalId,
    username: session_username,
    meta: {
      plan_file: ((formData.get('meta_plan_file') as string) ?? '').trim() || undefined,
      line: Number.isFinite(lineParsed) ? lineParsed : undefined,
      spec_path: ((formData.get('meta_spec_path') as string) ?? '').trim() || undefined,
    },
  });

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

/**
 * Server Action: fire a one-shot "Run cleanup scan" — dispatches the
 * cleanup-scout workflow on the consumer repo. Mirrors
 * `triggerUnfinishedWorkScan` exactly; the only difference is the
 * workflow file name and the kind of issues it produces (`kind:cleanup`
 * instead of `kind:unfinished-work`).
 *
 * Cost ~$0.10–0.30 per scan. Manual trigger only — cleanup is bulk
 * triage, not a continuous safety net.
 *
 * Form fields:
 *  - `repo` — `owner/name`
 *
 * @throws Error on bad input
 * @throws ForbiddenError if user lacks write perm on the target repo
 */
export async function triggerCleanupScan(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = (formData.get('repo') as string)?.trim() ?? '';
  if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
  const [owner, repo] = repoFull.split('/');
  await assertWritePermission(octokit, owner, repo, session_username);

  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: 'dev-agent-cleanup-scout.yml',
    ref: default_branch,
    inputs: {},
  });

  void session_username;

  revalidatePath(`/repos/${encodeURIComponent(repoFull)}`);
}

/**
 * Server Action: fire a one-shot bug-scout run — dispatches the bug-scout
 * workflow on the consumer repo, independent of its cron schedule.
 * Mirrors `triggerCleanupScan`; only the workflow file name differs.
 *
 * Cost ~$0.30–1.00 per scan.
 *
 * Form fields:
 *  - `repo` — `owner/name`
 *
 * @throws Error on bad input
 * @throws ForbiddenError if user lacks write perm on the target repo
 */
export async function triggerBugScoutScan(formData: FormData): Promise<void> {
  const session_username = await getCurrentUsername();
  const octokit = await getOctokit();
  const repoFull = (formData.get('repo') as string)?.trim() ?? '';
  if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
  const [owner, repo] = repoFull.split('/');
  await assertWritePermission(octokit, owner, repo, session_username);

  // Read default branch from the repo rather than trusting form input —
  // same as triggerCleanupScan / setBugScoutSchedule.
  const repoData = await octokit.repos.get({ owner, repo });
  const default_branch = repoData.data.default_branch;

  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: 'dev-agent-bug-scout.yml',
    ref: default_branch,
    inputs: {},
  });

  void session_username;

  revalidatePath(`/repos/${encodeURIComponent(repoFull)}`);
}

/**
 * Server Action (read-only): return the most recent workflow run for a
 * scout workflow on a repo, so the dashboard can show scan status inline
 * instead of sending the user to GitHub's Actions tab.
 *
 * No write-permission gate — listing runs is a read, and the user
 * already has dashboard read access to the repo. Returns `{ error }`
 * (does not throw) on failure so production's Server Components mask
 * can't hide the cause — same contract as `redispatchPhase`.
 *
 * Form fields:
 *  - `repo`     — `owner/name`
 *  - `workflow` — workflow file name (e.g. `dev-agent-bug-scout.yml`)
 */
export async function getLatestScanRun(
  formData: FormData,
): Promise<ScanRunStatus | { error: string }> {
  try {
    const octokit = await getOctokit();
    const repoFull = ((formData.get('repo') as string | null) ?? '').trim();
    const workflow = ((formData.get('workflow') as string | null) ?? '').trim();
    if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
    if (!workflow) throw new Error('workflow is required');
    const [owner, repo] = repoFull.split('/');

    const resp = await octokit.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflow,
      per_page: 1,
    });
    const run = resp.data.workflow_runs[0];
    if (!run) {
      return { status: null, conclusion: null, html_url: null, created_at: null };
    }
    return {
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      html_url: run.html_url ?? null,
      created_at: run.created_at ?? null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[getLatestScanRun] failed', { message, raw: e });
    return { error: message };
  }
}

/**
 * Server Action: re-dispatch a phase workflow on an existing issue.
 * Used by the feature page's "Re-run" button so the operator doesn't
 * have to drop into `gh workflow run` whenever a phase fails or needs
 * a retry.
 *
 * Returns `{ error }` on failure — same contract as `dispatchExistingIssue`,
 * so production's server-action error masking can't hide useful info.
 *
 * Form fields:
 *  - `repo`            — `owner/name`
 *  - `issue`           — issue number
 *  - `phase`           — implement | staging-deploy | promote-to-prod | rollback
 *  - `invocation_mode` — live | stub (default 'live')
 */
export async function redispatchPhase(
  formData: FormData,
): Promise<{ error: string } | void> {
  try {
    const session_username = await getCurrentUsername();
    const octokit = await getOctokit();
    const repoFull = ((formData.get('repo') as string) ?? '').trim();
    const issueStr = ((formData.get('issue') as string) ?? '').trim();
    const phase = ((formData.get('phase') as string) ?? 'implement').trim();
    const invocation_mode = ((formData.get('invocation_mode') as string) ?? 'live').trim();

    if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
    const issue_number = parseStrictInt(issueStr, 'issue');
    if (!['implement', 'staging-deploy', 'promote-to-prod', 'rollback'].includes(phase)) {
      throw new Error(`unknown phase: ${phase}`);
    }
    if (!['live', 'stub'].includes(invocation_mode)) {
      throw new Error(`unknown invocation_mode: ${invocation_mode}`);
    }

    const [owner, repo] = repoFull.split('/');
    await assertWritePermission(octokit, owner, repo, session_username);

    const repoData = await octokit.repos.get({ owner, repo });
    const default_branch = repoData.data.default_branch;

    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: 'dev-agent.yml',
      ref: default_branch,
      inputs: {
        phase,
        issue_number: String(issue_number),
        invocation_mode,
      },
    });

    revalidatePath(`/features/${issue_number}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[redispatchPhase] failed', { message, raw: e });
    return { error: message };
  }
}

/**
 * Server Action: cancel an in-flight workflow run. Used by the
 * "Cancel" button on the active-runs panel so the operator can stop
 * a hung or wrong-target run from the dashboard instead of dropping
 * into `gh run cancel`.
 *
 * Form fields:
 *  - `repo`   — `owner/name`
 *  - `run_id` — numeric workflow run id
 */
export async function cancelRun(
  formData: FormData,
): Promise<{ error: string } | void> {
  try {
    const session_username = await getCurrentUsername();
    const octokit = await getOctokit();
    const repoFull = ((formData.get('repo') as string) ?? '').trim();
    const runIdStr = ((formData.get('run_id') as string) ?? '').trim();

    if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
    const run_id = parseStrictInt(runIdStr, 'run_id');

    const [owner, repo] = repoFull.split('/');
    await assertWritePermission(octokit, owner, repo, session_username);

    await octokit.actions.cancelWorkflowRun({ owner, repo, run_id });

    // No issue context here, so we revalidate the home (pipeline view)
    // and let the caller re-fetch the feature page if it's the source.
    revalidatePath('/');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[cancelRun] failed', { message, raw: e });
    return { error: message };
  }
}

/**
 * Server Action: merge the PR linked to an issue. Used by the feature
 * page's PR panel so the operator can ship a dev-agent PR without
 * leaving the dashboard.
 *
 * Defensive: requires write permission, refuses if the PR isn't
 * mergeable (conflicts, failing checks). The caller decides which
 * `merge_method` (squash by default — matches the engine's release
 * convention).
 *
 * Form fields:
 *  - `repo`         — `owner/name`
 *  - `pr_number`    — PR number
 *  - `merge_method` — squash | merge | rebase (default 'squash')
 */
export async function mergeFeaturePR(
  formData: FormData,
): Promise<{ error: string } | void> {
  try {
    const session_username = await getCurrentUsername();
    const octokit = await getOctokit();
    const repoFull = ((formData.get('repo') as string) ?? '').trim();
    const prStr = ((formData.get('pr_number') as string) ?? '').trim();
    const methodRaw = ((formData.get('merge_method') as string) ?? 'squash').trim();

    if (!repoFull.includes('/')) throw new Error('repo must be in owner/name format');
    const pull_number = parseStrictInt(prStr, 'pr_number');
    if (!['squash', 'merge', 'rebase'].includes(methodRaw)) {
      throw new Error(`unknown merge_method: ${methodRaw}`);
    }
    const merge_method = methodRaw as 'squash' | 'merge' | 'rebase';

    const [owner, repo] = repoFull.split('/');
    await assertWritePermission(octokit, owner, repo, session_username);

    await octokit.pulls.merge({ owner, repo, pull_number, merge_method });

    revalidatePath('/');
  } catch (e) {
    // Octokit's merge errors carry useful context (mergeable: false,
    // checks failing, etc.) — surface them verbatim.
    const message = formatMergeError(e);
    console.error('[mergeFeaturePR] failed', { message, raw: e });
    return { error: message };
  }
}

/**
 * Strict integer parse for FormData fields that identify GitHub
 * resources. `parseInt` would happily coerce "12oops" to 12, which
 * means a malformed form submission could re-dispatch the wrong
 * issue, cancel the wrong run, or merge the wrong PR. We require
 * the raw string to be digits-only (with optional whitespace, since
 * we already trim) before converting.
 */
function parseStrictInt(raw: string, fieldName: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return n;
}

function formatMergeError(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const err = e as { status?: number; message?: string };
    if (err.status === 405) {
      return `PR cannot be merged (405): ${err.message ?? 'not mergeable — checks may be failing or the branch is behind'}`;
    }
    if (typeof err.status === 'number') {
      return `GitHub API ${err.status}: ${err.message ?? ''}`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
