import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { evaluateSpecApproval, parseSpecRefs, parseStoryRef } from '@/lib/spec-approval-gate';
import {
  OVERRIDE_LABEL,
  SPEC_APPROVAL_SCHEMA_VERSION,
  hashSpecAndPlan,
} from '@/lib/spec-approval';
import { hashStory } from '@/lib/story-approval';

const SPEC = 'docs/superpowers/specs/2026-09-09-thing-design.md';
const PLAN = 'docs/superpowers/plans/2026-09-09-thing.md';
const APPROVAL = 'docs/superpowers/specs/2026-09-09-thing-design.approval.json';
const SPEC_TEXT = '# Thing\n\nAC-1: it works.\n';
const PLAN_TEXT = '# Plan\n\nTask 1 (AC: 1)\n';

const BODY = `Spec: ${SPEC}\nPlan: ${PLAN}\n\n## TL;DR\n\nDoes the thing.\n`;

/** A valid approval record for the canonical spec and plan. */
function approvalJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: SPEC_APPROVAL_SCHEMA_VERSION,
    spec_path: SPEC,
    plan_path: PLAN,
    spec_sha256: hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT),
    review_verdict: 'ok',
    review_rounds: 2,
    approved_by: 'ali@example.com',
    approved_at: '2026-09-09T10:00:00.000Z',
    ...over,
  });
}

/**
 * Stub the Contents API from a path-to-content map. Any path absent from the
 * map 404s, matching how GitHub answers for a file that was never committed.
 */
function makeOctokit(files: Record<string, string | undefined>): Octokit {
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    const content = files[path];
    if (content === undefined) {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    }
    return { data: { content: Buffer.from(content, 'utf8').toString('base64') } };
  });
  return { repos: { getContent } } as unknown as Octokit;
}

/** Evaluate the gate against a file map, with optional labels. */
function evaluate(files: Record<string, string | undefined>, labels: string[] = [], body = BODY) {
  return evaluateSpecApproval({
    octokit: makeOctokit(files),
    owner: 'q',
    repo: 'r',
    ref: 'main',
    issueBody: body,
    labels,
  });
}

const COMPLETE = { [SPEC]: SPEC_TEXT, [PLAN]: PLAN_TEXT, [APPROVAL]: approvalJson() };

describe('parseSpecRefs', () => {
  it('reads both paths from a handoff body', () => {
    expect(parseSpecRefs(BODY)).toEqual({ spec_path: SPEC, plan_path: PLAN });
  });

  it('treats a missing Plan line as the quick-dev route, not a failure', () => {
    expect(parseSpecRefs(`Spec: ${SPEC}\n`)).toEqual({ spec_path: SPEC, plan_path: null });
  });

  it('returns null without a Spec line', () => {
    expect(parseSpecRefs(`Plan: ${PLAN}\n`)).toBeNull();
    expect(parseSpecRefs('')).toBeNull();
    expect(parseSpecRefs(null)).toBeNull();
  });

  it('ignores a stale path quoted inside a fenced block', () => {
    const body = [
      '```',
      'Spec: docs/superpowers/specs/old-design.md',
      '```',
      `Spec: ${SPEC}`,
      `Plan: ${PLAN}`,
    ].join('\n');
    expect(parseSpecRefs(body)?.spec_path).toBe(SPEC);
  });

  it('still finds the Spec line after an unclosed fence', () => {
    // A stray opener pasted into a TL;DR would otherwise swallow the rest of
    // the body and refuse an issue that is properly approved.
    const body = ['```', 'some pasted output, never closed', `Spec: ${SPEC}`, `Plan: ${PLAN}`].join(
      '\n',
    );
    expect(parseSpecRefs(body)).toEqual({ spec_path: SPEC, plan_path: PLAN });
  });

  it('reads a body with Windows line endings', () => {
    expect(parseSpecRefs(`Spec: ${SPEC}\r\nPlan: ${PLAN}\r\n`)).toEqual({
      spec_path: SPEC,
      plan_path: PLAN,
    });
  });

  it('ignores a path inside an inline backtick span', () => {
    const body = [`Example: \`Spec: docs/old.md\``, `Spec: ${SPEC}`, `Plan: ${PLAN}`].join('\n');
    expect(parseSpecRefs(body)?.spec_path).toBe(SPEC);
  });
});

describe('evaluateSpecApproval', () => {
  it('allows an issue whose approval matches the committed text', async () => {
    const d = await evaluate(COMPLETE);
    expect(d.allow).toBe(true);
    expect(d.message).toContain('ali@example.com');
  });

  it('refuses when the approval was never committed', async () => {
    const d = await evaluate({ [SPEC]: SPEC_TEXT, [PLAN]: PLAN_TEXT });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('missing');
  });

  it('refuses when the spec was edited after approval', async () => {
    const d = await evaluate({ ...COMPLETE, [SPEC]: SPEC_TEXT + 'AC-2: sneaked in.\n' });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('spec-changed');
  });

  it('refuses when the issue has no Spec line to check against', async () => {
    const d = await evaluate(COMPLETE, [], 'Just some prose, no links.');
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('missing');
  });

  it('refuses when the spec is not on the branch the run would use', async () => {
    const d = await evaluate({ [PLAN]: PLAN_TEXT, [APPROVAL]: approvalJson() });
    expect(d.allow).toBe(false);
    expect(d.message).toContain(SPEC);
  });

  it('refuses when the issue names a plan that is not on the branch', async () => {
    const d = await evaluate({ [SPEC]: SPEC_TEXT, [APPROVAL]: approvalJson() });
    expect(d.allow).toBe(false);
    expect(d.message).toContain(PLAN);
  });

  it('fails closed on an API error rather than reading it as no approval', async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(
          Object.assign(new Error('Bad credentials'), { status: 401 }),
        ),
      },
    } as unknown as Octokit;
    const d = await evaluateSpecApproval({
      octokit,
      owner: 'q',
      repo: 'r',
      ref: 'main',
      issueBody: BODY,
      labels: [],
    });
    expect(d.allow).toBe(false);
    expect(d.message).toContain('Bad credentials');
  });

  it('allows the quick-dev shape: a spec, no plan, an approval covering both', async () => {
    const files = {
      [SPEC]: SPEC_TEXT,
      [APPROVAL]: approvalJson({
        plan_path: null,
        review_rounds: 1,
        spec_sha256: hashSpecAndPlan(SPEC_TEXT, null),
      }),
    };
    const d = await evaluate(files, [], `Spec: ${SPEC}\n`);
    expect(d.allow).toBe(true);
  });

  it('honours the override label on a refusal, and says what it overrode', async () => {
    const d = await evaluate({ [SPEC]: SPEC_TEXT, [PLAN]: PLAN_TEXT }, [OVERRIDE_LABEL]);
    expect(d.allow).toBe(true);
    expect(d.reason).toBe('override');
    expect(d.message).toContain('no approval recorded');
  });

  it('does not fetch a plan the issue never named', async () => {
    const octokit = makeOctokit({ [SPEC]: SPEC_TEXT, [APPROVAL]: approvalJson({ plan_path: null, review_rounds: 1, spec_sha256: hashSpecAndPlan(SPEC_TEXT, null) }) });
    await evaluateSpecApproval({
      octokit,
      owner: 'q',
      repo: 'r',
      ref: 'main',
      issueBody: `Spec: ${SPEC}\n`,
      labels: [],
    });
    const paths = (octokit.repos.getContent as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { path: string }).path,
    );
    expect(paths).toEqual([SPEC, APPROVAL]);
  });
});

describe('parseStoryRef', () => {
  it('reads the story path out of the body', () => {
    const body = 'Story: docs/stories/epic-8/8.1-gate-hardening.md\n\n## TL;DR\n\nBody.\n';
    expect(parseStoryRef(body)?.story_path).toBe('docs/stories/epic-8/8.1-gate-hardening.md');
  });

  it('returns null for a spec-based issue', () => {
    const body = 'Spec: docs/superpowers/specs/2026-05-01-a-design.md\nPlan: docs/superpowers/plans/2026-05-01-a.md\n';
    expect(parseStoryRef(body)).toBeNull();
  });

  it('ignores a path inside a fenced block', () => {
    // Same rule the spec parser applies: an example in the body is not the
    // reference the workflow will act on.
    const body = 'Intro\n\n```\nStory: docs/stories/epic-8/8.1-example.md\n```\n';
    expect(parseStoryRef(body)).toBeNull();
  });

  it('ignores a path inside backticks', () => {
    // Documents the contract: a single-line backticked path cannot discriminate
    // (the `$` anchor rejects it regardless). The multi-line test below is the
    // actual guard that stripping works.
    expect(parseStoryRef('Story: `docs/stories/epic-8/8.1-x.md`\n')).toBeNull();
  });

  it('ignores a Story: line swallowed by a multi-line backtick span', () => {
    // A single-line backticked path cannot discriminate: the `$` anchor already
    // rejects a line ending in a backtick. A span across lines can — without
    // stripping, the decoy on line 2 matches first and wins.
    const body = [
      'Intro `code',
      'Story: docs/stories/epic-8/8.1-decoy.md',
      'more` text',
      '',
      'Story: docs/stories/epic-8/8.1-real.md',
    ].join('\n');
    expect(parseStoryRef(body)?.story_path).toBe('docs/stories/epic-8/8.1-real.md');
  });

  it('returns null for an empty body', () => {
    expect(parseStoryRef(null)).toBeNull();
    expect(parseStoryRef('')).toBeNull();
  });
});

const STORY = 'docs/stories/epic-8/8.1-gate-hardening.md';
const STORY_TEXT = '# Story 8.1\n\n**Status:** Approved\n**Source spec:** docs/superpowers/specs/2026-07-09-p-design.md\n\nBody.\n';
const STORY_BODY = `Story: ${STORY}\n\n## TL;DR\n\nImplementing it.\n`;

/** Serve a path-to-content map, 404ing anything absent. */
function octokitFor(files: Record<string, string>) {
  return {
    repos: {
      getContent: vi.fn(async ({ path }: { path: string }) => {
        const content = files[path];
        if (content === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: { content: Buffer.from(content, 'utf8').toString('base64') } };
      }),
    },
  } as unknown as Parameters<typeof evaluateSpecApproval>[0]['octokit'];
}

/** A story approval whose hash matches STORY_TEXT. */
function storyApproval(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    kind: 'story',
    story_path: STORY,
    story_sha256: hashStory(STORY_TEXT),
    source_spec_path: 'docs/superpowers/specs/2026-07-09-p-design.md',
    source_spec_sha256: 'a'.repeat(64),
    review_verdict: 'ok',
    review_rounds: 1,
    approved_by: 'ali@example.com',
    approved_at: '2026-09-12T10:00:00.000Z',
    ...over,
  });
}

describe('evaluateSpecApproval — story issues', () => {
  const APPROVAL = 'docs/stories/epic-8/8.1-gate-hardening.approval.json';

  it('allows a story whose approval still matches', async () => {
    const d = await evaluateSpecApproval({
      octokit: octokitFor({ [STORY]: STORY_TEXT, [APPROVAL]: storyApproval() }),
      owner: 'q', repo: 'r', ref: 'main', issueBody: STORY_BODY, labels: [],
    });
    expect(d.allow).toBe(true);
  });

  it('refuses a story edited after approval', async () => {
    const d = await evaluateSpecApproval({
      octokit: octokitFor({ [STORY]: STORY_TEXT.replace('Body.', 'Edited.'), [APPROVAL]: storyApproval() }),
      owner: 'q', repo: 'r', ref: 'main', issueBody: STORY_BODY, labels: [],
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('spec-changed');
  });

  it('allows a story whose status line alone moved on', async () => {
    const moved = STORY_TEXT.replace('**Status:** Approved', '**Status:** InProgress');
    const d = await evaluateSpecApproval({
      octokit: octokitFor({ [STORY]: moved, [APPROVAL]: storyApproval() }),
      owner: 'q', repo: 'r', ref: 'main', issueBody: STORY_BODY, labels: [],
    });
    expect(d.allow).toBe(true);
  });

  it('refuses when the story file itself is gone', async () => {
    const d = await evaluateSpecApproval({
      octokit: octokitFor({ [APPROVAL]: storyApproval() }),
      owner: 'q', repo: 'r', ref: 'main', issueBody: STORY_BODY, labels: [],
    });
    expect(d.allow).toBe(false);
  });

  it('rejects rather than reporting absence when a read fails', async () => {
    // A 500 is not a missing approval. `fetchText` throws on any non-404
    // status, and the story branch has no catch around that read — so a
    // broken repo read must surface as a rejection, not a resolved refusal.
    // Turning this into a resolved `allow: false` would leave the story path
    // behaving differently from the spec path at the one moment fail-closed
    // behaviour matters most.
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
      },
    } as unknown as Parameters<typeof evaluateSpecApproval>[0]['octokit'];
    await expect(
      evaluateSpecApproval({
        octokit, owner: 'q', repo: 'r', ref: 'main', issueBody: STORY_BODY, labels: [],
      }),
    ).rejects.toThrow();
  });

  it('routes an issue carrying both references to the story gate', async () => {
    // An issue with both lines is malformed. The story gate is the safe place
    // to send it: it refuses unless the story and its approval both exist and
    // match, so a stale spec approval cannot authorise it. Reordering these
    // branches would check a spec approval while the agent implements a story.
    //
    // This test succeeds when story is checked first (refuses because no
    // story approval exists). It would fail (allow: true) if spec branch runs
    // first, because a valid spec approval is provided.

    const DUAL_SPEC = 'docs/superpowers/specs/2026-09-10-dual-test.md';
    const DUAL_PLAN = 'docs/superpowers/plans/2026-09-10-dual-test.md';
    const DUAL_SPEC_TEXT = '# Dual Spec\n\nTest body.';
    const DUAL_PLAN_TEXT = '# Dual Plan\n\nTest body.';
    const DUAL_APPROVAL = 'docs/superpowers/specs/2026-09-10-dual-test.approval.json';

    // Create a body with both Story: and Spec: lines
    const dualBody = `Story: ${STORY}\nSpec: ${DUAL_SPEC}\nPlan: ${DUAL_PLAN}\n\n## TL;DR\n\nBoth references.\n`;

    // Spec side: provide valid spec and plan texts and an approval that matches
    const dualSpecApprovalData = JSON.stringify({
      schema_version: SPEC_APPROVAL_SCHEMA_VERSION,
      spec_path: DUAL_SPEC,
      plan_path: DUAL_PLAN,
      spec_sha256: hashSpecAndPlan(DUAL_SPEC_TEXT, DUAL_PLAN_TEXT),
      review_verdict: 'ok',
      review_rounds: 1,
      approved_by: 'ali@example.com',
      approved_at: '2026-09-12T10:00:00.000Z',
    });

    // Story side: provide story text but NO approval, so story gate refuses
    const d = await evaluateSpecApproval({
      octokit: octokitFor({
        [STORY]: STORY_TEXT,
        [DUAL_SPEC]: DUAL_SPEC_TEXT,
        [DUAL_PLAN]: DUAL_PLAN_TEXT,
        [DUAL_APPROVAL]: dualSpecApprovalData,
        // Deliberately omit story approval: approvalPathForStory(STORY)
      }),
      owner: 'q', repo: 'r', ref: 'main', issueBody: dualBody, labels: [],
    });

    // Should refuse because story gate is checked first and finds no approval
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('missing');
  });

  it('still refuses an issue carrying neither reference', async () => {
    const d = await evaluateSpecApproval({
      octokit: octokitFor({}), owner: 'q', repo: 'r', ref: 'main',
      issueBody: '## TL;DR\n\nNo references.\n', labels: [],
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('missing');
  });
});
