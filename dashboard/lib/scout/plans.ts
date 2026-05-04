import 'server-only';

import type { Octokit } from '@octokit/rest';

import type { Proposal } from './types';
import { SOURCE_TO_GROUP } from './types';
import type { MarkdownFile } from './repo-tree';

/**
 * Scan every markdown file in the repo for unchecked `- [ ]` items and
 * emit each one as a Proposal. The first non-empty line of context after
 * the checkbox becomes the description, so the user sees what the
 * unchecked item is actually about — not just the bare checkbox text.
 *
 * **Discovery model.** No directory convention required. The shared
 * `listMarkdownFiles` walk supplies every `.md` in the repo (less
 * obvious noise like node_modules); we apply a small filename denylist
 * to avoid surfacing checklist items that almost-never represent
 * "unfinished work" (release-template checklists in the README,
 * contribution checklists in CONTRIBUTING, etc.).
 *
 * **Scope.** Carry-over commitments. These are decisions the user
 * already made (the plan was written, presumably approved); finishing
 * them costs less decision-time than evaluating a new pitch. They rank
 * above new scout findings by default.
 */

/**
 * Filenames we skip even if they contain `- [ ]` items. These files
 * conventionally include checkboxes that aren't real work items —
 * release templates, contribution checklists, security policies. Match
 * is case-insensitive on the basename only.
 */
const PLAN_FILENAME_DENYLIST = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'LICENSE.md',
  'PULL_REQUEST_TEMPLATE.md',
  'ISSUE_TEMPLATE.md',
];

/**
 * Cap on plan-derived proposals per repo per pass. A long roadmap with
 * 200 unchecked boxes shouldn't drown the proposal queue; users who
 * want all of them open the file. Items that fit are surfaced in
 * tree-order (alphabetical-ish by file, then by line number).
 */
const MAX_PLAN_PROPOSALS_PER_REPO = 30;

/**
 * Threshold above which a single file's unchecked items get rolled up
 * into ONE proposal ("N unchecked items in <file>") instead of one
 * proposal per checkbox. Avoids drowning `/proposals` when a single
 * file has 60 placeholder checkboxes — e.g. a feature-contract template
 * with a long Acceptance Criteria block.
 *
 * 5 is the sweet spot: a normal plan (2-3 unchecked steps left in a
 * sprint) keeps per-line granularity so the user can deep-link to the
 * exact line; long files collapse to a single roll-up entry that links
 * to the file head.
 */
const PER_FILE_ROLLUP_THRESHOLD = 5;

function isPlanFilenameDenied(filename: string): boolean {
  const lower = filename.toLowerCase();
  return PLAN_FILENAME_DENYLIST.some((d) => d.toLowerCase() === lower);
}

/**
 * Build a single roll-up Proposal that summarizes many unchecked items
 * in one file. Used when a file has more than `PER_FILE_ROLLUP_THRESHOLD`
 * items so we don't flood the queue with line-level proposals from a
 * single source. The user clicks through to the file to see them all.
 */
function rollupProposal(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  items: Proposal[],
): Proposal {
  const planSlug = path.replace(/^.*\//, '').replace(/\.md$/, '');
  const previewCount = Math.min(3, items.length);
  const previewTitles = items
    .slice(0, previewCount)
    .map((i) => i.title)
    .join(' · ');
  return {
    id: `unfinished_plan:${owner}/${repo}:${planSlug}`,
    source: 'unfinished_plan',
    group: SOURCE_TO_GROUP.unfinished_plan,
    repo: `${owner}/${repo}`,
    title: `${items.length} unchecked items in ${planSlug}`,
    description: `${path} — ${previewTitles}${items.length > previewCount ? ` · …` : ''}`,
    url: `https://github.com/${owner}/${repo}/blob/${ref}/${path}`,
    meta: { plan_file: path, item_count: items.length, rolled_up: 'true' },
  };
}

export async function scoutUnfinishedPlans(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
  mdFiles: MarkdownFile[],
): Promise<Proposal[]> {
  const candidates = mdFiles.filter((f) => !isPlanFilenameDenied(f.filename));
  if (candidates.length === 0) return [];

  const out: Proposal[] = [];
  for (const entry of candidates) {
    if (out.length >= MAX_PLAN_PROPOSALS_PER_REPO) break;
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
    // Cheap pre-filter: skip files with no unchecked checkbox at all.
    // Mirrors `parseUncheckedItems`'s bullet-marker set (`-`, `*`, or
    // `1.`-style) so we don't accidentally drop files that use Markdown
    // task formats other than dashes. A narrower regex would silently
    // hide plans the parser would otherwise pick up.
    if (!/(?:^|\n)\s*(?:[-*]|\d+\.)\s+\[\s\]/.test(raw)) continue;
    const items = parseUncheckedItems(owner, repo, default_branch, entry.path, raw);
    if (items.length === 0) continue;
    if (items.length > PER_FILE_ROLLUP_THRESHOLD) {
      // Long checklist (e.g. a 60-item feature-contract template). Emit
      // ONE proposal pointing at the file rather than 60 per-line ones —
      // the user couldn't realistically triage that many anyway.
      out.push(rollupProposal(owner, repo, default_branch, entry.path, items));
    } else {
      // Short plan — keep per-line granularity so the user can deep-link
      // to the exact unchecked box in GitHub.
      out.push(...items.slice(0, MAX_PLAN_PROPOSALS_PER_REPO - out.length));
    }
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
      description: `Unchecked item in \`${path}\`${headingPart}, line ${lineNumber}.`,
      url: `https://github.com/${owner}/${repo}/blob/${ref}/${path}#L${lineNumber}`,
      meta: { plan_file: path, line: lineNumber, heading: lastHeading ?? '' },
    });
  }

  return results;
}
