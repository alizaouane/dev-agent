import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const BASE = 'base/thing.md';
const HEAD = 'head/thing.md';

const STORY_TEXT =
  '# Story 9.1\n\n**Status:** Approved\n**Source spec:** `docs/superpowers/specs/thing-design.md`\n\n' +
  '## Story\n\nBody text.\n';

const scriptPath = resolve(process.cwd(), 'lib/cli/compare-approved-text.ts');
const tsxBinPath = resolve(process.cwd(), 'node_modules/.bin/tsx');

let repo: string;

/** Write a repo-relative file under the scratch repo, creating parents as needed. */
function put(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
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
  repo = mkdtempSync(join(tmpdir(), 'compare-approved-text-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('compare-approved-text', () => {
  it('exits 0 for two byte-identical stories', () => {
    put(BASE, STORY_TEXT);
    put(HEAD, STORY_TEXT);

    const result = run({ ...process.env, BASE_PATH: BASE, HEAD_PATH: HEAD, KIND: 'story' });

    expect(result.status).toBe(0);
  });

  it('exits 0 when the two differ only in their status line, with KIND=story', () => {
    put(BASE, STORY_TEXT);
    put(HEAD, STORY_TEXT.replace('**Status:** Approved', '**Status:** InProgress'));

    const result = run({ ...process.env, BASE_PATH: BASE, HEAD_PATH: HEAD, KIND: 'story' });

    expect(result.status).toBe(0);
  });

  it('exits 1 when the two differ elsewhere, with KIND=story', () => {
    put(BASE, STORY_TEXT);
    put(HEAD, STORY_TEXT + 'One more paragraph, added after approval.\n');

    const result = run({ ...process.env, BASE_PATH: BASE, HEAD_PATH: HEAD, KIND: 'story' });

    expect(result.status).toBe(1);
  });

  it('exits 1 when the two differ only in their status line, with KIND=spec', () => {
    // The discriminating test: the story rule must not leak onto the spec
    // path, which every shipped consumer repo uses.
    put(BASE, STORY_TEXT);
    put(HEAD, STORY_TEXT.replace('**Status:** Approved', '**Status:** InProgress'));

    const result = run({ ...process.env, BASE_PATH: BASE, HEAD_PATH: HEAD, KIND: 'spec' });

    expect(result.status).toBe(1);
  });

  it('exits 2 when KIND is neither', () => {
    put(BASE, STORY_TEXT);
    put(HEAD, STORY_TEXT);

    const result = run({ ...process.env, BASE_PATH: BASE, HEAD_PATH: HEAD, KIND: 'nonsense' });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/KIND/);
  });

  it('exits 1 when either file is missing, naming which', () => {
    put(HEAD, STORY_TEXT);
    const missingBase = run({ ...process.env, BASE_PATH: BASE, HEAD_PATH: HEAD, KIND: 'story' });
    expect(missingBase.status).toBe(1);
    expect(missingBase.stderr).toContain(BASE);

    put(BASE, STORY_TEXT);
    const repo2 = mkdtempSync(join(tmpdir(), 'compare-approved-text-test2-'));
    mkdirSync(dirname(join(repo2, BASE)), { recursive: true });
    writeFileSync(join(repo2, BASE), STORY_TEXT, 'utf8');
    try {
      const missingHead = spawnSync(tsxBinPath, [scriptPath], {
        cwd: repo2,
        env: { ...process.env, BASE_PATH: BASE, HEAD_PATH: HEAD, KIND: 'story' },
        encoding: 'utf8',
      });
      expect(missingHead.status).toBe(1);
      expect(missingHead.stderr).toContain(HEAD);
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
  });
});
