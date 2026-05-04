import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { parseUncheckedItems, scoutUnfinishedPlans } from '@/lib/scout/plans';

describe('parseUncheckedItems', () => {
  it('extracts unchecked `- [ ]` items with surrounding heading context', () => {
    const raw = [
      '# Plan',
      '',
      '## Step 1: Foundation',
      '',
      '- [x] **Implemented:** scaffolding',
      '- [ ] **Pending:** wire up auth',
      '',
      '## Step 2: Polish',
      '',
      '- [ ] add documentation',
      '- [x] do nothing',
    ].join('\n');

    const items = parseUncheckedItems('q', 'r', 'main', 'docs/plans/plan.md', raw);
    expect(items).toHaveLength(2);

    expect(items[0].title).toBe('Pending: wire up auth');
    expect(items[0].description).toContain('Step 1: Foundation');
    expect(items[0].description).toContain('line 6');
    expect(items[0].url).toBe('https://github.com/q/r/blob/main/docs/plans/plan.md#L6');
    expect(items[0].source).toBe('unfinished_plan');
    expect(items[0].group).toBe('carry_over');

    expect(items[1].title).toBe('add documentation');
    expect(items[1].description).toContain('Step 2: Polish');
  });

  it('ignores checked items in any case (`[x]` and `[X]`)', () => {
    const raw = ['- [x] alpha', '- [X] beta', '- [ ] real one'].join('\n');
    const items = parseUncheckedItems('q', 'r', 'main', 'plan.md', raw);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('real one');
  });

  it('truncates long titles to 100 chars', () => {
    const long = 'a'.repeat(150);
    const raw = `- [ ] ${long}`;
    const items = parseUncheckedItems('q', 'r', 'main', 'p.md', raw);
    expect(items[0].title.length).toBe(100);
    expect(items[0].title.endsWith('...')).toBe(true);
  });

  it('handles items without a preceding heading', () => {
    const raw = '- [ ] thing without context';
    const items = parseUncheckedItems('q', 'r', 'main', 'p.md', raw);
    expect(items).toHaveLength(1);
    expect(items[0].description).not.toContain('(');
    expect(items[0].description).toContain('line 1');
  });

  it('emits stable, line-anchored ids', () => {
    const raw = ['', '- [ ] one', '- [ ] two'].join('\n');
    const items = parseUncheckedItems('q', 'r', 'main', 'docs/plans/2026-05-04-plan.md', raw);
    expect(items[0].id).toBe('unfinished_plan:q/r:2026-05-04-plan#L2');
    expect(items[1].id).toBe('unfinished_plan:q/r:2026-05-04-plan#L3');
  });
});

describe('scoutUnfinishedPlans', () => {
  function mockOctokit(opts: {
    listing?: Array<{ path: string; type: string }>;
    files?: Record<string, string>;
    listingError?: number;
    plansDir?: string;
  }): Octokit {
    const expectedListing = opts.plansDir ?? 'docs/plans';
    const getContent = vi.fn(async ({ path }: { path: string }) => {
      if (path === expectedListing) {
        if (opts.listingError) {
          throw Object.assign(new Error('boom'), { status: opts.listingError });
        }
        return { data: opts.listing ?? [] };
      }
      const fileContent = opts.files?.[path];
      if (fileContent === undefined) {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }
      return {
        data: {
          content: Buffer.from(fileContent, 'utf8').toString('base64'),
          encoding: 'base64',
        },
      };
    });
    return { repos: { getContent } } as unknown as Octokit;
  }

  it('returns proposals from every plan file in docs/plans', async () => {
    const octokit = mockOctokit({
      listing: [
        { path: 'docs/plans/a.md', type: 'file' },
        { path: 'docs/plans/b.md', type: 'file' },
      ],
      files: {
        'docs/plans/a.md': '- [ ] from a',
        'docs/plans/b.md': '- [ ] from b\n- [ ] another from b',
      },
    });
    const proposals = await scoutUnfinishedPlans(octokit, 'q', 'r', 'main', 'docs/plans');
    expect(proposals).toHaveLength(3);
    expect(proposals.map((p) => p.title).sort()).toEqual([
      'another from b',
      'from a',
      'from b',
    ]);
  });

  it('returns empty array when docs/plans directory is missing', async () => {
    const octokit = mockOctokit({ listingError: 404 });
    const proposals = await scoutUnfinishedPlans(octokit, 'q', 'r', 'main', 'docs/plans');
    expect(proposals).toEqual([]);
  });

  it('skips non-markdown entries in docs/plans', async () => {
    const octokit = mockOctokit({
      listing: [
        { path: 'docs/plans/README.md', type: 'file' },
        { path: 'docs/plans/diagram.png', type: 'file' },
        { path: 'docs/plans/subdir', type: 'dir' },
      ],
      files: { 'docs/plans/README.md': '- [ ] one item' },
    });
    const proposals = await scoutUnfinishedPlans(octokit, 'q', 'r', 'main', 'docs/plans');
    expect(proposals).toHaveLength(1);
  });

  it('honors a custom plans_dir from .dev-agent.yml', async () => {
    const octokit = mockOctokit({
      plansDir: 'plans',
      listing: [{ path: 'plans/2026-05-04.md', type: 'file' }],
      files: { 'plans/2026-05-04.md': '- [ ] custom-path item' },
    });
    const proposals = await scoutUnfinishedPlans(octokit, 'q', 'r', 'main', 'plans');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toBe('custom-path item');
    expect(proposals[0].url).toContain('plans/2026-05-04.md');
  });
});
