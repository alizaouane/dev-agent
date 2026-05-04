import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { Proposal } from './types';
import { SOURCE_TO_GROUP } from './types';

/**
 * Scan `docs/plans/*.md` in a repo for unchecked `- [ ]` items and emit
 * each one as a Proposal. The first non-empty line of context after the
 * checkbox becomes the description, so the user sees what the unchecked
 * item is actually about — not just the bare checkbox text.
 *
 * **Scope:** carry-over commitments. These are decisions the user already
 * made (the plan was written, presumably approved); finishing them costs
 * less decision-time than evaluating a new pitch. They rank above new
 * scout findings by default.
 *
 * Implementation notes:
 * - Uses Octokit's tree listing to enumerate plan files lazily; reading
 *   the whole `docs/plans/` directory recursively avoids per-file
 *   discovery round-trips on repos with many plans.
 * - Plans missing the directory entirely are not an error — every repo
 *   that uses dev-agent has the directory configured by `.dev-agent.yml`,
 *   but a fresh consumer may not have populated it yet.
 * - The line-number anchor (`#L42`) lets the user click a proposal and
 *   land on the exact unchecked box in GitHub's web UI.
 */
export async function scoutUnfinishedPlans(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
): Promise<Proposal[]> {
  // The plans directory is configured per-repo via `.dev-agent.yml`'s
  // `artifacts.plans_dir`. The web-app-template ships with `docs/plans`
  // by default; we hardcode that path here for v1 and add config-driven
  // discovery in a follow-up if any consumer overrides it.
  const PLANS_DIR = 'docs/plans';

  let entries: Array<{ path: string; type?: string }>;
  try {
    const resp = await octokit.repos.getContent({
      owner,
      repo,
      path: PLANS_DIR,
      ref: default_branch,
    });
    if (!Array.isArray(resp.data)) return [];
    entries = resp.data
      .filter((e) => e.type === 'file' && e.path?.endsWith('.md'))
      .map((e) => ({ path: e.path as string }));
  } catch {
    // Missing directory or transient error — degrade silently. The
    // dashboard shouldn't blow up because one repo doesn't have plans.
    return [];
  }

  const out: Proposal[] = [];
  for (const entry of entries) {
    let raw: string;
    try {
      const fileResp = await octokit.repos.getContent({
        owner,
        repo,
        path: entry.path,
        ref: default_branch,
      });
      const data = fileResp.data as { content?: string; encoding?: string };
      if (!data.content || data.encoding !== 'base64') continue;
      raw = Buffer.from(data.content, 'base64').toString('utf8');
    } catch {
      continue;
    }
    out.push(...parseUncheckedItems(owner, repo, default_branch, entry.path, raw));
  }

  return out;
}

/**
 * Walk a markdown plan looking for unchecked `- [ ]` (or `* [ ]`) lines.
 * For each match, capture surrounding context: the most recent heading
 * (so the user knows *which step* they're behind on) and the body of
 * the checkbox itself.
 */
export function parseUncheckedItems(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  raw: string,
): Proposal[] {
  const lines = raw.split(/\r?\n/);
  const results: Proposal[] = [];
  let lastHeading: string | null = null;

  // Regex: indentation + bullet marker + `[ ]` (note the literal space).
  // Skip `[x]` / `[X]` (checked) and `[~]` / others (custom states).
  const uncheckedRe = /^(\s*)(?:[-*]|\d+\.)\s+\[\s\]\s+(.+)$/;
  // Capture markdown headings to track context.
  const headingRe = /^(#{1,6})\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(headingRe);
    if (headingMatch) {
      lastHeading = headingMatch[2].trim();
      continue;
    }
    const m = line.match(uncheckedRe);
    if (!m) continue;

    const checkboxText = m[2].trim();
    // Strip Markdown ** for the *content* of the title so it reads clean
    // in the proposal list, but keep colons / spacing exactly as authored.
    const title = checkboxText.replace(/\*\*(.+?)\*\*/g, '$1').trim();
    const lineNumber = i + 1;
    const planSlug = path.replace(/^.*\//, '').replace(/\.md$/, '');
    const headingPart = lastHeading ? ` (${lastHeading})` : '';

    results.push({
      id: `unfinished_plan:${owner}/${repo}:${planSlug}#L${lineNumber}`,
      source: 'unfinished_plan',
      group: SOURCE_TO_GROUP.unfinished_plan,
      repo: `${owner}/${repo}`,
      title: title.length > 100 ? title.slice(0, 97) + '...' : title,
      description: `Unchecked item in \`${planSlug}\`${headingPart}, line ${lineNumber}.`,
      url: `https://github.com/${owner}/${repo}/blob/${ref}/${path}#L${lineNumber}`,
      meta: { plan_file: path, line: lineNumber, heading: lastHeading ?? '' },
    });
  }

  return results;
}
