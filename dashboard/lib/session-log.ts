import 'server-only';

import type { Octokit } from '@octokit/rest';

/**
 * Dashboard-side session-log helpers. Records the human-decision moment
 * (user clicks "Approve and start") into the consumer repo's
 * `SESSION_LOG.md` BEFORE dispatching the implement workflow, so even
 * if the workflow run fails the decision is durable.
 *
 * **Format invariant:** `buildApprovedScopeEntry` is an embedded copy
 * of the engine-side helper at `lib/session-log.ts`. The drift detector
 * at `tests/unit/session-log-drift.test.ts` (engine-side) keeps them
 * byte-aligned. Same reasoning as wire-up-template.ts: Vercel deploys
 * the dashboard with `rootDirectory: dashboard/`, which excludes
 * `../lib/`.
 *
 * **Append authority:** server-side, via the dashboard's Octokit
 * instance under the user's GitHub auth. Same credentials path as
 * `setBugScoutSchedule` and `wireUpRepo` already use.
 */

const H1 = '# Session Log';

export type ApprovedScopeEntryInput = {
  timestamp?: Date;
  /** Issue number freshly created by the dashboard. */
  issue: number;
  /** GitHub username who approved. */
  approver: string;
  /** Short feature title (issue title). */
  title: string;
  /** The agreed-scope text the PM emitted. Truncated in the entry to keep things scannable. */
  scope: string;
};

/**
 * Build a "user approved scope" entry. Embedded copy — drift-tested
 * against the engine version.
 */
export function buildApprovedScopeEntry(input: ApprovedScopeEntryInput): string {
  const ts = input.timestamp ?? new Date();
  const dateStr = formatTimestampUtc(ts);
  const scopeOneLine = collapseToOneLine(input.scope, 280);

  const lines: string[] = [];
  lines.push(`## ${dateStr} — user-approved scope — issue #${input.issue}`, '');
  lines.push(`**Trigger:** @${input.approver} clicked "Approve and start" on the PM brainstorm.`, '');
  lines.push(`**Title:** ${input.title}`, '');
  lines.push(`**Scope (one-line):** ${scopeOneLine}`, '');
  lines.push(
    `**Next session should start with:** waiting for the implement phase to dispatch and open a PR.`,
    '',
  );
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Prepend an entry to a SESSION_LOG.md content string. Pure function —
 * the caller does the Octokit fetch + write. Tested at the dashboard
 * layer; the engine layer has its own filesystem-based variant.
 *
 * Idempotent: same first H2 line already present → no-op.
 */
export function prependEntryToContent(
  current: string,
  entry: string,
): { content: string; changed: boolean } {
  const trimmedEntry = entry.endsWith('\n') ? entry : `${entry}\n`;

  if (current.trim().length === 0) {
    return { content: `${H1}\n\n${trimmedEntry}`, changed: true };
  }

  const firstEntryHeader = trimmedEntry.split('\n', 1)[0];
  const existingFirst = current.split('\n').find((l) => l.startsWith('## '));
  if (existingFirst === firstEntryHeader) {
    return { content: current, changed: false };
  }

  const lines = current.split('\n');
  const h1Idx = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1Idx === -1) {
    return { content: `${H1}\n\n${trimmedEntry}${current}`, changed: true };
  }
  const before = lines.slice(0, h1Idx + 1).join('\n');
  const after = lines.slice(h1Idx + 1).join('\n').replace(/^\n+/, '');
  return { content: `${before}\n\n${trimmedEntry}${after}`, changed: true };
}

/**
 * Append the entry to the consumer repo's `SESSION_LOG.md` via Octokit.
 * If the file doesn't exist, creates it. Best-effort: throws on
 * unrecoverable errors (caller decides whether to abort the cycle).
 */
export async function appendApprovedScopeEntry(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
  input: ApprovedScopeEntryInput,
): Promise<void> {
  const entry = buildApprovedScopeEntry(input);

  // Fetch current SESSION_LOG.md if it exists.
  let currentContent = '';
  let currentSha: string | undefined;
  try {
    const resp = await octokit.repos.getContent({
      owner,
      repo,
      path: 'SESSION_LOG.md',
      ref: default_branch,
    });
    const data = resp.data as { type?: string; content?: string; encoding?: string; sha?: string };
    if (data.type === 'file' && data.content && data.encoding === 'base64') {
      currentContent = Buffer.from(data.content, 'base64').toString('utf8');
      currentSha = data.sha;
    }
  } catch (err) {
    if ((err as { status?: number }).status !== 404) {
      // Non-404 errors (rate limit, permissions) — let the caller decide.
      throw err;
    }
    // 404 → file doesn't exist yet. We'll create it.
  }

  const { content: newContent, changed } = prependEntryToContent(currentContent, entry);
  if (!changed) return;

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: 'SESSION_LOG.md',
    message: `chore(dev-agent): session log — user-approved scope issue #${input.issue}`,
    content: Buffer.from(newContent, 'utf8').toString('base64'),
    sha: currentSha,
  });
}

function formatTimestampUtc(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

function collapseToOneLine(text: string, maxLen: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
}
