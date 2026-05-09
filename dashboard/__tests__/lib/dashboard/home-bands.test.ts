import { describe, it, expect } from 'vitest';
import {
  type HeroBand,
  type RepoSummary,
  buildHero,
} from '@/lib/dashboard/home-bands';
import type { RepoInfo } from '@/lib/repos';

const wired = (owner: string, name: string): RepoInfo => ({
  owner,
  name,
  default_branch: 'main',
  wired_up: true,
  html_url: `https://github.com/${owner}/${name}`,
  description: null,
});

describe('buildHero', () => {
  it('returns wired-state copy when at least one repo is wired', () => {
    const h: HeroBand = buildHero(
      [wired('a', 'b'), wired('a', 'c')],
      { needs_action_count: 2, in_motion_count: 1 },
    );
    expect(h.state).toBe('wired');
    expect(h.message).toMatch(/2 things need you/);
    expect(h.message).toMatch(/1 in motion/);
    expect(h.message).toMatch(/2 repos/);
  });

  it('returns empty-state copy when no repos are wired', () => {
    const h: HeroBand = buildHero([], { needs_action_count: 0, in_motion_count: 0 });
    expect(h.state).toBe('empty');
  });
});
