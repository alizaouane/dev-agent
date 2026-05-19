import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import {
  parseRepoFromProposalId,
  expiryDate,
  pruneExpired,
  partitionBySnooze,
  loadSnoozesForRepo,
  loadSnoozeMap,
  snoozeProposalPersistent,
  unsnoozeProposalPersistent,
} from '@/lib/scout/snooze';
import type { Proposal } from '@/lib/scout';

const fakeProposal = (id: string, group: 'carry_over' | 'new_idea' = 'carry_over'): Proposal => ({
  id,
  source: 'unfinished_plan',
  group,
  repo: 'q/r',
  title: 'A thing',
  description: 'Whatever',
  url: 'https://example.com',
});

describe('parseRepoFromProposalId', () => {
  it('extracts owner + repo from a standard proposal id', () => {
    expect(parseRepoFromProposalId('unfinished_plan:q/whatsapp:plan.md#L5')).toEqual({
      owner: 'q',
      repo: 'whatsapp',
    });
    expect(parseRepoFromProposalId('bug_scout_finding:alizaouane/whatsapp-console:42')).toEqual({
      owner: 'alizaouane',
      repo: 'whatsapp-console',
    });
  });

  it('returns null for malformed ids', () => {
    expect(parseRepoFromProposalId('no-source-segment')).toBeNull();
    expect(parseRepoFromProposalId('unfinished_plan:no-slash:key')).toBeNull();
    expect(parseRepoFromProposalId('unfinished_plan:q/r-no-trailing-key')).toBeNull();
  });
});

describe('expiryDate', () => {
  it('adds days in UTC', () => {
    const now = new Date('2026-05-05T14:00:00Z');
    expect(expiryDate(now, 7)).toBe('2026-05-12');
  });
  it('defaults to 7 days', () => {
    const now = new Date('2026-05-05T14:00:00Z');
    expect(expiryDate(now)).toBe('2026-05-12');
  });
});

describe('pruneExpired', () => {
  it('keeps entries whose expiry is today or future', () => {
    const now = new Date('2026-05-05T14:00:00Z');
    const out = pruneExpired(
      [
        { id: 'a', expires: '2026-05-04' }, // past
        { id: 'b', expires: '2026-05-05' }, // today — kept
        { id: 'c', expires: '2026-05-06' }, // future
      ],
      now,
    );
    expect(out.map((e) => e.id)).toEqual(['b', 'c']);
  });
});

describe('partitionBySnooze (pure)', () => {
  it('splits proposals based on the snooze map', () => {
    const map = new Map([
      ['unfinished_plan:q/r:p2', '2026-05-12'],
    ]);
    const proposals = [
      fakeProposal('unfinished_plan:q/r:p1'),
      fakeProposal('unfinished_plan:q/r:p2'),
      fakeProposal('unfinished_plan:q/r:p3'),
    ];
    const { active, snoozed } = partitionBySnooze(proposals, map);
    expect(active.map((p) => p.id)).toEqual(['unfinished_plan:q/r:p1', 'unfinished_plan:q/r:p3']);
    expect(snoozed.map((p) => p.id)).toEqual(['unfinished_plan:q/r:p2']);
  });
});

describe('loadSnoozesForRepo', () => {
  function mkOctokit(opts: {
    pmMd?: string;
    status?: number;
  }): Octokit {
    return {
      repos: {
        getContent: vi.fn(async () => {
          if (opts.status) {
            throw Object.assign(new Error('boom'), { status: opts.status });
          }
          return {
            data: {
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(opts.pmMd ?? '').toString('base64'),
            },
          };
        }),
      },
    } as unknown as Octokit;
  }

  it('returns the snoozed_proposals list (with expired entries pruned)', async () => {
    const pmMd = [
      '---',
      'snoozed_proposals:',
      '  - id: "unfinished_plan:q/r:p1"',
      '    expires: "2026-05-12"',
      '  - id: "unfinished_plan:q/r:p2"',
      '    expires: "2026-04-01"', // past
      '---',
      '',
      'body',
    ].join('\n');
    const octokit = mkOctokit({ pmMd });
    const out = await loadSnoozesForRepo(octokit, 'q', 'r', 'main', new Date('2026-05-05T00:00:00Z'));
    expect(out).toEqual([{ id: 'unfinished_plan:q/r:p1', expires: '2026-05-12' }]);
  });

  it('returns [] when pm.md does not exist (404)', async () => {
    const octokit = mkOctokit({ status: 404 });
    expect(await loadSnoozesForRepo(octokit, 'q', 'r', 'main')).toEqual([]);
  });

  it('returns [] when pm.md frontmatter is malformed (graceful degrade)', async () => {
    const octokit = mkOctokit({ pmMd: '---\nnot: valid: yaml: : :\n---\n' });
    expect(await loadSnoozesForRepo(octokit, 'q', 'r', 'main')).toEqual([]);
  });
});

describe('loadSnoozeMap (multi-repo)', () => {
  it('merges snooze entries across multiple repos', async () => {
    const buildPmMd = (id: string): string =>
      [
        '---',
        'snoozed_proposals:',
        `  - id: "${id}"`,
        '    expires: "2026-05-12"',
        '---',
        '',
      ].join('\n');

    const getContent = vi.fn(async ({ owner }: { owner: string }) => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(
          buildPmMd(`unfinished_plan:${owner}/r:p1`),
        ).toString('base64'),
      },
    }));
    const octokit = { repos: { getContent } } as unknown as Octokit;

    const map = await loadSnoozeMap(
      octokit,
      [
        { owner: 'a', name: 'r', default_branch: 'main' },
        { owner: 'b', name: 'r', default_branch: 'main' },
      ],
      // Fixed `now` before the entries' 2026-05-12 expiry. Without it the
      // test uses the real clock, so pruneExpired drops the entries once
      // the wall-clock date passes 2026-05-12 — a time-bomb failure.
      new Date('2026-05-05T00:00:00Z'),
    );
    expect(map.get('unfinished_plan:a/r:p1')).toBe('2026-05-12');
    expect(map.get('unfinished_plan:b/r:p1')).toBe('2026-05-12');
  });

  it('per-repo failures degrade silently (other repos still load)', async () => {
    const getContent = vi.fn(async ({ owner }: { owner: string }) => {
      if (owner === 'broken') throw Object.assign(new Error('boom'), { status: 500 });
      return {
        data: {
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(
            ['---', 'snoozed_proposals:', '  - id: "x"', '    expires: "2099-01-01"', '---', ''].join('\n'),
          ).toString('base64'),
        },
      };
    });
    const octokit = { repos: { getContent } } as unknown as Octokit;

    const map = await loadSnoozeMap(octokit, [
      { owner: 'broken', name: 'r', default_branch: 'main' },
      { owner: 'ok', name: 'r', default_branch: 'main' },
    ]);
    expect(map.get('x')).toBe('2099-01-01');
  });
});

describe('snoozeProposalPersistent (Octokit write)', () => {
  function mkOctokit(opts: {
    pmMd?: string;
    pmMdSha?: string;
    pmMdStatus?: number;
  }): {
    octokit: Octokit;
    createOrUpdate: ReturnType<typeof vi.fn>;
  } {
    const createOrUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = {
      repos: {
        get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
        getContent: vi.fn(async () => {
          if (opts.pmMdStatus) {
            throw Object.assign(new Error('boom'), { status: opts.pmMdStatus });
          }
          return {
            data: {
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(opts.pmMd ?? '').toString('base64'),
              sha: opts.pmMdSha,
            },
          };
        }),
        createOrUpdateFileContents: createOrUpdate,
      },
    } as unknown as Octokit;
    return { octokit, createOrUpdate };
  }

  it('creates pm.md with a snoozed_proposals entry when pm.md is missing', async () => {
    const { octokit, createOrUpdate } = mkOctokit({ pmMdStatus: 404 });
    await snoozeProposalPersistent(
      octokit,
      'unfinished_plan:q/r:p1',
      7,
      new Date('2026-05-05T00:00:00Z'),
    );
    expect(createOrUpdate).toHaveBeenCalled();
    const call = createOrUpdate.mock.calls[0]?.[0] as { content?: string; sha?: string };
    expect(call?.sha).toBeUndefined();
    const decoded = Buffer.from(call?.content ?? '', 'base64').toString('utf8');
    expect(decoded).toContain('snoozed_proposals:');
    expect(decoded).toContain('unfinished_plan:q/r:p1');
    expect(decoded).toContain('2026-05-12');
  });

  it('appends to an existing pm.md preserving other frontmatter', async () => {
    const pmMd = [
      '---',
      'goals:',
      '  near_term: "ship X"',
      'avoid:',
      '  - "scope creep"',
      '---',
      '',
      '# Existing notes',
    ].join('\n');
    const { octokit, createOrUpdate } = mkOctokit({ pmMd, pmMdSha: 'sha-abc' });
    await snoozeProposalPersistent(
      octokit,
      'unfinished_plan:q/r:p1',
      7,
      new Date('2026-05-05T00:00:00Z'),
    );
    const call = createOrUpdate.mock.calls[0]?.[0] as { content?: string; sha?: string };
    expect(call?.sha).toBe('sha-abc');
    const decoded = Buffer.from(call?.content ?? '', 'base64').toString('utf8');
    expect(decoded).toContain('goals:');
    expect(decoded).toContain('ship X');
    expect(decoded).toContain('snoozed_proposals:');
    expect(decoded).toContain('# Existing notes');
  });

  it('prunes expired entries and overwrites duplicate ids on re-snooze', async () => {
    const pmMd = [
      '---',
      'snoozed_proposals:',
      '  - id: "unfinished_plan:q/r:expired"',
      '    expires: "2026-04-01"', // past
      '  - id: "unfinished_plan:q/r:p1"',
      '    expires: "2026-05-06"', // about to expire — being re-snoozed
      '---',
      '',
    ].join('\n');
    const { octokit, createOrUpdate } = mkOctokit({ pmMd, pmMdSha: 'sha-abc' });
    await snoozeProposalPersistent(
      octokit,
      'unfinished_plan:q/r:p1',
      7,
      new Date('2026-05-05T00:00:00Z'),
    );
    const call = createOrUpdate.mock.calls[0]?.[0] as { content?: string };
    const decoded = Buffer.from(call?.content ?? '', 'base64').toString('utf8');
    // Expired entry pruned.
    expect(decoded).not.toContain('expired');
    expect(decoded).not.toContain('2026-04-01');
    // p1 expiry pushed to today + 7d.
    expect(decoded).toContain('2026-05-12');
    // Duplicate p1 entries collapsed to one.
    const matches = decoded.match(/unfinished_plan:q\/r:p1/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('rejects malformed proposal ids', async () => {
    const { octokit } = mkOctokit({});
    await expect(
      snoozeProposalPersistent(octokit, 'no-route-here'),
    ).rejects.toThrow(/cannot route snooze/);
  });
});

describe('unsnoozeProposalPersistent (Octokit write)', () => {
  it('removes the entry and writes back', async () => {
    const pmMd = [
      '---',
      'snoozed_proposals:',
      '  - id: "unfinished_plan:q/r:p1"',
      '    expires: "2026-05-12"',
      '  - id: "unfinished_plan:q/r:p2"',
      '    expires: "2026-05-12"',
      '---',
      '',
    ].join('\n');
    const createOrUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = {
      repos: {
        get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
        getContent: vi.fn(async () => ({
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(pmMd).toString('base64'),
            sha: 'sha-abc',
          },
        })),
        createOrUpdateFileContents: createOrUpdate,
      },
    } as unknown as Octokit;
    await unsnoozeProposalPersistent(
      octokit,
      'unfinished_plan:q/r:p1',
      new Date('2026-05-05T00:00:00Z'),
    );
    const call = createOrUpdate.mock.calls[0]?.[0] as { content?: string };
    const decoded = Buffer.from(call?.content ?? '', 'base64').toString('utf8');
    expect(decoded).toContain('unfinished_plan:q/r:p2');
    expect(decoded).not.toContain('unfinished_plan:q/r:p1');
  });

  it('skips the write when the entry is already absent (idempotent)', async () => {
    const createOrUpdate = vi.fn(async (_args: Record<string, unknown>) => ({}));
    const octokit = {
      repos: {
        get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
        getContent: vi.fn(async () => {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }),
        createOrUpdateFileContents: createOrUpdate,
      },
    } as unknown as Octokit;
    await unsnoozeProposalPersistent(octokit, 'unfinished_plan:q/r:p1');
    expect(createOrUpdate).not.toHaveBeenCalled();
  });
});
