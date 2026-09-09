import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { evaluateSpecApproval, parseSpecRefs } from '@/lib/spec-approval-gate';
import {
  OVERRIDE_LABEL,
  SPEC_APPROVAL_SCHEMA_VERSION,
  hashSpecAndPlan,
} from '@/lib/spec-approval';

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
