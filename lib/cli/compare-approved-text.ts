#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { storyBodyForHashing } from '../story-approval';

/**
 * compare-approved-text — check the base-branch copy of an approved document
 * against the agent branch's.
 *
 * The implement workflow proves the base copy is approved, then hands the
 * agent the working-tree copy. Approved text on one branch and different text
 * on the other would undo the whole binding, so the two must match.
 *
 * For a story, "match" means what the approval means: the hashed body, which
 * excludes the `**Status:**` line because dev-agent rewrites it as the issue
 * moves. A byte comparison would hard-fail on precisely the difference the
 * approval was built to ignore. For a spec it stays byte-exact, which is what
 * every consumer repo has today.
 *
 * Environment:
 * - `BASE_PATH` — the base-branch copy. Required.
 * - `HEAD_PATH` — the working-tree copy. Required.
 * - `KIND` — `story` or `spec`. Required.
 *
 * Exit codes: 0 they match, 1 they differ or a file is unreadable, 2 the
 * invocation was wrong.
 *
 * @throws On a usage error, which the entry guard turns into exit 2.
 */
function main(): void {
  const basePath = process.env.BASE_PATH?.trim() ?? '';
  const headPath = process.env.HEAD_PATH?.trim() ?? '';
  const kind = process.env.KIND?.trim() ?? '';
  if (basePath === '' || headPath === '') {
    throw new Error('BASE_PATH and HEAD_PATH are both required');
  }
  if (kind !== 'story' && kind !== 'spec') {
    throw new Error(`KIND must be story or spec; got ${JSON.stringify(kind)}`);
  }

  /**
   * Read one file's full contents for comparison.
   *
   * @param path - Path to read.
   * @returns The file's text, or null after writing the reason to stderr
   *   when the file cannot be read.
   */
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      process.stderr.write(`${path} could not be read\n`);
      return null;
    }
  };

  const base = read(basePath);
  const head = read(headPath);
  if (base === null || head === null) process.exit(1);

  /**
   * Reduce a document to the form the approval actually binds to.
   *
   * For `KIND=story`, strips the `**Status:**` line via
   * `storyBodyForHashing` — the same rule `hashStory` applies — because
   * dev-agent rewrites that line as the issue moves, so it was never part of
   * what got approved. For `KIND=spec`, the text passes through unchanged:
   * a spec carries no such line, and every consumer repo depends on the
   * comparison staying byte-exact there.
   *
   * @param text - The document text to normalise.
   * @returns The text with the story status line removed when `kind` is
   *   `story`, otherwise `text` unchanged.
   */
  const normalise = (text: string): string =>
    kind === 'story' ? storyBodyForHashing(text) : text;

  process.exit(normalise(base) === normalise(head) ? 0 : 1);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `compare-approved-text failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}
