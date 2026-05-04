import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import {
  buildPmPromptVars,
  formatPipelineForPrompt,
  readPmNotesFromRepo,
  renderPmSystemPrompt,
} from '@/lib/pm-prompt';
import type { PmNotes } from '@/lib/pm-md';
import type { FeatureItem } from '@/lib/pipeline';

describe('renderPmSystemPrompt', () => {
  it('substitutes every placeholder', () => {
    const out = renderPmSystemPrompt({
      consumer_root: '.',
      pm_notes_body: '# Notes',
      goals: '- q2: ship',
      avoid: '(none)',
      recent_decisions: '(none)',
      current_pipeline: '(none)',
      request: 'evaluate_idea',
    });
    expect(out).toContain('`.`');
    expect(out).toContain('# Notes');
    expect(out).toContain('- q2: ship');
    expect(out).toContain('evaluate_idea');
    // No raw {{var}} should remain.
    expect(out).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it('throws on a missing variable rather than silently emitting {{var}}', () => {
    expect(() =>
      renderPmSystemPrompt({
        consumer_root: '.',
        pm_notes_body: '',
        goals: '',
        avoid: '',
        recent_decisions: '',
        current_pipeline: '',
        // request intentionally omitted via `as any` cast
      } as Parameters<typeof renderPmSystemPrompt>[0]),
    ).toThrow(/missing variable.*request/);
  });
});

describe('buildPmPromptVars', () => {
  const emptyNotes: PmNotes = { frontmatter: {}, body: '' };
  const fullNotes: PmNotes = {
    frontmatter: {
      goals: { near_term: 'ship onboarding', mid_term: 'reduce errors' },
      avoid: ['operational complexity', 'mobile rewrite'],
      recent_decisions: [
        { date: '2026-05-01', decision: 'Rejected mobile app', reason: 'Q4 instead' },
        { date: '2026-04-15', decision: 'Accepted timezone fix' },
      ],
    },
    body: 'Background paragraph.',
  };

  it('formats fully-populated notes', () => {
    const vars = buildPmPromptVars({
      consumer_root: '.',
      pmNotes: fullNotes,
      pipeline: [],
      request: 'evaluate_idea',
    });
    expect(vars.goals).toContain('near_term: ship onboarding');
    expect(vars.goals).toContain('mid_term: reduce errors');
    expect(vars.avoid).toContain('operational complexity');
    expect(vars.recent_decisions).toContain('2026-05-01: Rejected mobile app');
    expect(vars.recent_decisions).toContain('(Q4 instead)');
    expect(vars.pm_notes_body).toBe('Background paragraph.');
  });

  it('uses sentinel strings for empty fields so the prompt is never blank', () => {
    const vars = buildPmPromptVars({
      consumer_root: '.',
      pmNotes: emptyNotes,
      pipeline: [],
      request: 'evaluate_idea',
    });
    expect(vars.goals).toBe('(none specified)');
    expect(vars.avoid).toBe('(none specified)');
    expect(vars.recent_decisions).toBe('(none recorded)');
    expect(vars.pm_notes_body).toBe('(empty)');
    expect(vars.current_pipeline).toBe('(no features in flight)');
  });
});

describe('formatPipelineForPrompt', () => {
  it('formats one-per-line with state + title', () => {
    const items = [
      { issue_number: 5, state: 'state:implementing', title: 'Add refunds' },
      { issue_number: 9, state: 'state:pr-review', title: 'Fix booking bug' },
    ] as FeatureItem[];
    const out = formatPipelineForPrompt(items);
    expect(out).toContain('#5 (state:implementing): Add refunds');
    expect(out).toContain('#9 (state:pr-review): Fix booking bug');
  });

  it('returns the empty sentinel for empty input', () => {
    expect(formatPipelineForPrompt([])).toBe('(no features in flight)');
  });
});

describe('readPmNotesFromRepo', () => {
  function makeOctokit(opts: {
    default_branch?: string;
    pmContent?: string;
    pmStatus?: number;
    repoStatus?: number;
  }): Octokit {
    const get = vi.fn(async () => {
      if (opts.repoStatus && opts.repoStatus !== 200) {
        throw Object.assign(new Error('boom'), { status: opts.repoStatus });
      }
      return { data: { default_branch: opts.default_branch ?? 'main' } };
    });
    const getContent = vi.fn(async () => {
      if (opts.pmStatus && opts.pmStatus !== 200) {
        throw Object.assign(new Error('not found'), { status: opts.pmStatus });
      }
      if (!opts.pmContent) throw Object.assign(new Error('not found'), { status: 404 });
      return {
        data: {
          content: Buffer.from(opts.pmContent, 'utf8').toString('base64'),
          encoding: 'base64',
        },
      };
    });
    return { repos: { get, getContent } } as unknown as Octokit;
  }

  it('parses pm.md when present', async () => {
    const raw = `---
goals:
  near_term: "ship onboarding"
---

Body content.
`;
    const octokit = makeOctokit({ pmContent: raw });
    const notes = await readPmNotesFromRepo(octokit, 'q', 'r');
    expect(notes.frontmatter.goals?.near_term).toBe('ship onboarding');
    expect(notes.body.trim()).toBe('Body content.');
  });

  it('returns empty defaults when pm.md is missing (404)', async () => {
    const octokit = makeOctokit({ pmStatus: 404 });
    const notes = await readPmNotesFromRepo(octokit, 'q', 'r');
    expect(notes).toEqual({ frontmatter: {}, body: '' });
  });

  it('returns empty defaults when the repo itself is unreachable', async () => {
    const octokit = makeOctokit({ repoStatus: 403 });
    const notes = await readPmNotesFromRepo(octokit, 'q', 'r');
    expect(notes).toEqual({ frontmatter: {}, body: '' });
  });
});
