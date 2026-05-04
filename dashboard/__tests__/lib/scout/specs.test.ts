import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { scoutPendingSpecs, isSpecShaped } from '@/lib/scout/specs';
import type { MarkdownFile } from '@/lib/scout/repo-tree';

function mdFile(path: string): MarkdownFile {
  const filename = path.replace(/^.*\//, '');
  return { path, filename, slug: filename.replace(/\.md$/, '') };
}

function mockOctokit(opts: {
  /** Map from spec slug → issue search hits (count = .total_count) */
  issueSearchByQuery?: Record<string, number>;
  /** Map from spec path → file content (markdown) */
  specBodies?: Record<string, string>;
  searchError?: boolean;
}): Octokit {
  const getContent = vi.fn(async ({ path }: { path: string }) => {
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

describe('isSpecShaped', () => {
  it('matches date-prefixed filenames anywhere in the repo', () => {
    expect(isSpecShaped(mdFile('docs/2026-05-04-feature.md'))).toBe(true);
    expect(isSpecShaped(mdFile('2026-05-04-rfc.md'))).toBe(true);
    expect(isSpecShaped(mdFile('notes/2026-01-01-decision.md'))).toBe(true);
  });

  it('matches paths under specs/ design/ rfcs/', () => {
    expect(isSpecShaped(mdFile('specs/feature-x.md'))).toBe(true);
    expect(isSpecShaped(mdFile('docs/specs/foo.md'))).toBe(true);
    expect(isSpecShaped(mdFile('design/auth-flow.md'))).toBe(true);
    expect(isSpecShaped(mdFile('rfc/proposal.md'))).toBe(true);
    expect(isSpecShaped(mdFile('rfcs/0042-stuff.md'))).toBe(true);
    expect(isSpecShaped(mdFile('docs/design-docs/x.md'))).toBe(true);
  });

  it('rejects unrelated md files', () => {
    expect(isSpecShaped(mdFile('README.md'))).toBe(false);
    expect(isSpecShaped(mdFile('CHANGELOG.md'))).toBe(false);
    expect(isSpecShaped(mdFile('docs/architecture.md'))).toBe(false);
    expect(isSpecShaped(mdFile('notes/random.md'))).toBe(false);
  });
});

describe('scoutPendingSpecs', () => {
  it('returns empty when no md file looks spec-shaped', async () => {
    const octokit = mockOctokit({});
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', [
      mdFile('README.md'),
      mdFile('docs/architecture.md'),
    ]);
    expect(proposals).toEqual([]);
  });

  it('emits a proposal for a date-prefixed spec without tracking issue', async () => {
    const octokit = mockOctokit({
      issueSearchByQuery: {},
      specBodies: { 'docs/2026-05-15-foo.md': '# Foo Feature\n\nBody...' },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', [
      mdFile('docs/2026-05-15-foo.md'),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe('pending_spec');
    expect(proposals[0].group).toBe('carry_over');
    expect(proposals[0].title).toBe('Foo Feature');
    expect(proposals[0].url).toContain('docs/2026-05-15-foo.md');
    expect(proposals[0].meta?.spec_slug).toBe('2026-05-15-foo');
  });

  it('emits a proposal for any spec under specs/, regardless of filename', async () => {
    const octokit = mockOctokit({
      issueSearchByQuery: {},
      specBodies: { 'specs/auth-flow.md': '# Auth flow' },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', [
      mdFile('specs/auth-flow.md'),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toBe('Auth flow');
    expect(proposals[0].url).toContain('specs/auth-flow.md');
  });

  it('falls back to slug when the spec has no H1', async () => {
    const octokit = mockOctokit({
      specBodies: { 'specs/no-h1.md': 'No heading here.\nJust body.' },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', [
      mdFile('specs/no-h1.md'),
    ]);
    expect(proposals[0].title).toBe('no-h1');
  });

  it('drops specs that have a matching tracking issue', async () => {
    const octokit = mockOctokit({
      issueSearchByQuery: {
        '"in-flight" repo:q/r type:issue': 1,
        '"dangling" repo:q/r type:issue': 0,
      },
      specBodies: {
        'specs/in-flight.md': '# In flight',
        'specs/dangling.md': '# Dangling',
      },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', [
      mdFile('specs/in-flight.md'),
      mdFile('specs/dangling.md'),
    ]);
    expect(proposals.map((p) => p.meta?.spec_slug)).toEqual(['dangling']);
  });

  it('errs toward surfacing when search fails', async () => {
    const octokit = mockOctokit({
      searchError: true,
      specBodies: { 'specs/anything.md': '# Anything' },
    });
    const proposals = await scoutPendingSpecs(octokit, 'q', 'r', 'main', [
      mdFile('specs/anything.md'),
    ]);
    // Search rate-limited — we surface the spec rather than silently
    // hide a possibly-pending commitment.
    expect(proposals).toHaveLength(1);
  });
});
