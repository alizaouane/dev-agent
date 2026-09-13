#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { STATUS_LINE_RE, STORY_STATUS_VALUES } from '../story-approval';
import { stampStatus } from './approve-story';

/**
 * stamp-story-status — write a story's `**Status:**` line to reflect where its
 * issue has got to.
 *
 * The artifact is authoritative and the status line is a projection of issue
 * state, which is why the hash deliberately excludes it. That is what makes
 * this safe to run at every transition: it cannot invalidate the approval it
 * is projecting.
 *
 * Environment:
 * - `STORY_PATH` — repo-relative path to the story. Required.
 * - `STATUS` — one of `STORY_STATUS_VALUES`. Required.
 *
 * Exit codes match `verify-approval`: 0 written or already correct, 1 the
 * story could not be stamped, 2 the invocation was wrong.
 *
 * @throws On a usage error, which the entry guard turns into exit 2.
 */
function main(): void {
  const storyPath = process.env.STORY_PATH?.trim() ?? '';
  const status = process.env.STATUS?.trim() ?? '';
  if (storyPath === '') throw new Error('STORY_PATH is required');
  if (!(STORY_STATUS_VALUES as readonly string[]).includes(status)) {
    throw new Error(
      `STATUS must be one of ${STORY_STATUS_VALUES.join(', ')}; got ${JSON.stringify(status)}`,
    );
  }

  let text: string;
  try {
    text = readFileSync(storyPath, 'utf8');
  } catch {
    process.stderr.write(`${storyPath} could not be read\n`);
    process.exit(1);
  }

  // Checked here rather than left to stampStatus below: stampStatus THROWS
  // when no status line matches, and an uncaught throw would escape to the
  // entry guard's catch and exit 2 — a usage error. But a story with no
  // status line is a stamping failure, not a bad invocation: it must exit 1,
  // the same way an unreadable story does, so it is caught here first.
  if (!STATUS_LINE_RE.test(text)) {
    process.stderr.write(
      `${storyPath} has no **Status:** line, so its status cannot be projected. ` +
        'Add one from the story template.\n',
    );
    process.exit(1);
  }

  const stamped = stampStatus(text, status);
  if (stamped === text) {
    process.stdout.write(`${storyPath} already reads ${status}\n`);
    process.exit(0);
  }
  writeFileSync(storyPath, stamped);
  process.stdout.write(`${storyPath} -> ${status}\n`);
  process.exit(0);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `stamp-story-status failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}
