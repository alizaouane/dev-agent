/**
 * Pairing of spec files with their plans, for the "start work" picker.
 *
 * The picker used to offer two independent dropdowns, one of specs and one of
 * plans, each defaulting to the first file in its own list. On a real repo that
 * produced a September spec beside a March plan, and nothing stopped you
 * dispatching that pair. Specs and plans are written together and named
 * together; asking a person to re-pair them by hand was asking them to redo
 * work the naming convention already did.
 *
 * The convention both the intake skill and `quick-dev` follow is
 * `YYYY-MM-DD-<topic>-design.md` for a spec and `YYYY-MM-DD-<topic>.md` for its
 * plan, so the topic is the join key.
 */

/** A spec, its plan if it has one, and whether work can start on it. */
export interface SpecPair {
  /** Repo-relative path to the spec. */
  specPath: string;
  /** Repo-relative path to the plan, or null when the spec has none. */
  planPath: string | null;
  /** Shared `YYYY-MM-DD-<topic>` key the two were matched on. */
  slug: string;
  /** Stable identity for the picker. The spec path, which is unique. */
  key: string;
  /** Human title derived from the slug, for the issue. */
  title: string;
  /** True when an approval artifact sits beside the spec. */
  approved: boolean;
}

/**
 * Reduce a spec path to the key it shares with its plan.
 *
 * @param path - Repo-relative path to a spec.
 * @returns `YYYY-MM-DD-<topic>`, with the `-design` suffix removed.
 */
export function specSlug(path: string): string {
  const base = (path.split('/').pop() ?? path).replace(/\.md$/, '');
  return base.replace(/-design$/, '');
}

/**
 * Reduce a plan path to the key it shares with its spec.
 *
 * @param path - Repo-relative path to a plan.
 * @returns `YYYY-MM-DD-<topic>`.
 */
export function planSlug(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '');
}

/**
 * Which convention a path belongs to: the current tree or the legacy one.
 *
 * Both are supported, and a repo mid-migration has the same dated slug in
 * each. Keying on the basename alone collapses those two, so a spec under
 * `docs/superpowers/specs` could be paired with a plan from `docs/plans` —
 * which the approval gate then refuses on the exact-path mismatch, putting
 * back the round-trip failure this picker exists to remove.
 *
 * @param path - Repo-relative path.
 * @returns `superpowers` or `legacy`.
 */
export function pathFamily(path: string): 'superpowers' | 'legacy' {
  return path.startsWith('docs/superpowers/') ? 'superpowers' : 'legacy';
}

/**
 * Turn a slug into something readable for an issue title.
 *
 * @param slug - `YYYY-MM-DD-<topic>`.
 * @returns The topic in sentence case, without the date.
 */
export function titleFromSlug(slug: string): string {
  const topic = slug.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ').trim();
  if (topic === '') return slug;
  return topic.charAt(0).toUpperCase() + topic.slice(1);
}

/**
 * Pair every spec with its plan and mark which ones are approved.
 *
 * Newest first, because a spec from March is history rather than a decision
 * waiting to be made.
 *
 * @param specs - Repo-relative spec paths.
 * @param plans - Repo-relative plan paths.
 * @param approvalPaths - Repo-relative `.approval.json` paths found beside specs.
 * @returns One entry per spec, newest first.
 */
export function pairSpecsAndPlans(
  specs: string[],
  plans: string[],
  approvalPaths: string[] = [],
): SpecPair[] {
  // Keyed by family AND slug, so the two conventions never cross-pair.
  const planByKey = new Map(plans.map((p) => [`${pathFamily(p)}:${planSlug(p)}`, p]));
  const approved = new Set(approvalPaths);

  return specs
    .map((specPath) => {
      const slug = specSlug(specPath);
      return {
        specPath,
        planPath: planByKey.get(`${pathFamily(specPath)}:${slug}`) ?? null,
        // The spec path, not the slug, identifies a pair: two specs can share
        // a slug across the two trees, and a picker keyed on slug alone would
        // show them as one option.
        slug,
        key: specPath,
        title: titleFromSlug(slug),
        // The approval sits beside the spec, named for it. Deriving the path
        // rather than matching loosely keeps this in step with the gate, which
        // reads exactly that file.
        approved: approved.has(`${specPath.replace(/\.md$/, '')}.approval.json`),
      };
    })
    .sort((a, b) => b.slug.localeCompare(a.slug));
}
