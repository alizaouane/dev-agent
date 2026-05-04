import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { scoutSpecDrift } from '@/lib/scout/drift';

type SearchItem = { path: string; html_url: string };

function mockOctokit(opts: {
  specs?: string[];
  /** Map from search query to its matched items. */
  searchByQuery?: Record<string, SearchItem[]>;
  specsListError?: number;
  searchError?: boolean;
}): Octokit {
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (path === 'docs/specs') {
      if (opts.specsListError) {
        throw Object.assign(new Error('boom'), { status: opts.specsListError });
      }
      return {
        data: (opts.specs ?? []).map((slug) => ({
          path: `docs/specs/${slug}.md`,
          type: 'file',
        })),
      };
    }
    throw Object.assign(new Error('Not Found'), { status: 404 });
  });

  const search = {
    code: vi.fn(async ({ q }: { q: string }) => {
      if (opts.searchError) {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      const items = opts.searchByQuery?.[q] ?? [];
      return { data: { items } };
    }),
  };

  return { repos: { getContent }, search } as unknown as Octokit;
}

describe('scoutSpecDrift', () => {
  it('returns empty when there are no specs', async () => {
    const octokit = mockOctokit({ specs: [] });
    expect(await scoutSpecDrift(octokit, 'q', 'r', 'main')).toEqual([]);
  });

  it('returns empty when docs/specs is missing', async () => {
    const octokit = mockOctokit({ specsListError: 404 });
    expect(await scoutSpecDrift(octokit, 'q', 'r', 'main')).toEqual([]);
  });

  it('emits a drift proposal per file matched by `TODO(<slug>)`', async () => {
    const octokit = mockOctokit({
      specs: ['auth-rewrite'],
      searchByQuery: {
        '"TODO(auth-rewrite)" repo:q/r': [
          { path: 'lib/auth/session.ts', html_url: 'https://github.com/q/r/blob/main/lib/auth/session.ts' },
          { path: 'lib/auth/middleware.ts', html_url: 'https://github.com/q/r/blob/main/lib/auth/middleware.ts' },
        ],
      },
    });
    const proposals = await scoutSpecDrift(octokit, 'q', 'r', 'main');
    expect(proposals).toHaveLength(2);
    expect(proposals[0].source).toBe('spec_drift');
    expect(proposals[0].group).toBe('carry_over');
    expect(proposals[0].title).toBe('Spec drift: auth-rewrite');
    expect(proposals.map((p) => p.meta?.code_file).sort()).toEqual([
      'lib/auth/middleware.ts',
      'lib/auth/session.ts',
    ]);
  });

  it('also matches `FIXME(<slug>)` and dedupes by file', async () => {
    const octokit = mockOctokit({
      specs: ['payments-v2'],
      searchByQuery: {
        '"TODO(payments-v2)" repo:q/r': [
          { path: 'lib/payments/charge.ts', html_url: 'https://github.com/q/r/blob/main/lib/payments/charge.ts' },
        ],
        '"FIXME(payments-v2)" repo:q/r': [
          // Same file as the TODO match — dedupe should collapse to one proposal.
          { path: 'lib/payments/charge.ts', html_url: 'https://github.com/q/r/blob/main/lib/payments/charge.ts' },
          { path: 'lib/payments/refund.ts', html_url: 'https://github.com/q/r/blob/main/lib/payments/refund.ts' },
        ],
      },
    });
    const proposals = await scoutSpecDrift(octokit, 'q', 'r', 'main');
    expect(proposals.map((p) => p.meta?.code_file).sort()).toEqual([
      'lib/payments/charge.ts',
      'lib/payments/refund.ts',
    ]);
  });

  it('handles multiple specs with parallel searches', async () => {
    const octokit = mockOctokit({
      specs: ['a', 'b'],
      searchByQuery: {
        '"TODO(a)" repo:q/r': [{ path: 'src/a.ts', html_url: '' }],
        '"TODO(b)" repo:q/r': [{ path: 'src/b.ts', html_url: '' }],
      },
    });
    const proposals = await scoutSpecDrift(octokit, 'q', 'r', 'main');
    expect(proposals.map((p) => p.meta?.spec_slug).sort()).toEqual(['a', 'b']);
  });

  it('returns empty for a slug with no matches', async () => {
    const octokit = mockOctokit({ specs: ['unused-spec'], searchByQuery: {} });
    const proposals = await scoutSpecDrift(octokit, 'q', 'r', 'main');
    expect(proposals).toEqual([]);
  });

  it('degrades gracefully when search rate-limits', async () => {
    const octokit = mockOctokit({ specs: ['a'], searchError: true });
    const proposals = await scoutSpecDrift(octokit, 'q', 'r', 'main');
    expect(proposals).toEqual([]);
  });

  it('caps results per slug at MAX_MATCHES_PER_SLUG (5)', async () => {
    const items: SearchItem[] = Array.from({ length: 10 }, (_, i) => ({
      path: `src/file${i}.ts`,
      html_url: `https://github.com/q/r/blob/main/src/file${i}.ts`,
    }));
    const octokit = mockOctokit({
      specs: ['big'],
      searchByQuery: { '"TODO(big)" repo:q/r': items },
    });
    const proposals = await scoutSpecDrift(octokit, 'q', 'r', 'main');
    expect(proposals.length).toBe(5);
  });
});
