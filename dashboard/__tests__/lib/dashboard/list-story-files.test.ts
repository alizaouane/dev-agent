import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { listStoryFiles } from '@/lib/dashboard/list-story-files';

const getTree = vi.fn();
const octokit = { git: { getTree } } as unknown as Octokit;

/** A git-tree response over `paths`, with a deterministic blob sha each. */
function tree(paths: string[], truncated = false) {
  return {
    data: {
      truncated,
      tree: paths.map((path, i) => ({ path, type: 'blob', sha: `sha${i}` })),
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('listStoryFiles', () => {
  it('finds stories nested under epic directories', async () => {
    getTree.mockResolvedValue(
      tree([
        'docs/stories/epic-8-agent-reliability/8.1-gate.md',
        'docs/stories/epic-8-agent-reliability/8.1-gate.approval.json',
        'docs/stories/epic-9-costs/9.1-caps.md',
        'README.md',
      ]),
    );
    const result = await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories');
    expect(result.stories).toEqual([
      'docs/stories/epic-8-agent-reliability/8.1-gate.md',
      'docs/stories/epic-9-costs/9.1-caps.md',
    ]);
    expect(result.approvals).toEqual([
      'docs/stories/epic-8-agent-reliability/8.1-gate.approval.json',
    ]);
    expect(result.unreadable).toBe(false);
  });

  it('makes exactly one call however deep the tree is', async () => {
    // The reason this module exists. A getContent-per-directory lister is
    // N+1 calls and marks the whole list short when one epic fails.
    getTree.mockResolvedValue(tree(['docs/stories/epic-1-a/1.1-x.md']));
    await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories');
    expect(getTree).toHaveBeenCalledTimes(1);
  });

  it('reports a truncated tree as short, not as complete', async () => {
    // GitHub truncates large trees silently. A partial list rendered as the
    // whole list is the truncation-as-absence failure this project keeps
    // closing: an approved story simply would not appear, with no signal.
    getTree.mockResolvedValue(tree(['docs/stories/epic-1-a/1.1-x.md'], true));
    const result = await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories');
    expect(result.stories).toEqual(['docs/stories/epic-1-a/1.1-x.md']);
    expect(result.unreadable).toBe(true);
  });

  it('treats an absent tree as empty and readable', async () => {
    getTree.mockRejectedValue(Object.assign(new Error('no'), { status: 404 }));
    expect(await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories')).toEqual({
      stories: [],
      approvals: [],
      blobShas: {},
      unreadable: false,
    });
  });

  it('treats any other failure as unreadable', async () => {
    getTree.mockRejectedValue(Object.assign(new Error('rate limit'), { status: 403 }));
    expect((await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories')).unreadable).toBe(true);
  });

  it('does not match a sibling directory that shares the prefix', async () => {
    // `docs/stories-archive/` starts with `docs/stories`. Without the
    // separator it would be listed as if it were the configured tree, and
    // an archived story would be offered as startable work.
    getTree.mockResolvedValue(
      tree(['docs/stories-archive/epic-1-a/1.1-old.md', 'docs/stories/epic-1-a/1.1-new.md']),
    );
    const result = await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories');
    expect(result.stories).toEqual(['docs/stories/epic-1-a/1.1-new.md']);
  });

  it('ignores trees and submodule entries', async () => {
    getTree.mockResolvedValue({
      data: {
        truncated: false,
        tree: [
          { path: 'docs/stories/epic-1-a', type: 'tree', sha: 'a' },
          { path: 'docs/stories/epic-1-a/1.1-x.md', type: 'blob', sha: 'b' },
        ],
      },
    });
    const result = await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/stories');
    expect(result.stories).toEqual(['docs/stories/epic-1-a/1.1-x.md']);
    expect(result.blobShas).toEqual({ 'docs/stories/epic-1-a/1.1-x.md': 'b' });
  });

  it('honours a configured directory that is not the default', async () => {
    getTree.mockResolvedValue(tree(['docs/work/stories/epic-1-a/1.1-x.md']));
    const result = await listStoryFiles(octokit, 'o', 'r', 'main', 'docs/work/stories');
    expect(result.stories).toEqual(['docs/work/stories/epic-1-a/1.1-x.md']);
  });
});
