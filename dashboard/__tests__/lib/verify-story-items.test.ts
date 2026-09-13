import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { verifyStoryItems } from '@/lib/verify-story-items';
import { hashStory } from '@/lib/story-approval';
import type { StoryItem } from '@/lib/story-items';

const STORY = 'docs/stories/epic-8-agent-reliability/8.1-gate.md';
const APPROVAL = 'docs/stories/epic-8-agent-reliability/8.1-gate.approval.json';
const SPEC = 'docs/superpowers/specs/2026-09-09-a-design.md';
const STORY_TEXT = '# Story 8.1 — Gate\n\n**Status:** Approved\n\n- [ ] AC-1: works.\n';

/** An item the listing believed was approved. */
function item(over: Partial<StoryItem> = {}): StoryItem {
  return {
    storyPath: STORY,
    key: STORY,
    epic: 8,
    storyNumber: '8.1',
    title: '8.1 — Gate',
    approved: true,
    ...over,
  };
}

/** A valid story approval over the canonical text. */
function approvalJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    kind: 'story',
    story_path: STORY,
    story_sha256: hashStory(STORY_TEXT),
    source_spec_path: SPEC,
    source_spec_sha256: 'a'.repeat(64),
    review_verdict: 'ok',
    review_rounds: 1,
    approved_by: 'ali@example.com',
    approved_at: '2026-09-09T10:00:00.000Z',
    ...over,
  });
}

/** An octokit whose getContent serves `files`, 404ing on anything else. */
function octokitOver(files: Record<string, string>, fail?: () => never): Octokit {
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (fail) fail();
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error('nope'), { status: 404 });
    return { data: { content: Buffer.from(text, 'utf8').toString('base64') } };
  });
  return { repos: { getContent } } as unknown as Octokit;
}

describe('verifyStoryItems', () => {
  it('approves a story whose hash still matches', async () => {
    const octokit = octokitOver({ [STORY]: STORY_TEXT, [APPROVAL]: approvalJson() });
    const [result] = await verifyStoryItems(octokit, 'o', 'r', 'main', [item()]);
    expect(result.approved).toBe(true);
    expect(result.unverified).toBe(false);
  });

  it('refuses a story edited since approval', async () => {
    const octokit = octokitOver({
      [STORY]: `${STORY_TEXT}\nAn extra line nobody approved.\n`,
      [APPROVAL]: approvalJson(),
    });
    const [result] = await verifyStoryItems(octokit, 'o', 'r', 'main', [item()]);
    expect(result.approved).toBe(false);
    expect(result.unverified).toBe(false);
  });

  it('still approves after only the status line changed', async () => {
    // The central property. dev-agent rewrites this line as the issue moves,
    // so a projection must not invalidate the approval it is projecting.
    const octokit = octokitOver({
      [STORY]: STORY_TEXT.replace('**Status:** Approved', '**Status:** InProgress'),
      [APPROVAL]: approvalJson(),
    });
    const [result] = await verifyStoryItems(octokit, 'o', 'r', 'main', [item()]);
    expect(result.approved).toBe(true);
  });

  it('refuses a story whose artifact is not there', async () => {
    const octokit = octokitOver({ [STORY]: STORY_TEXT });
    const [result] = await verifyStoryItems(octokit, 'o', 'r', 'main', [item()]);
    expect(result.approved).toBe(false);
    expect(result.unverified).toBe(false);
  });

  it('reports a read it could not complete as unverified, not unapproved', async () => {
    // Two different facts: the gate refused, versus the gate never ran.
    // Rendering the second as the first hides approved work behind an outage.
    const octokit = octokitOver({}, () => {
      throw Object.assign(new Error('rate limit'), { status: 403 });
    });
    const [result] = await verifyStoryItems(octokit, 'o', 'r', 'main', [item()]);
    expect(result.approved).toBe(false);
    expect(result.unverified).toBe(true);
  });

  it('reads nothing when no item carries an artifact', async () => {
    const getContent = vi.fn();
    const octokit = { repos: { getContent } } as unknown as Octokit;
    const result = await verifyStoryItems(octokit, 'o', 'r', 'main', [item({ approved: false })]);
    expect(getContent).not.toHaveBeenCalled();
    expect(result[0].approved).toBe(false);
  });

  it('serves a second identical call from cache', async () => {
    const files = { [STORY]: STORY_TEXT, [APPROVAL]: approvalJson() };
    const shas = { [STORY]: 'story-sha-1', [APPROVAL]: 'approval-sha-1' };
    const octokit = octokitOver(files);
    await verifyStoryItems(octokit, 'o', 'r', 'main', [item()], shas);
    const before = (octokit.repos.getContent as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await verifyStoryItems(octokit, 'o', 'r', 'main', [item()], shas);
    expect(
      (octokit.repos.getContent as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(before);
  });

  it('does not serve a cached verdict after the story changes', async () => {
    const octokit = octokitOver({ [STORY]: STORY_TEXT, [APPROVAL]: approvalJson() });
    await verifyStoryItems(octokit, 'o', 'r', 'main', [item()], {
      [STORY]: 'sha-a',
      [APPROVAL]: 'approval-sha-2',
    });
    const before = (octokit.repos.getContent as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await verifyStoryItems(octokit, 'o', 'r', 'main', [item()], {
      [STORY]: 'sha-b',
      [APPROVAL]: 'approval-sha-2',
    });
    expect(
      (octokit.repos.getContent as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBeGreaterThan(before);
  });
});
