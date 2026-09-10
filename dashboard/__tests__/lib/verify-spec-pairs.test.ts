import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { verifySpecPairs } from '@/lib/verify-spec-pairs';
import { hashSpecAndPlan } from '@/lib/spec-approval';
import type { SpecPair } from '@/lib/spec-pairs';

const SPEC = 'docs/superpowers/specs/2026-09-09-a-design.md';
const PLAN = 'docs/superpowers/plans/2026-09-09-a.md';
const APPROVAL = 'docs/superpowers/specs/2026-09-09-a-design.approval.json';
const SPEC_TEXT = '# A\n\nAC-1: works.\n';
const PLAN_TEXT = '# Plan\n\nTask 1 (AC: 1)\n';

/** A pair the file listing believed was approved. */
function pair(over: Partial<SpecPair> = {}): SpecPair {
  return {
    specPath: SPEC,
    planPath: PLAN,
    slug: '2026-09-09-a',
    key: SPEC,
    title: 'A',
    approved: true,
    ...over,
  };
}

/** A valid approval record for the canonical spec and plan. */
function approvalJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    spec_path: SPEC,
    plan_path: PLAN,
    spec_sha256: hashSpecAndPlan(SPEC_TEXT, PLAN_TEXT),
    review_verdict: 'ok',
    review_rounds: 1,
    approved_by: 'ali@example.com',
    approved_at: '2026-09-09T10:00:00.000Z',
    ...over,
  });
}

/** Serve a path-to-content map, 404ing anything absent. */
function makeOctokit(files: Record<string, string | undefined>): Octokit {
  return {
    repos: {
      getContent: vi.fn(async ({ path }: { path: string }) => {
        const content = files[path];
        if (content === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: { content: Buffer.from(content, 'utf8').toString('base64') } };
      }),
    },
  } as unknown as Octokit;
}

const verify = (files: Record<string, string | undefined>, pairs = [pair()]) =>
  verifySpecPairs(makeOctokit(files), 'q', 'r', 'main', pairs);

describe('verifySpecPairs', () => {
  it('keeps a pair whose approval the gate would accept', async () => {
    const out = await verify({
      [SPEC]: SPEC_TEXT,
      [PLAN]: PLAN_TEXT,
      [APPROVAL]: approvalJson(),
    });
    expect(out[0].approved).toBe(true);
  });

  it('drops a pair whose spec changed after approval', async () => {
    // The defect this replaces: a filename check calls this approved, the
    // gate refuses it, and the failure only appears after a round trip —
    // exactly what the picker exists to prevent.
    const out = await verify({
      [SPEC]: SPEC_TEXT + 'AC-2: added later.\n',
      [PLAN]: PLAN_TEXT,
      [APPROVAL]: approvalJson(),
    });
    expect(out[0].approved).toBe(false);
  });

  it('drops a pair approved against an unclean review', async () => {
    const out = await verify({
      [SPEC]: SPEC_TEXT,
      [PLAN]: PLAN_TEXT,
      [APPROVAL]: approvalJson({ review_verdict: 'concerns' }),
    });
    expect(out[0].approved).toBe(false);
  });

  it('drops a pair whose approval names a different spec', async () => {
    const out = await verify({
      [SPEC]: SPEC_TEXT,
      [PLAN]: PLAN_TEXT,
      [APPROVAL]: approvalJson({ spec_path: 'docs/superpowers/specs/other-design.md' }),
    });
    expect(out[0].approved).toBe(false);
  });

  it('drops a pair whose approval cannot be parsed', async () => {
    const out = await verify({ [SPEC]: SPEC_TEXT, [PLAN]: PLAN_TEXT, [APPROVAL]: '{ truncated' });
    expect(out[0].approved).toBe(false);
  });

  it('makes no calls when nothing carries an approval artifact', async () => {
    // A repo with hundreds of unapproved specs must not cost hundreds of
    // reads on every page render.
    const octokit = makeOctokit({});
    const out = await verifySpecPairs(octokit, 'q', 'r', 'main', [
      pair({ approved: false }),
      pair({ approved: false, key: 'other', specPath: 'docs/specs/b-design.md' }),
    ]);
    expect(out.every((p) => p.approved === false)).toBe(true);
    expect(octokit.repos.getContent).not.toHaveBeenCalled();
  });

  it('verifies every approved pair, not just the first batch', async () => {
    // Truncating the candidate list marked everything past the limit
    // unapproved, so a repo with more approvals than the batch size could not
    // start its older ones — truncation reading as absence, again.
    const many = Array.from({ length: 60 }, (_, i) => {
      const spec = `docs/superpowers/specs/2026-09-${String(i + 1).padStart(2, '0')}-x-design.md`;
      return pair({ specPath: spec, planPath: null, key: spec });
    });
    const files: Record<string, string> = {};
    for (const p of many) {
      files[p.specPath] = SPEC_TEXT;
      files[`${p.specPath.replace(/\.md$/, '')}.approval.json`] = JSON.stringify({
        schema_version: 1,
        spec_path: p.specPath,
        plan_path: null,
        spec_sha256: hashSpecAndPlan(SPEC_TEXT, null),
        review_verdict: 'ok',
        review_rounds: 1,
        approved_by: 'ali@example.com',
        approved_at: '2026-09-09T10:00:00.000Z',
      });
    }
    const out = await verify(files, many);
    expect(out.filter((p) => p.approved)).toHaveLength(60);
  });

  it('drops a pair whose named plan is missing, rather than hashing it as empty', async () => {
    // hashSpecAndPlan treats a null plan like an empty one, so an approved
    // zero-byte plan would keep matching after deletion and the pair would be
    // offered, then refused at dispatch.
    const out = await verify({
      [SPEC]: SPEC_TEXT,
      [APPROVAL]: approvalJson({ spec_sha256: hashSpecAndPlan(SPEC_TEXT, null) }),
    });
    expect(out[0].approved).toBe(false);
  });

  it('treats a read it could not complete as not approved', async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(
          Object.assign(new Error('Bad credentials'), { status: 401 }),
        ),
      },
    } as unknown as Octokit;
    const out = await verifySpecPairs(octokit, 'q', 'r', 'main', [pair()]);
    expect(out[0].approved).toBe(false);
  });

  it('accepts a planless spec approved without a plan', async () => {
    const planless = pair({ planPath: null });
    const out = await verify(
      {
        [SPEC]: SPEC_TEXT,
        [APPROVAL]: approvalJson({
          plan_path: null,
          spec_sha256: hashSpecAndPlan(SPEC_TEXT, null),
        }),
      },
      [planless],
    );
    expect(out[0].approved).toBe(true);
  });
});
