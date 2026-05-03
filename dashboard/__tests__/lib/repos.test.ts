import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { listAllowedRepos } from '@/lib/repos';

type RepoFixture = { name: string; default_branch: string };

/**
 * Build a minimal Octokit-shaped object that satisfies the call sites used
 * inside `listAllowedRepos`. We bypass the real `paginate` machinery — our
 * mock simply invokes the supplied request function once and returns its
 * `data` array. The implementation is expected to call:
 *   octokit.paginate(octokit.repos.listForOrg, { org, ... })
 *   octokit.repos.getContent({ owner, repo, path, ref })
 */
function mockOctokit(opts: {
  reposByOrg: Record<string, RepoFixture[]>;
  hasDevAgentYml: (repo: string) => boolean;
}): Octokit {
  const listForOrg = vi.fn(async ({ org }: { org: string }) => ({
    data: opts.reposByOrg[org] ?? [],
  }));

  const getContent = vi.fn(async ({ repo }: { repo: string }) => {
    if (opts.hasDevAgentYml(repo)) {
      return { data: { type: 'file', size: 100 } };
    }
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    throw err;
  });

  const paginate = vi.fn(
    async (
      fn: (args: { org: string }) => Promise<{ data: RepoFixture[] }>,
      args: { org: string },
    ) => {
      const res = await fn(args);
      return res.data;
    },
  );

  return {
    repos: { listForOrg, getContent },
    paginate,
  } as unknown as Octokit;
}

describe('listAllowedRepos', () => {
  beforeEach(() => {
    delete process.env.ALLOWED_GH_ORGS;
  });

  it('returns only repos that have .dev-agent.yml', async () => {
    process.env.ALLOWED_GH_ORGS = 'qualiency';
    const octokit = mockOctokit({
      reposByOrg: {
        qualiency: [
          { name: 'caliente-booking', default_branch: 'main' },
          { name: 'qualiency-app', default_branch: 'main' },
          { name: 'no-dev-agent', default_branch: 'main' },
        ],
      },
      hasDevAgentYml: (r) => r !== 'no-dev-agent',
    });
    const repos = await listAllowedRepos(octokit);
    expect(repos).toHaveLength(2);
    expect(repos.map((r) => r.name).sort()).toEqual(['caliente-booking', 'qualiency-app']);
    for (const r of repos) {
      expect(r.owner).toBe('qualiency');
      expect(r.default_branch).toBe('main');
    }
  });

  it('returns empty array when no orgs are allowlisted', async () => {
    delete process.env.ALLOWED_GH_ORGS;
    const octokit = mockOctokit({ reposByOrg: {}, hasDevAgentYml: () => false });
    const repos = await listAllowedRepos(octokit);
    expect(repos).toEqual([]);
  });

  it('aggregates across multiple allowed orgs', async () => {
    process.env.ALLOWED_GH_ORGS = 'qualiency,acme';
    const octokit = mockOctokit({
      reposByOrg: {
        qualiency: [{ name: 'a', default_branch: 'main' }],
        acme: [{ name: 'b', default_branch: 'main' }],
      },
      hasDevAgentYml: () => true,
    });
    const repos = await listAllowedRepos(octokit);
    expect(repos).toHaveLength(2);
    expect(repos.map((r) => r.name).sort()).toEqual(['a', 'b']);
    expect(repos.map((r) => r.owner).sort()).toEqual(['acme', 'qualiency']);
  });

  it('keeps going when one org fails (e.g. 404 listForOrg)', async () => {
    process.env.ALLOWED_GH_ORGS = 'good,bad';
    const octokit = mockOctokit({
      reposByOrg: { good: [{ name: 'g', default_branch: 'main' }] },
      hasDevAgentYml: () => true,
    });
    // Override paginate to reject for 'bad'
    (octokit.paginate as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        fn: (args: { org: string }) => Promise<{ data: RepoFixture[] }>,
        args: { org: string },
      ) => {
        if (args.org === 'bad') {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }
        const res = await fn(args);
        return res.data;
      },
    );
    // The implementation logs a warning when an org fails — suppress it to
    // keep test output clean while still asserting the warn happened.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repos = await listAllowedRepos(octokit);
    expect(repos.map((r) => r.name)).toEqual(['g']);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/bad/);
    warnSpy.mockRestore();
  });
});
