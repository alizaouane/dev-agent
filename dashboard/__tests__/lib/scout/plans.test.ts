import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { parseUncheckedItems, scoutUnfinishedPlans } from '@/lib/scout/plans';
import type { MarkdownFile } from '@/lib/scout/repo-tree';

function mdFile(path: string): MarkdownFile {
  const filename = path.replace(/^.*\//, '');
  return { path, filename, slug: filename.replace(/\.md$/, '') };
}

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
  function mockOctokit(files: Record<string, string>): Octokit {
    const getContent = vi.fn(async ({ path }: { path: string }) => {
      const fileContent = files[path];
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

  it('walks every supplied md file and emits one proposal per unchecked item', async () => {
    const octokit = mockOctokit({
      'docs/plans/a.md': '- [ ] from a',
      'notes/b.md': '- [ ] from b\n- [ ] another from b',
    });
    const proposals = await scoutUnfinishedPlans(octokit, 'q', 'r', 'main', [
      mdFile('docs/plans/a.md'),
      mdFile('notes/b.md'),
    ]);
    expect(proposals).toHaveLength(3);
    expect(proposals.map((p) => p.title).sort()).toEqual([
      'another from b',
      'from a',
      'from b',
    ]);
  });

  it('returns empty when given no files', async () => {
    const octokit = mockOctokit({});
    const proposals = await scoutUnfinishedPlans(octokit, 'q', 'r', 'main', []);
    expect(proposals).toEqual([]);
  });

  it('skips files in the noise denylist (README, CHANGELOG, etc.)', async () => {
    const octokit = mockOctokit({
      'README.md': '- [ ] release-template item',
      'CHANGELOG.md': '- [ ] migration step',
      'docs/real-plan.md': '- [ ] genuine work',
    });
    const proposals = await scoutUnfinishedPlans(octokit, 'q', 'r', 'main', [
      mdFile('README.md'),
      mdFile('CHANGELOG.md'),
      mdFile('docs/real-plan.md'),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toBe('genuine work');
  });

  it('skips files with no unchecked checkboxes (cheap pre-filter)', async () => {
    const octokit = mockOctokit({
      'plain.md': '# Just a doc\n\nProse only, no checkboxes.',
      'with-tasks.md': '- [ ] real task',
    });
    const proposals = await scoutUnfinishedPlans(octokit, 'q', 'r', 'main', [
      mdFile('plain.md'),
      mdFile('with-tasks.md'),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toBe('real task');
  });

  it('caps the number of proposals per repo at 30 to bound noise', async () => {
    const items = Array.from({ length: 50 }, (_, i) => `- [ ] item ${i}`).join('\n');
    const octokit = mockOctokit({ 'huge.md': items });
    const proposals = await scoutUnfinishedPlans(octokit, 'q', 'r', 'main', [mdFile('huge.md')]);
    expect(proposals.length).toBe(30);
  });
});
