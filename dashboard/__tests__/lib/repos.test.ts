import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { listAllowedRepos, wiredRepos, type RepoInfo } from '@/lib/repos';

type RepoFixture = {
  name: string;
  default_branch: string;
  html_url?: string;
  description?: string | null;
  owner?: { login: string; type?: string };
};

/**
 * Build a minimal Octokit-shaped object that satisfies the call sites in
 * `listAllowedRepos`. Mocks two list endpoints and `getContent` for the
 * .dev-agent.yml probe.
 */
function mockOctokit(opts: {
  authenticatedUserRepos?: RepoFixture[];
  reposByOrg?: Record<string, RepoFixture[]>;
  hasDevAgentYml?: (owner: string, repo: string) => boolean;
  failOrgs?: string[];
  failAuthenticated?: boolean;
}): Octokit {
  const hasDevAgentYml = opts.hasDevAgentYml ?? (() => false);
  const reposByOrg = opts.reposByOrg ?? {};
  const failOrgs = opts.failOrgs ?? [];
  const authRepos = opts.authenticatedUserRepos ?? [];

  const listForAuthenticatedUser = vi.fn(async () => ({ data: authRepos }));
  const listForOrg = vi.fn(async ({ org }: { org: string }) => ({
    data: reposByOrg[org] ?? [],
  }));

  const getContent = vi.fn(async ({ owner, repo }: { owner: string; repo: string }) => {
    if (hasDevAgentYml(owner, repo)) {
      return { data: { type: 'file', size: 100 } };
    }
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    throw err;
  });

  const paginate = vi.fn(
    async (
      fn: (args: Record<string, unknown>) => Promise<{ data: RepoFixture[] }>,
      args: Record<string, unknown>,
    ) => {
      // The mock vi.fn types prevent direct identity comparison; cast to
      // unknown for identity matching.
      const fnAny = fn as unknown;
      if (fnAny === (listForOrg as unknown) && failOrgs.includes(String(args.org))) {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }
      if (fnAny === (listForAuthenticatedUser as unknown) && opts.failAuthenticated) {
        throw Object.assign(new Error('Server Error'), { status: 500 });
      }
      const res = await fn(args);
      return res.data;
    },
  );

  return {
    repos: { listForAuthenticatedUser, listForOrg, getContent },
    paginate,
  } as unknown as Octokit;
}

const personalRepo = (name: string, owner = 'alizaouane', extras: Partial<RepoFixture> = {}): RepoFixture => ({
  name,
  default_branch: 'main',
  html_url: `https://github.com/${owner}/${name}`,
  description: null,
  owner: { login: owner, type: 'User' },
  ...extras,
});

const orgRepo = (name: string, extras: Partial<RepoFixture> = {}): RepoFixture => ({
  name,
  default_branch: 'main',
  html_url: `https://example.com/${name}`,
  description: null,
  ...extras,
});

describe('listAllowedRepos', () => {
  beforeEach(() => {
    delete process.env.ALLOWED_GH_ORGS;
    delete process.env.ALLOWED_GH_USERNAMES;
  });

  it('returns personal repos for the authenticated user when no allowlist is set', async () => {
    const octokit = mockOctokit({
      authenticatedUserRepos: [personalRepo('caliente-booking-app'), personalRepo('side-project')],
    });
    const repos = await listAllowedRepos(octokit);
    expect(repos.map((r) => r.name).sort()).toEqual(['caliente-booking-app', 'side-project']);
    expect(repos.every((r) => r.owner === 'alizaouane')).toBe(true);
  });

  it('marks repos with .dev-agent.yml as wired_up; others remain visible', async () => {
    const octokit = mockOctokit({
      authenticatedUserRepos: [personalRepo('wired-repo'), personalRepo('unwired-repo')],
      hasDevAgentYml: (_owner, repo) => repo === 'wired-repo',
    });
    const repos = await listAllowedRepos(octokit);
    expect(repos).toHaveLength(2);
    const wired = repos.find((r) => r.name === 'wired-repo');
    const unwired = repos.find((r) => r.name === 'unwired-repo');
    expect(wired?.wired_up).toBe(true);
    expect(unwired?.wired_up).toBe(false);
  });

  it('respects ALLOWED_GH_USERNAMES filter on personal repos', async () => {
    process.env.ALLOWED_GH_USERNAMES = 'alizaouane';
    const octokit = mockOctokit({
      authenticatedUserRepos: [
        personalRepo('mine', 'alizaouane'),
        personalRepo('not-mine', 'someone-else'),
      ],
    });
    const repos = await listAllowedRepos(octokit);
    expect(repos.map((r) => r.name)).toEqual(['mine']);
  });

  it('lists allowlisted org repos in addition to personal', async () => {
    process.env.ALLOWED_GH_ORGS = 'qualiency';
    const octokit = mockOctokit({
      authenticatedUserRepos: [personalRepo('personal-1')],
      reposByOrg: { qualiency: [orgRepo('org-repo-a'), orgRepo('org-repo-b')] },
    });
    const repos = await listAllowedRepos(octokit);
    expect(repos.map((r) => r.name).sort()).toEqual(['org-repo-a', 'org-repo-b', 'personal-1']);
    expect(repos.find((r) => r.name === 'personal-1')?.owner).toBe('alizaouane');
    expect(repos.find((r) => r.name === 'org-repo-a')?.owner).toBe('qualiency');
  });

  it('dedupes repos surfaced by both listForAuthenticatedUser (org-typed) and listForOrg', async () => {
    // listForAuthenticatedUser returns BOTH user-owned + org-membership repos.
    // The candidates Map keys by owner/name so the same repo from both
    // sources collapses to a single entry.
    process.env.ALLOWED_GH_ORGS = 'qualiency';
    const octokit = mockOctokit({
      authenticatedUserRepos: [
        personalRepo('mine', 'alizaouane'),
        // Same repo also appears via listForAuthenticatedUser (org-typed).
        personalRepo('shared', 'qualiency', { owner: { login: 'qualiency', type: 'Organization' } }),
      ],
      reposByOrg: { qualiency: [orgRepo('shared'), orgRepo('only-via-org')] },
    });
    const repos = await listAllowedRepos(octokit);
    const names = repos.map((r) => `${r.owner}/${r.name}`).sort();
    expect(names.filter((n) => n === 'qualiency/shared')).toHaveLength(1);
    expect(names).toEqual(['alizaouane/mine', 'qualiency/only-via-org', 'qualiency/shared']);
  });

  it('includes org-typed repos from listForAuthenticatedUser when ALLOWED_GH_ORGS is unset', async () => {
    // Regression for CodeRabbit P2: a user admitted via ALLOWED_GH_USERNAMES
    // who primarily works in org-owned repos should see those repos too.
    // Without org-pass crawling (no ALLOWED_GH_ORGS), the org-typed entries
    // from listForAuthenticatedUser are the ONLY way they surface — so we
    // must NOT skip them.
    process.env.ALLOWED_GH_USERNAMES = 'alizaouane';
    delete process.env.ALLOWED_GH_ORGS;
    const octokit = mockOctokit({
      authenticatedUserRepos: [
        personalRepo('mine', 'alizaouane'),
        personalRepo('caliente-booking', 'qualiency', { owner: { login: 'qualiency', type: 'Organization' } }),
      ],
    });
    const repos = await listAllowedRepos(octokit);
    expect(repos.map((r) => `${r.owner}/${r.name}`).sort()).toEqual([
      'alizaouane/mine',
      'qualiency/caliente-booking',
    ]);
  });

  it('filters org-typed repos by ALLOWED_GH_ORGS when both allowlists are set', async () => {
    // If ALLOWED_GH_ORGS=qualiency is set, an org-typed repo from a
    // different org (acme) returned by listForAuthenticatedUser should
    // NOT be surfaced — the user is opting into specific orgs.
    process.env.ALLOWED_GH_USERNAMES = 'alizaouane';
    process.env.ALLOWED_GH_ORGS = 'qualiency';
    const octokit = mockOctokit({
      authenticatedUserRepos: [
        personalRepo('mine', 'alizaouane'),
        personalRepo('q-repo', 'qualiency', { owner: { login: 'qualiency', type: 'Organization' } }),
        personalRepo('acme-repo', 'acme', { owner: { login: 'acme', type: 'Organization' } }),
      ],
      reposByOrg: { qualiency: [] },
    });
    const repos = await listAllowedRepos(octokit);
    expect(repos.map((r) => `${r.owner}/${r.name}`).sort()).toEqual([
      'alizaouane/mine',
      'qualiency/q-repo',
    ]);
  });

  it('returns empty array (and logs) when the user has no accessible repos', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const octokit = mockOctokit({ failAuthenticated: true });
    const repos = await listAllowedRepos(octokit);
    expect(repos).toEqual([]);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('keeps going when one allowed org fails to list', async () => {
    process.env.ALLOWED_GH_ORGS = 'good,bad';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const octokit = mockOctokit({
      authenticatedUserRepos: [personalRepo('user-repo')],
      reposByOrg: { good: [orgRepo('survivor')] },
      failOrgs: ['bad'],
    });
    const repos = await listAllowedRepos(octokit);
    expect(repos.map((r) => r.name).sort()).toEqual(['survivor', 'user-repo']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/bad/), expect.anything());
    warnSpy.mockRestore();
  });

  it('sorts wired repos before unwired, then alphabetically', async () => {
    const octokit = mockOctokit({
      authenticatedUserRepos: [
        personalRepo('zzz-unwired'),
        personalRepo('aaa-unwired'),
        personalRepo('mmm-wired'),
      ],
      hasDevAgentYml: (_owner, repo) => repo === 'mmm-wired',
    });
    const repos = await listAllowedRepos(octokit);
    expect(repos.map((r) => r.name)).toEqual(['mmm-wired', 'aaa-unwired', 'zzz-unwired']);
  });
});

describe('wiredRepos', () => {
  it('filters to only repos with wired_up: true', () => {
    const repos: RepoInfo[] = [
      { owner: 'a', name: 'wired', default_branch: 'main', wired_up: true, html_url: '', description: null },
      { owner: 'a', name: 'unwired', default_branch: 'main', wired_up: false, html_url: '', description: null },
    ];
    expect(wiredRepos(repos)).toEqual([repos[0]]);
  });
});
