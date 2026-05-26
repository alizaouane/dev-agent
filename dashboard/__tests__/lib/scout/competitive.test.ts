import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import { scoutCompetitorWatch } from '@/lib/scout/competitive';

/**
 * Build a minimal Octokit that serves a constructed `.dev-agent/pm.md`.
 * The competitor scout pulls everything it needs from there, so this is
 * the only fixture the tests need.
 */
function mockOctokitWithPmMd(content: string): Octokit {
  return {
    repos: {
      get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
      getContent: vi.fn(async ({ path }: { path: string }) => {
        if (path !== '.dev-agent/pm.md') {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }
        return {
          data: {
            content: Buffer.from(content, 'utf8').toString('base64'),
            encoding: 'base64',
          },
        };
      }),
    },
  } as unknown as Octokit;
}

function mockOctokitNoPmMd(): Octokit {
  return {
    repos: {
      get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
      getContent: vi.fn(async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }),
    },
  } as unknown as Octokit;
}

describe('scoutCompetitorWatch', () => {
  it('emits one proposal per competitor declared in pm.md frontmatter', async () => {
    const pmMd = `---
competitors:
  - name: "StudioDirector"
    url: "https://studiodirector.com/blog"
    notes: "Closest direct competitor"
  - name: "DanceStudio Pro"
    url: "https://example.com/dsp"
---

# notes
`;
    const octokit = mockOctokitWithPmMd(pmMd);
    const proposals = await scoutCompetitorWatch(octokit, 'q', 'r');
    expect(proposals).toHaveLength(2);

    const sd = proposals.find((p) => p.meta?.competitor_name === 'StudioDirector')!;
    expect(sd.source).toBe('competitor_watch');
    expect(sd.group).toBe('new_idea');
    expect(sd.title).toBe('Review competitor: StudioDirector');
    expect(sd.url).toBe('https://studiodirector.com/blog');
    expect(sd.description).toContain('Closest direct competitor');

    // Without notes, falls back to the default "check what they shipped" copy.
    const dsp = proposals.find((p) => p.meta?.competitor_name === 'DanceStudio Pro')!;
    expect(dsp.description).toContain('Click "Brainstorm in Claude Code"');
  });

  it('returns empty when pm.md has no competitors field', async () => {
    const pmMd = `---
goals:
  q2: "ship onboarding"
---
# body
`;
    const octokit = mockOctokitWithPmMd(pmMd);
    expect(await scoutCompetitorWatch(octokit, 'q', 'r')).toEqual([]);
  });

  it('returns empty when pm.md has competitors: [] (explicit empty)', async () => {
    const pmMd = `---
competitors: []
---
`;
    const octokit = mockOctokitWithPmMd(pmMd);
    expect(await scoutCompetitorWatch(octokit, 'q', 'r')).toEqual([]);
  });

  it('returns empty when pm.md is missing entirely', async () => {
    const octokit = mockOctokitNoPmMd();
    expect(await scoutCompetitorWatch(octokit, 'q', 'r')).toEqual([]);
  });

  it('proposal id is stable across runs (so snooze entries persist)', async () => {
    const pmMd = `---
competitors:
  - name: "X"
    url: "https://x.example.com/blog"
---
`;
    const octokit = mockOctokitWithPmMd(pmMd);
    const a = await scoutCompetitorWatch(octokit, 'q', 'r');
    const b = await scoutCompetitorWatch(octokit, 'q', 'r');
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id).toBe('competitor_watch:q/r:https://x.example.com/blog');
  });
});
