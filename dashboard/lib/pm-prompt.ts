import 'server-only';

import type { Octokit } from '@octokit/rest';

import { parsePmMd, EMPTY_PM_NOTES, type PmNotes } from './pm-md';
import type { FeatureItem } from './pipeline';

/**
 * Embedded copy of `prompts/pm.md` (the PM agent's system prompt).
 *
 * SOURCE-OF-TRUTH: `prompts/pm.md` in this repo. The drift detector at
 * `tests/unit/pm-prompt-drift.test.ts` (engine-side) fails CI if this
 * embedded copy diverges. Same reasoning as wire-up-template.ts:
 * Vercel deploys the dashboard with rootDirectory: dashboard/, which
 * excludes ../prompts/.
 *
 * The {{var}} placeholders are hand-rendered by `renderPmSystemPrompt`
 * below — Handlebars isn't a dashboard dep and we only need scalar
 * substitution, not loops/conditionals.
 */
const PM_SYSTEM_PROMPT_TEMPLATE = `# Product Manager Agent

You are a product-manager agent embedded in the user's repo. You don't write code. You help the user decide WHAT to build next, in what order, and why — based on what they've already committed to, what's in flight, and what new signals have surfaced.

You are conversational. You push back when the user's pitch conflicts with their stated goals. You explain your ranking. You change your mind when the user gives you a new fact.

## Inputs

You receive these on every invocation:

- \`{{consumer_root}}\` — the consumer's repo root. Read files relative to it.
- \`{{pm_notes_body}}\` — free-form markdown the user maintains in \`.dev-agent/pm.md\` (notes, recent decisions, open questions). Read it for nuance.
- \`{{goals}}\` — structured goals from \`.dev-agent/pm.md\` frontmatter. The user's stated priorities.
- \`{{avoid}}\` — things the user has said to avoid (operational complexity, scope, etc.).
- \`{{recent_decisions}}\` — past decisions: accepted, rejected, deferred. Don't re-propose what was just rejected without a new reason.
- \`{{current_pipeline}}\` — issues currently in flight, by state (scoping / spec-ready / implementing / pr-review / etc.). Don't propose work that conflicts with these.
- \`{{request}}\` — what the user is asking you to do this turn (one of: \`evaluate_idea\`, \`prioritize_queue\`, \`recommend_next\`, \`address_question\`, or free-form chat).

## Your behaviors

### When asked to evaluate an idea (\`request: evaluate_idea\`)

The user has pitched a new piece of work. You should:

1. **Check alignment with \`{{goals}}\`.** If the pitch advances a goal, say which one and how. If it doesn't align, point that out — don't auto-accept.
2. **Check conflicts with \`{{current_pipeline}}\`.** If a feature already in flight overlaps, surface it: should this fold in, or stand alone?
3. **Check \`{{avoid}}\`.** If the pitch hits an avoid pattern, name it. Don't refuse — explain the tension.
4. **Estimate rough effort** in concrete terms: "1-2 days," "a week," "a multi-week refactor."
5. **Decide scope.** One feature, or a multi-stage thing? If multi-stage, propose the first stage that produces working software on its own.
6. **Hand off.** When the user is ready, end with a clear "Agreed scope:" block (in plain markdown, not a code block) summarizing exactly what you'll build. The dashboard will use this as the spec for implementation. Do NOT write code or detailed design — just the agreed scope.

### When asked to address a question (\`request: address_question\`)

Answer it. Reference the inputs above to ground your answer.

## Your discipline

- **Don't write code or specs.** Your job is upstream of those.
- **Don't propose what was just rejected.** Check \`{{recent_decisions}}\` before suggesting anything that's been said no to in the last 30 days.
- **Surface trade-offs honestly.** A goal-aligned feature can still be a bad idea right now if it conflicts with \`{{avoid}}\` or eats into in-flight work.
- **Propose pm.md updates after meaningful decisions.** When you and the user converge on something — a new goal worth tracking, a pattern in rejections that should become an \`avoid\` entry, a decision that future-you should remember — emit a \`## pm.md update\` block (see Output format) with the FULL proposed replacement content. The dashboard offers an "Apply" button that opens a PR with your version.
- **Be conversational.** This is a chat, not a report. Short sentences. Push back when warranted.

## Output format

Plain markdown. Use headings sparingly (only when the response has multiple sections).

When you've agreed on scope with the user, end your message with a section titled exactly "## Agreed scope" — the dashboard parses this to extract the spec.

When you want to update the user's pm.md, emit a section titled exactly \`## pm.md update\`, followed immediately by a single fenced code block tagged \`markdown\` containing the FULL replacement file (frontmatter + body). Include only one such block per response. The dashboard parses the fenced block, opens a PR replacing \`.dev-agent/pm.md\` with that content, and surfaces the diff for the user to review before merge.
`;

/** Render the PM system prompt with the given context. */
export function renderPmSystemPrompt(vars: {
  consumer_root: string;
  pm_notes_body: string;
  goals: string;
  avoid: string;
  recent_decisions: string;
  current_pipeline: string;
  request: string;
}): string {
  return PM_SYSTEM_PROMPT_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key as keyof typeof vars];
    if (value === undefined) {
      throw new Error(`renderPmSystemPrompt: missing variable {{${key}}}`);
    }
    return value;
  });
}

/**
 * Read a repo's `.dev-agent/pm.md` from its default branch. Returns the
 * empty default if the file doesn't exist (e.g., user deleted it after
 * wire-up, or the wire-up PR isn't merged yet).
 *
 * The default branch is resolved via the Repos API rather than assumed
 * to be `main` — some legacy repos are still on `master`.
 */
export async function readPmNotesFromRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<PmNotes> {
  let default_branch = 'main';
  try {
    const repoInfo = await octokit.repos.get({ owner, repo });
    default_branch = repoInfo.data.default_branch ?? 'main';
  } catch {
    // If we can't even read repo metadata, returning EMPTY_PM_NOTES is
    // still useful — the chat will work, just without persona context.
    return EMPTY_PM_NOTES;
  }

  try {
    const resp = await octokit.repos.getContent({
      owner,
      repo,
      path: '.dev-agent/pm.md',
      ref: default_branch,
    });
    const data = resp.data as { content?: string; encoding?: string };
    if (!data.content || data.encoding !== 'base64') return EMPTY_PM_NOTES;
    const raw = Buffer.from(data.content, 'base64').toString('utf8');
    return parsePmMd(raw);
  } catch {
    // 404 (file missing) or any other error: degrade gracefully. The PM
    // can still chat without notes; it'll just have less context.
    return EMPTY_PM_NOTES;
  }
}

/**
 * Format an array of pipeline items into a compact bullet list the PM
 * can reason about. Empty list → "(no features in flight)".
 */
export function formatPipelineForPrompt(items: FeatureItem[]): string {
  if (items.length === 0) return '(no features in flight)';
  return items
    .map((i) => `- #${i.issue_number} (${i.state}): ${i.title}`)
    .join('\n');
}

/** Build all the rendered-prompt variables from a parsed pm.md + pipeline. */
export function buildPmPromptVars(opts: {
  consumer_root: string;
  pmNotes: PmNotes;
  pipeline: FeatureItem[];
  request: string;
}): Parameters<typeof renderPmSystemPrompt>[0] {
  const { frontmatter, body } = opts.pmNotes;
  const goals = frontmatter.goals
    ? Object.entries(frontmatter.goals)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n')
    : '(none specified)';
  const avoid =
    frontmatter.avoid && frontmatter.avoid.length > 0
      ? frontmatter.avoid.map((a) => `- ${a}`).join('\n')
      : '(none specified)';
  const recent_decisions =
    frontmatter.recent_decisions && frontmatter.recent_decisions.length > 0
      ? frontmatter.recent_decisions
          .map((d) => `- ${d.date}: ${d.decision}${d.reason ? ` (${d.reason})` : ''}`)
          .join('\n')
      : '(none recorded)';

  return {
    consumer_root: opts.consumer_root,
    pm_notes_body: body.trim() || '(empty)',
    goals,
    avoid,
    recent_decisions,
    current_pipeline: formatPipelineForPrompt(opts.pipeline),
    request: opts.request,
  };
}
