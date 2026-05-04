import 'server-only';

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { Octokit } from '@octokit/rest';

import type { RepoInfo } from './repos';
import { fetchPipeline } from './pipeline';
import { readPmNotesFromRepo, formatPipelineForPrompt, renderPmSystemPrompt } from './pm-prompt';
import type { Proposal } from './scout';
import type { PmNotes } from './pm-md';

// Exported only for tests — the page itself uses recommendNext().
export const __testing = {
  aggregatePmNotes: (byRepo: Array<{ repo: string; notes: PmNotes }>) => aggregatePmNotes(byRepo),
  formatProposalsForPrompt: (proposals: Proposal[]) => formatProposalsForPrompt(proposals),
};

/**
 * Aggregate every wired-up repo's `pm.md` into a single PM context block.
 * Each section is labeled by repo so the PM can reason across them
 * (the dashboard's `/next` view is multi-repo by design — the user
 * thinks "what should I do today" holistically, not per-repo).
 *
 * Empty repos contribute nothing rather than a noisy "(empty)" header.
 */
function aggregatePmNotes(byRepo: Array<{ repo: string; notes: PmNotes }>): {
  goals: string;
  avoid: string;
  recent_decisions: string;
  pm_notes_body: string;
} {
  const goalLines: string[] = [];
  const avoidLines: string[] = [];
  const decisionLines: string[] = [];
  const bodySections: string[] = [];

  for (const { repo, notes } of byRepo) {
    const fm = notes.frontmatter;
    if (fm.goals) {
      for (const [k, v] of Object.entries(fm.goals)) {
        goalLines.push(`- [${repo}] ${k}: ${v}`);
      }
    }
    if (fm.avoid) {
      for (const a of fm.avoid) {
        avoidLines.push(`- [${repo}] ${a}`);
      }
    }
    if (fm.recent_decisions) {
      for (const d of fm.recent_decisions) {
        decisionLines.push(
          `- [${repo}] ${d.date}: ${d.decision}${d.reason ? ` (${d.reason})` : ''}`,
        );
      }
    }
    if (notes.body.trim().length > 0) {
      bodySections.push(`## ${repo}\n\n${notes.body.trim()}`);
    }
  }

  return {
    goals: goalLines.length > 0 ? goalLines.join('\n') : '(none specified)',
    avoid: avoidLines.length > 0 ? avoidLines.join('\n') : '(none specified)',
    recent_decisions:
      decisionLines.length > 0 ? decisionLines.join('\n') : '(none recorded)',
    pm_notes_body: bodySections.length > 0 ? bodySections.join('\n\n') : '(empty)',
  };
}

/**
 * Format the proposal queue for the PM as a numbered list, grouped by
 * carry-over vs new-idea so the PM's prompt instructions about default
 * priority are easy to apply.
 */
function formatProposalsForPrompt(proposals: Proposal[]): string {
  if (proposals.length === 0) return '(queue is empty)';
  const carry = proposals.filter((p) => p.group === 'carry_over');
  const fresh = proposals.filter((p) => p.group === 'new_idea');

  const out: string[] = [];
  if (carry.length > 0) {
    out.push('### Carry-over commitments');
    carry.forEach((p, i) => {
      out.push(`${i + 1}. **${p.title}** (${p.repo}, source=${p.source})`);
      out.push(`   ${p.description}`);
    });
  }
  if (fresh.length > 0) {
    if (out.length > 0) out.push('');
    out.push('### New ideas');
    fresh.forEach((p, i) => {
      out.push(`${i + 1}. **${p.title}** (${p.repo}, source=${p.source})`);
      out.push(`   ${p.description}`);
    });
  }
  return out.join('\n');
}

/**
 * Call the PM agent in `recommend_next` mode and return its plain-text
 * recommendation. Non-streaming because the page renders this server-side
 * and a one-shot text call is simpler than wiring streaming into a
 * server component.
 *
 * Model: claude-opus-4-7. The PM's reasoning is the highest-value
 * place to spend tokens — the recommendation is what the user acts on.
 *
 * @returns Recommendation markdown the page renders directly.
 * @throws if `ANTHROPIC_API_KEY` is unset (caller surfaces this).
 */
export async function recommendNext(opts: {
  octokit: Octokit;
  wiredRepos: RepoInfo[];
  proposals: Proposal[];
}): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set on the dashboard');
  }

  const { octokit, wiredRepos, proposals } = opts;

  // Gather per-repo PM notes + the cross-repo pipeline. These are the
  // two slow calls; running them in parallel keeps page latency down.
  const [perRepoNotes, pipeline] = await Promise.all([
    Promise.all(
      wiredRepos.map(async (r) => ({
        repo: `${r.owner}/${r.name}`,
        notes: await readPmNotesFromRepo(octokit, r.owner, r.name),
      })),
    ),
    fetchPipeline(octokit, wiredRepos),
  ]);

  const aggregate = aggregatePmNotes(perRepoNotes);

  const systemPrompt = renderPmSystemPrompt({
    consumer_root: '(multi-repo)',
    pm_notes_body: aggregate.pm_notes_body,
    goals: aggregate.goals,
    avoid: aggregate.avoid,
    recent_decisions: aggregate.recent_decisions,
    current_pipeline: formatPipelineForPrompt(pipeline),
    request: 'recommend_next',
  });

  const userMessage = [
    'Here is the current proposal queue. Pick a single highest-value item to recommend.',
    'Format your reply with these exact section headings:',
    '',
    '### Recommendation',
    '> Do **<title>** (`<repo>`).',
    '',
    '### Why',
    '<one or two sentences referencing a goal, carry-over commitment, or pipeline conflict>',
    '',
    '### Effort',
    '<concrete estimate>',
    '',
    '### Watch out for',
    '<single risk or trade-off>',
    '',
    'If the queue is empty or nothing is worth doing, say so plainly. Do not invent work.',
    '',
    '## Proposal queue',
    '',
    formatProposalsForPrompt(proposals),
  ].join('\n');

  const result = await generateText({
    model: anthropic('claude-opus-4-7'),
    system: systemPrompt,
    prompt: userMessage,
  });

  return result.text;
}
