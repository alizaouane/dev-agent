import yaml from 'js-yaml';
import {
  pmFrontmatterSchema,
  type PmNotes,
  type PmFrontmatter,
  EMPTY_PM_NOTES,
} from './pm-md-schema';

const FRONTMATTER_DELIMITER = /^---\s*\r?\n/;

/**
 * Parse a `.dev-agent/pm.md` file into structured frontmatter + body.
 *
 * Recognized shapes:
 *   1. **Frontmatter + body** — file starts with `---\n`, has YAML up to a
 *      closing `---\n`, then arbitrary markdown. (Most common.)
 *   2. **Body only** — no frontmatter delimiters. The whole file is body
 *      and frontmatter is empty. (Valid; users may not want structured
 *      metadata yet.)
 *   3. **Frontmatter only** — `---\n...\n---\n` with no body. Body is "".
 *
 * Validation policy: if frontmatter is present but malformed (bad YAML
 * or violates the Zod schema), throw — this is corruption the user should
 * see, not silently lose data. If frontmatter is *absent*, that's fine.
 *
 * @throws Error if frontmatter exists but doesn't validate.
 */
export function parsePmMd(raw: string): PmNotes {
  if (!FRONTMATTER_DELIMITER.test(raw)) {
    return { frontmatter: {}, body: raw };
  }

  // Strip the opening `---` line, then look for the closing `---`.
  const afterOpen = raw.replace(FRONTMATTER_DELIMITER, '');
  const closeMatch = afterOpen.match(/\n---\s*\r?\n/);

  if (!closeMatch || closeMatch.index === undefined) {
    // Opening `---` but no closing one — malformed. Treat the whole thing
    // as body so we don't lose the user's content; the closing `---`
    // would need adding before they get structured fields.
    return { frontmatter: {}, body: raw };
  }

  const yamlText = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  let loaded: unknown;
  try {
    loaded = yaml.load(yamlText);
  } catch (err) {
    throw new Error(`pm.md frontmatter is not valid YAML: ${(err as Error).message}`);
  }

  // Empty frontmatter (just `---\n---\n`) loads as null/undefined; treat as {}.
  const candidate = (loaded ?? {}) as Record<string, unknown>;
  const result = pmFrontmatterSchema.safeParse(candidate);
  if (!result.success) {
    const formatted = JSON.stringify(result.error.format(), null, 2);
    throw new Error(`pm.md frontmatter failed schema validation:\n${formatted}`);
  }

  return { frontmatter: result.data as PmFrontmatter, body };
}

/**
 * Render a `PmNotes` back to a markdown string with frontmatter.
 *
 * Used when the PM agent updates the file (e.g., to log a new decision).
 * Idempotent: parsePmMd(serializePmMd(x)).frontmatter deep-equals x.frontmatter
 * for any valid `x`.
 */
export function serializePmMd(notes: PmNotes): string {
  const fm = notes.frontmatter;
  const hasFrontmatter = Object.keys(fm).length > 0;
  if (!hasFrontmatter) return notes.body;

  const yamlText = yaml.dump(fm, { lineWidth: 100, noRefs: true });
  return `---\n${yamlText}---\n\n${notes.body}`;
}

export { EMPTY_PM_NOTES };
export type { PmNotes, PmFrontmatter };
