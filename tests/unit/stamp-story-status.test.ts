import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { hashStory } from '../../lib/story-approval';

const STORY = 'docs/stories/epic-9/9.1-thing.md';
const STORY_TEXT =
  '# Story 9.1\n\n**Status:** Approved\n**Source spec:** `docs/superpowers/specs/thing-design.md`\n\n' +
  '## Story\n\nBody text.\n';
const NO_STATUS_LINE_TEXT = '# Story 9.1\n\n**Source spec:** `docs/superpowers/specs/thing-design.md`\n\n' +
  '## Story\n\nBody text.\n';

const scriptPath = resolve(process.cwd(), 'lib/cli/stamp-story-status.ts');
const tsxBinPath = resolve(process.cwd(), 'node_modules/.bin/tsx');

let repo: string;

/** Write a repo-relative file under the scratch repo, creating parents as needed. */
function put(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** Read a repo-relative file back out of the scratch repo. */
function get(rel: string): string {
  return readFileSync(join(repo, rel), 'utf8');
}

/** Run the real CLI as a subprocess; never throws — callers inspect status/stdio. */
function run(env: NodeJS.ProcessEnv) {
  return spawnSync(tsxBinPath, [scriptPath], {
    cwd: repo,
    env,
    encoding: 'utf8',
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'stamp-story-status-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('stamp-story-status', () => {
  it('rewrites **Status:** Approved to **Status:** InProgress', () => {
    put(STORY, STORY_TEXT);

    const result = run({ ...process.env, STORY_PATH: STORY, STATUS: 'InProgress' });

    expect(result.status).toBe(0);
    expect(get(STORY)).toMatch(/\*\*Status:\*\* InProgress/);
  });

  it('leaves the rest of the file byte-identical', () => {
    put(STORY, STORY_TEXT);

    const result = run({ ...process.env, STORY_PATH: STORY, STATUS: 'InProgress' });

    expect(result.status).toBe(0);
    const expected = STORY_TEXT.replace('**Status:** Approved', '**Status:** InProgress');
    expect(get(STORY)).toBe(expected);
  });

  it("does not change the story's hash", () => {
    put(STORY, STORY_TEXT);
    const before = hashStory(STORY_TEXT);

    const result = run({ ...process.env, STORY_PATH: STORY, STATUS: 'InProgress' });

    expect(result.status).toBe(0);
    const after = hashStory(get(STORY));
    expect(after).toBe(before);
  });

  it('exits 2 when STORY_PATH is unset', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, STATUS: 'InProgress' };
    delete env.STORY_PATH;

    const result = run(env);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/STORY_PATH/);
  });

  it('exits 2 when STATUS is not one of STORY_STATUS_VALUES', () => {
    put(STORY, STORY_TEXT);

    const result = run({ ...process.env, STORY_PATH: STORY, STATUS: 'Nonexistent' });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/STATUS/);
  });

  it('exits 1 when the story has no status line at all, saying so', () => {
    put(STORY, NO_STATUS_LINE_TEXT);

    const result = run({ ...process.env, STORY_PATH: STORY, STATUS: 'InProgress' });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no \*\*Status:\*\* line/);
    // Silently succeeding would report a projection that never happened.
    expect(get(STORY)).toBe(NO_STATUS_LINE_TEXT);
  });

  it('exits 0 and writes nothing when the line already says the target status', () => {
    put(STORY, STORY_TEXT);

    const result = run({ ...process.env, STORY_PATH: STORY, STATUS: 'Approved' });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/already reads/);
    expect(get(STORY)).toBe(STORY_TEXT);
  });

  it('exits 1 when the story does not exist, naming the path', () => {
    const result = run({ ...process.env, STORY_PATH: STORY, STATUS: 'InProgress' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(STORY);
  });
});
