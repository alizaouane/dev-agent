import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { scoutPendingSpecs } from '@/lib/scout/specs';

type SpecListing = { path: string; type: string };

function mockOctokit(opts: {
  /** Files in the specs dir */
  specs?: SpecListing[];
  /** Path the listing call is expected at (default `docs/specs`). */
  specsDir?: string;
  /** Map from spec slug → list of issue search hits (count = .total_count) */
  issueSearchByQuery?: Record<string, number>;
  /** Map from spec path → file content (markdown) */
  specBodies?: Record<string, string>;
  specsListError?: number;
  searchError?: boolean;
}): Octokit {
  const expectedListing = opts.specsDir ?? 'docs/specs';
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (path === expectedListing) {
      if (opts.specsListError) {
        throw Object.assign(new Error('boom'), { status: opts.specsListError });
      }
      return { data: opts.specs ?? [] };
    }
    const body = opts.specBodies?.[path];
    if (body === undefined) {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    }
    return {
      data: {
        content: Buffer.from(body, 'utf8').toString('base64'),
        encoding: 'base64',
      },
    };
  });

  const search = {
    issuesAndPullRequests: vi.fn(async ({ q }: { q: string }) => {
      if (opts.searchError) {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      return { data: { total_count: opts.issueSearchByQuery?.[q] ?? 0 } };
    }),
  };

  return { repos: { getContent }, search } as unknown as Octokit;
}

describe('scoutPendingSpecs', () => {
  it('returns empty when there are no specs', async () => {
    const octokit = mockOctokit({ specs: [] });
    expect(await scoutPendingSpecs(octokit, 'q', 'r', 'main', 'docs/specs')).toEqual([]);
  });

  it('returns empty when docs/specs is missing', async () => {
    const octokit = mockOctokit({ specsListError: 404 });
    expect(await scoutPendingSpecs(octokit, 'q', 'r', 'main', 'docs/specs')).toEqual([]);
  });

  it('emits a pending_spec proposal for a spec with no tracking issue', async () => {
    const octokit = mockOctokit({
      specs: [{ path: 'docs/specs/2026-05-15-foo.md', type: 'file' }],
      issueSearchByQuery: {}, // no matches
      specBodies: {
        'docs/specs/2026-05-15-foo.md': '# Foo Feature\n\nBody...',
      },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', 'docs/specs');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe('pending_spec');
    expect(proposals[0].group).toBe('carry_over');
    expect(proposals[0].title).toBe('Foo Feature');
    expect(proposals[0].url).toContain('docs/specs/2026-05-15-foo.md');
    expect(proposals[0].meta?.spec_slug).toBe('2026-05-15-foo');
  });

  it('falls back to slug when the spec has no H1', async () => {
    const octokit = mockOctokit({
      specs: [{ path: 'docs/specs/no-h1.md', type: 'file' }],
      specBodies: { 'docs/specs/no-h1.md': 'No heading here.\nJust body.' },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', 'docs/specs');
    expect(proposals[0].title).toBe('no-h1');
  });

  it('drops specs that have a matching tracking issue', async () => {
    const octokit = mockOctokit({
      specs: [
        { path: 'docs/specs/in-flight.md', type: 'file' },
        { path: 'docs/specs/dangling.md', type: 'file' },
      ],
      issueSearchByQuery: {
        '"in-flight" repo:q/r type:issue': 1,
        '"dangling" repo:q/r type:issue': 0,
      },
      specBodies: {
        'docs/specs/in-flight.md': '# In flight',
        'docs/specs/dangling.md': '# Dangling',
      },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', 'docs/specs');
    expect(proposals.map((p) => p.meta?.spec_slug)).toEqual(['dangling']);
  });

  it('errs toward surfacing when search fails', async () => {
    const octokit = mockOctokit({
      specs: [{ path: 'docs/specs/anything.md', type: 'file' }],
      searchError: true,
      specBodies: { 'docs/specs/anything.md': '# Anything' },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', 'docs/specs');
    // Search rate-limited — we surface the spec rather than silently
    // hide a possibly-pending commitment.
    expect(proposals).toHaveLength(1);
  });

  it('honors a custom specs_dir from .dev-agent.yml', async () => {
    const octokit = mockOctokit({
      specsDir: 'specs',
      specs: [{ path: 'specs/2026-05-15-foo.md', type: 'file' }],
      issueSearchByQuery: {},
      specBodies: { 'specs/2026-05-15-foo.md': '# Foo' },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', 'specs');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].url).toContain('specs/2026-05-15-foo.md');
    expect(proposals[0].meta?.spec_path).toBe('specs/2026-05-15-foo.md');
  });

  it('skips non-markdown entries in docs/specs/', async () => {
    const octokit = mockOctokit({
      specs: [
        { path: 'docs/specs/real.md', type: 'file' },
        { path: 'docs/specs/diagram.png', type: 'file' },
        { path: 'docs/specs/subdir', type: 'dir' },
      ],
      specBodies: { 'docs/specs/real.md': '# Real spec' },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', 'docs/specs');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].meta?.spec_slug).toBe('real');
  });
});
