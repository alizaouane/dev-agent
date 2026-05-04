import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { listMarkdownFiles } from '@/lib/scout/repo-tree';

function mockOctokit(opts: {
  treeSha?: string;
  tree?: Array<{ path: string; type: string }>;
  branchError?: number;
  treeError?: number;
}): Octokit {
  const getBranch = vi.fn(async () => {
    if (opts.branchError) {
      throw Object.assign(new Error('boom'), { status: opts.branchError });
    }
    return { data: { commit: { commit: { tree: { sha: opts.treeSha ?? 'tree-sha' } } } } };
  });
  const getTree = vi.fn(async () => {
    if (opts.treeError) {
      throw Object.assign(new Error('boom'), { status: opts.treeError });
    }
    return { data: { tree: opts.tree ?? [] } };
  });
  return {
    repos: { getBranch },
    git: { getTree },
  } as unknown as Octokit;
}

describe('listMarkdownFiles', () => {
  it('returns md files from the recursive tree, ignoring non-blob and non-md entries', async () => {
    const octokit = mockOctokit({
      tree: [
        { path: 'README.md', type: 'blob' },
        { path: 'src/index.ts', type: 'blob' },
        { path: 'docs', type: 'tree' },
        { path: 'docs/plans/a.md', type: 'blob' },
        { path: 'specs/feature.md', type: 'blob' },
        { path: 'image.png', type: 'blob' },
      ],
    });
    const files = await listMarkdownFiles(octokit, 'q', 'r', 'main');
    expect(files.map((f) => f.path)).toEqual([
      'README.md',
      'docs/plans/a.md',
      'specs/feature.md',
    ]);
  });

  it('parses filename and slug from path', async () => {
    const octokit = mockOctokit({
      tree: [{ path: 'docs/plans/2026-05-04-foo.md', type: 'blob' }],
    });
    const files = await listMarkdownFiles(octokit, 'q', 'r', 'main');
    expect(files[0]).toEqual({
      path: 'docs/plans/2026-05-04-foo.md',
      filename: '2026-05-04-foo.md',
      slug: '2026-05-04-foo',
    });
  });

  it('excludes node_modules, dist, build, .next, and other vendored noise', async () => {
    const octokit = mockOctokit({
      tree: [
        { path: 'node_modules/lib/README.md', type: 'blob' },
        { path: 'dist/output.md', type: 'blob' },
        { path: 'build/manifest.md', type: 'blob' },
        { path: '.next/cache/foo.md', type: 'blob' },
        { path: 'coverage/report.md', type: 'blob' },
        { path: 'vendor/x/notes.md', type: 'blob' },
        { path: 'docs/keep.md', type: 'blob' },
      ],
    });
    const files = await listMarkdownFiles(octokit, 'q', 'r', 'main');
    expect(files.map((f) => f.path)).toEqual(['docs/keep.md']);
  });

  it('also excludes nested vendored directories (sub/node_modules/x.md)', async () => {
    const octokit = mockOctokit({
      tree: [
        { path: 'apps/x/node_modules/lib/foo.md', type: 'blob' },
        { path: 'docs/keep.md', type: 'blob' },
      ],
    });
    const files = await listMarkdownFiles(octokit, 'q', 'r', 'main');
    expect(files.map((f) => f.path)).toEqual(['docs/keep.md']);
  });

  it('excludes `.claude/` and `.github/` template directories', async () => {
    // Slash-command templates and skill SKILL.md files in `.claude/` are
    // placeholders meant to be filled in when the command runs, not work
    // items. Same for issue/PR templates in `.github/`. A naive walker
    // surfaces their unchecked checkboxes as proposals — the noise the
    // user flagged on the screenshot.
    const octokit = mockOctokit({
      tree: [
        { path: '.claude/commands/feature-contract.md', type: 'blob' },
        { path: '.claude/skills/foo/SKILL.md', type: 'blob' },
        { path: '.github/PULL_REQUEST_TEMPLATE.md', type: 'blob' },
        { path: '.github/ISSUE_TEMPLATE/bug.md', type: 'blob' },
        { path: 'docs/real-plan.md', type: 'blob' },
      ],
    });
    const files = await listMarkdownFiles(octokit, 'q', 'r', 'main');
    expect(files.map((f) => f.path)).toEqual(['docs/real-plan.md']);
  });

  it('caps results at 200 to bound downstream API cost', async () => {
    const tree = Array.from({ length: 250 }, (_, i) => ({
      path: `docs/plans/file-${i}.md`,
      type: 'blob' as const,
    }));
    const octokit = mockOctokit({ tree });
    const files = await listMarkdownFiles(octokit, 'q', 'r', 'main');
    expect(files.length).toBe(200);
  });

  it('returns empty when getBranch fails (e.g. empty repo)', async () => {
    const octokit = mockOctokit({ branchError: 404 });
    const files = await listMarkdownFiles(octokit, 'q', 'r', 'main');
    expect(files).toEqual([]);
  });

  it('returns empty when getTree fails', async () => {
    const octokit = mockOctokit({ treeError: 502 });
    const files = await listMarkdownFiles(octokit, 'q', 'r', 'main');
    expect(files).toEqual([]);
  });
});
