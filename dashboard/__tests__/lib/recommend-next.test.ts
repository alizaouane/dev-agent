import { describe, it, expect } from 'vitest';
import { __testing } from '@/lib/recommend-next';
import type { PmNotes } from '@/lib/pm-md';
import type { Proposal } from '@/lib/scout';

const { aggregatePmNotes, formatProposalsForPrompt } = __testing;

describe('aggregatePmNotes', () => {
  it('merges goals/avoid/decisions across repos with [repo] tags', () => {
    const notesA: PmNotes = {
      frontmatter: {
        goals: { q2: 'ship onboarding' },
        avoid: ['scope creep'],
        recent_decisions: [{ date: '2026-05-01', decision: 'No to mobile', reason: 'Q4' }],
      },
      body: 'A body.',
    };
    const notesB: PmNotes = {
      frontmatter: {
        goals: { now: 'fix bugs' },
        avoid: ['hand-rolled crypto'],
      },
      body: '',
    };
    const out = aggregatePmNotes([
      { repo: 'q/a', notes: notesA },
      { repo: 'q/b', notes: notesB },
    ]);
    expect(out.goals).toContain('[q/a] q2: ship onboarding');
    expect(out.goals).toContain('[q/b] now: fix bugs');
    expect(out.avoid).toContain('[q/a] scope creep');
    expect(out.avoid).toContain('[q/b] hand-rolled crypto');
    expect(out.recent_decisions).toContain('[q/a] 2026-05-01: No to mobile (Q4)');
    expect(out.pm_notes_body).toContain('## q/a');
    expect(out.pm_notes_body).toContain('A body.');
    // q/b has empty body — should NOT be a `## q/b` header for noise.
    expect(out.pm_notes_body).not.toContain('## q/b');
  });

  it('uses sentinel strings when nothing was contributed', () => {
    const out = aggregatePmNotes([]);
    expect(out.goals).toBe('(none specified)');
    expect(out.avoid).toBe('(none specified)');
    expect(out.recent_decisions).toBe('(none recorded)');
    expect(out.pm_notes_body).toBe('(empty)');
  });

  it('skips empty per-repo bodies entirely', () => {
    const out = aggregatePmNotes([
      { repo: 'q/x', notes: { frontmatter: {}, body: '   \n\n  ' } },
    ]);
    expect(out.pm_notes_body).toBe('(empty)');
  });
});

describe('formatProposalsForPrompt', () => {
  function p(overrides: Partial<Proposal>): Proposal {
    return {
      id: 'x',
      source: 'untriaged_issue',
      group: 'new_idea',
      repo: 'q/r',
      title: 'A thing',
      description: 'Something',
      url: 'https://example.com',
      ...overrides,
    };
  }

  it('groups carry-over above new ideas', () => {
    const out = formatProposalsForPrompt([
      p({ title: 'New A' }),
      p({ title: 'Carry A', source: 'unfinished_plan', group: 'carry_over' }),
      p({ title: 'New B' }),
      p({ title: 'Carry B', source: 'unfinished_plan', group: 'carry_over' }),
    ]);
    const carryHeadIdx = out.indexOf('### Carry-over commitments');
    const newHeadIdx = out.indexOf('### New ideas');
    expect(carryHeadIdx).toBeGreaterThan(-1);
    expect(newHeadIdx).toBeGreaterThan(-1);
    expect(carryHeadIdx).toBeLessThan(newHeadIdx);
    // Carry items appear before new items.
    expect(out.indexOf('Carry A')).toBeLessThan(out.indexOf('New A'));
  });

  it('omits the new-ideas section when there are none', () => {
    const out = formatProposalsForPrompt([
      p({ title: 'Only carry', source: 'unfinished_plan', group: 'carry_over' }),
    ]);
    expect(out).toContain('### Carry-over commitments');
    expect(out).not.toContain('### New ideas');
  });

  it('returns empty-queue sentinel for empty input', () => {
    expect(formatProposalsForPrompt([])).toBe('(queue is empty)');
  });
});
