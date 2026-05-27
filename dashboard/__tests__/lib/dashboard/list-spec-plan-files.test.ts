import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listSpecAndPlanFiles } from '@/lib/dashboard/list-spec-plan-files';

const getContent = vi.fn();
const octokit = { repos: { getContent } } as unknown as Parameters<
  typeof listSpecAndPlanFiles
>[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listSpecAndPlanFiles', () => {
  it('returns concatenated paths from both superpowers and legacy dirs', async () => {
    getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'docs/superpowers/specs') {
        return {
          data: [
            { type: 'file', name: '2026-05-01-foo-design.md' },
            { type: 'file', name: '2026-05-02-bar-design.md' },
            { type: 'dir', name: 'archive' },
          ],
        };
      }
      if (path === 'docs/specs') {
        return {
          data: [{ type: 'file', name: '2024-01-01-legacy-design.md' }],
        };
      }
      if (path === 'docs/superpowers/plans') {
        return {
          data: [{ type: 'file', name: '2026-05-01-foo.md' }],
        };
      }
      if (path === 'docs/plans') {
        return {
          data: [{ type: 'file', name: '2024-01-01-legacy.md' }],
        };
      }
      throw new Error('unexpected path');
    });

    const result = await listSpecAndPlanFiles(octokit, 'x', 'y', 'main');
    expect(result.specs).toEqual([
      'docs/superpowers/specs/2026-05-01-foo-design.md',
      'docs/superpowers/specs/2026-05-02-bar-design.md',
      'docs/specs/2024-01-01-legacy-design.md',
    ]);
    expect(result.plans).toEqual([
      'docs/superpowers/plans/2026-05-01-foo.md',
      'docs/plans/2024-01-01-legacy.md',
    ]);
  });

  it('returns empty arrays when no spec/plan dirs exist', async () => {
    getContent.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    const result = await listSpecAndPlanFiles(octokit, 'x', 'y', 'main');
    expect(result).toEqual({ specs: [], plans: [] });
  });

  it('treats a non-404 error on one dir as that dir being empty (continues other dirs)', async () => {
    getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === 'docs/superpowers/specs') throw new Error('rate limit');
      if (path === 'docs/specs') {
        return { data: [{ type: 'file', name: 'a.md' }] };
      }
      if (path === 'docs/superpowers/plans' || path === 'docs/plans') {
        return { data: [] };
      }
      throw new Error('unexpected path');
    });
    const result = await listSpecAndPlanFiles(octokit, 'x', 'y', 'main');
    expect(result.specs).toEqual(['docs/specs/a.md']);
    expect(result.plans).toEqual([]);
  });
});
