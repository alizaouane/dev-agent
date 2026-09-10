import { describe, it, expect } from 'vitest';
import { pairSpecsAndPlans, specSlug, planSlug, titleFromSlug } from '@/lib/spec-pairs';

const S = 'docs/superpowers/specs';
const P = 'docs/superpowers/plans';

describe('specSlug / planSlug', () => {
  it('strips the -design suffix a spec carries and its plan does not', () => {
    expect(specSlug(`${S}/2026-09-09-project-0-golden-set-design.md`)).toBe(
      '2026-09-09-project-0-golden-set',
    );
    expect(planSlug(`${P}/2026-09-09-project-0-golden-set.md`)).toBe(
      '2026-09-09-project-0-golden-set',
    );
  });

  it('leaves a spec without the suffix alone', () => {
    expect(specSlug(`${S}/2026-01-02-thing.md`)).toBe('2026-01-02-thing');
  });
});

describe('titleFromSlug', () => {
  it('drops the date and reads as a sentence', () => {
    expect(titleFromSlug('2026-09-09-project-0-golden-set')).toBe('Project 0 golden set');
  });

  it('falls back to the slug when there is nothing but a date', () => {
    expect(titleFromSlug('2026-09-09-')).toBe('2026-09-09-');
  });
});

describe('pairSpecsAndPlans', () => {
  it('matches a spec to its plan by the shared topic', () => {
    const [pair] = pairSpecsAndPlans(
      [`${S}/2026-09-09-golden-set-design.md`],
      [`${P}/2026-09-09-golden-set.md`],
    );
    expect(pair.planPath).toBe(`${P}/2026-09-09-golden-set.md`);
    expect(pair.title).toBe('Golden set');
  });

  it('never pairs a spec with an unrelated plan', () => {
    // The defect this replaces: two independent dropdowns each defaulted to
    // the first file in its own list, offering a September spec beside a
    // March plan with nothing to stop you dispatching that pair.
    const [pair] = pairSpecsAndPlans(
      [`${S}/2026-09-09-golden-set-design.md`],
      [`${P}/2026-03-21-settings-scheduled-jobs.md`],
    );
    expect(pair.planPath).toBeNull();
  });

  it('reports a spec with no plan rather than dropping it', () => {
    // quick-dev writes a spec and no plan, and the implement agent derives
    // its own task list. Such a spec is startable and must still be offered.
    const [pair] = pairSpecsAndPlans([`${S}/2026-09-09-quick-fix-design.md`], []);
    expect(pair.planPath).toBeNull();
    expect(pair.specPath).toContain('quick-fix');
  });

  it('marks a spec approved only when the artifact sits beside it', () => {
    const specs = [`${S}/2026-09-09-a-design.md`, `${S}/2026-09-08-b-design.md`];
    const pairs = pairSpecsAndPlans(specs, [], [`${S}/2026-09-09-a-design.approval.json`]);
    expect(pairs.find((p) => p.slug === '2026-09-09-a')!.approved).toBe(true);
    expect(pairs.find((p) => p.slug === '2026-09-08-b')!.approved).toBe(false);
  });

  it('does not credit an approval belonging to another spec', () => {
    // Matching loosely here would let one approval unlock a different spec,
    // which is the whole thing the hash-bound artifact exists to prevent.
    const pairs = pairSpecsAndPlans(
      [`${S}/2026-09-09-a-design.md`],
      [],
      [`${S}/2026-09-08-b-design.approval.json`],
    );
    expect(pairs[0].approved).toBe(false);
  });

  it('orders newest first, so March is not the default choice', () => {
    const pairs = pairSpecsAndPlans(
      [`${S}/2026-03-21-old-design.md`, `${S}/2026-09-09-new-design.md`],
      [],
    );
    expect(pairs.map((p) => p.slug)).toEqual(['2026-09-09-new', '2026-03-21-old']);
  });

  it('does not cross-pair the legacy and superpowers trees', () => {
    // A repo mid-migration has the same dated slug in both. Keying on the
    // basename alone let a superpowers spec take the legacy plan, which the
    // approval gate then refuses on the exact-path mismatch.
    const pairs = pairSpecsAndPlans(
      [`${S}/2026-09-09-a-design.md`, 'docs/specs/2026-09-09-a-design.md'],
      [`${P}/2026-09-09-a.md`, 'docs/plans/2026-09-09-a.md'],
    );
    const modern = pairs.find((p) => p.specPath.startsWith('docs/superpowers'))!;
    const legacy = pairs.find((p) => p.specPath === 'docs/specs/2026-09-09-a-design.md')!;
    expect(modern.planPath).toBe(`${P}/2026-09-09-a.md`);
    expect(legacy.planPath).toBe('docs/plans/2026-09-09-a.md');
  });

  it('gives same-slug specs distinct identities for the picker', () => {
    // Keyed on slug they would render as one option, and the picker would
    // dispatch whichever it happened to find first.
    const pairs = pairSpecsAndPlans(
      [`${S}/2026-09-09-a-design.md`, 'docs/specs/2026-09-09-a-design.md'],
      [],
    );
    expect(new Set(pairs.map((p) => p.key)).size).toBe(2);
  });

  it('returns one entry per spec, plans it cannot match notwithstanding', () => {
    const pairs = pairSpecsAndPlans(
      [`${S}/2026-09-09-a-design.md`],
      [`${P}/2026-09-09-a.md`, `${P}/2026-01-01-orphan.md`],
    );
    expect(pairs).toHaveLength(1);
  });
  it('pairs a superpowers spec with a legacy plan when only one tree has it', () => {
    // README documents this mixed layout: writing-plans may write to
    // docs/plans. Refusing to pair them assigned the spec a null plan, which
    // then failed the approval gate on the recorded plan path and quietly
    // dropped an approved spec out of the picker.
    const [pair] = pairSpecsAndPlans(
      [`${S}/2026-09-09-a-design.md`],
      ['docs/plans/2026-09-09-a.md'],
    );
    expect(pair.planPath).toBe('docs/plans/2026-09-09-a.md');
  });

  it('leaves a legacy spec paired to its own tree when both trees hold the slug', () => {
    const pairs = pairSpecsAndPlans(
      ['docs/specs/2026-09-09-a-design.md'],
      [`${P}/2026-09-09-a.md`, 'docs/plans/2026-09-09-a.md'],
    );
    expect(pairs[0].planPath).toBe('docs/plans/2026-09-09-a.md');
  });
});
