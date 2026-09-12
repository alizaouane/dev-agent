import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, readFileSync as read, copyFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import {
  buildStoryApproval,
  sourceSpecOf,
  stampStatus,
  writeApproval,
} from '../../lib/cli/approve-story';
import { hashSpecAndPlan } from '../../lib/spec-approval';
import { hashStory, parseStoryApproval, approvalPathForStory } from '../../lib/story-approval';

const STORY_REL = 'docs/stories/epic-8/8.1-gate-hardening.md';
const SPEC_REL = 'docs/superpowers/specs/2026-07-09-program-design.md';
const SPEC_TEXT = '# Program\n\n- [ ] AC-1: works.\n';

let root: string;

/** Write a file under the temp repo, creating parents. */
function put(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

/** A story citing the spec above. */
function story(sourceLine = `**Source spec:** \`${SPEC_REL}\``): string {
  return `# Story 8.1\n\n**Status:** Draft\n${sourceLine}\n\n## Story\n\nBody.\n`;
}

/** A clean spec approval for SPEC_REL. */
function specApproval(): string {
  return JSON.stringify({
    schema_version: 1,
    spec_path: SPEC_REL,
    plan_path: null,
    spec_sha256: hashSpecAndPlan(SPEC_TEXT, null),
    review_verdict: 'ok',
    review_rounds: 1,
    approved_by: 'ali@example.com',
    approved_at: '2026-07-09T00:00:00.000Z',
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'approve-story-'));
  put(SPEC_REL, SPEC_TEXT);
  put(SPEC_REL.replace(/\.md$/, '.approval.json'), specApproval());
  put(STORY_REL, story());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const input = (over: Record<string, unknown> = {}) => ({
  storyPath: STORY_REL,
  reviewVerdict: 'ok' as const,
  reviewRounds: 1,
  approvedBy: 'ali@example.com',
  repoRoot: root,
  ...over,
});

describe('sourceSpecOf', () => {
  it('reads the spec path out of the story header', () => {
    expect(sourceSpecOf(story())).toBe(SPEC_REL);
  });

  it('returns null when the story cites no spec', () => {
    expect(sourceSpecOf('# Story\n\n**Status:** Draft\n\nBody.\n')).toBeNull();
  });
});

describe('buildStoryApproval', () => {
  it('records the story hash and the spec lineage', () => {
    const { approval, outPath } = buildStoryApproval(input());
    expect(approval.kind).toBe('story');
    expect(approval.story_path).toBe(STORY_REL);
    expect(approval.source_spec_path).toBe(SPEC_REL);
    expect(approval.source_spec_sha256).toBe(hashSpecAndPlan(SPEC_TEXT, null));
    expect(outPath).toBe('docs/stories/epic-8/8.1-gate-hardening.approval.json');
  });

  it('refuses a story with no Source spec line', () => {
    put(STORY_REL, '# Story\n\n**Status:** Draft\n\nBody.\n');
    expect(() => buildStoryApproval(input())).toThrow(/Source spec/);
  });

  it('refuses when the source spec has no approval', () => {
    rmSync(join(root, SPEC_REL.replace(/\.md$/, '.approval.json')));
    expect(() => buildStoryApproval(input())).toThrow(/no approval/);
  });

  it('refuses when the source spec approval is unclean', () => {
    put(
      SPEC_REL.replace(/\.md$/, '.approval.json'),
      specApproval().replace('"ok"', '"concerns"'),
    );
    expect(() => buildStoryApproval(input())).toThrow(/concerns/);
  });

  it('refuses a derivation verdict that is not ok', () => {
    // Mirrors buildApproval: a story the reviewer still has something to say
    // about cannot even produce an artifact to argue about later.
    expect(() => buildStoryApproval(input({ reviewVerdict: 'concerns' }))).toThrow(
      /refusing to record/,
    );
  });

  it('refuses when the story is already approved at this hash', () => {
    const { approval, outPath } = buildStoryApproval(input());
    put(outPath, JSON.stringify(approval));
    expect(() => buildStoryApproval(input())).toThrow(/already approved/);
  });

  it('refuses when the story approval file is corrupt', () => {
    const { outPath } = buildStoryApproval(input());
    put(outPath, '{ truncated');
    expect(() => buildStoryApproval(input())).toThrow(/could not be read/);
  });
});

describe('stampStatus', () => {
  it('replaces the status in place', () => {
    expect(stampStatus(story(), 'Approved')).toContain('**Status:** Approved');
    expect(stampStatus(story(), 'Approved')).not.toContain('**Status:** Draft');
  });

  it('leaves every other line untouched', () => {
    const before = story();
    const after = stampStatus(before, 'Approved');
    expect(hashStory(after)).toBe(hashStory(before));
  });

  it('a status line with a trailing annotation survives the round trip', () => {
    // The controller ruling: stamping drops the annotation on purpose (it
    // describes a state that is about to stop being true), but the hash must
    // still agree before and after, exactly as it does for a bare status line.
    const before = `# Story 8.1\n\n**Status:** Review — code merged\n**Source spec:** \`${SPEC_REL}\`\n\n## Story\n\nBody.\n`;
    const after = stampStatus(before, 'Approved');
    expect(after).toContain('**Status:** Approved');
    expect(after).not.toContain('code merged');
    expect(hashStory(after)).toBe(hashStory(before));
  });

  it('is idempotent', () => {
    const once = stampStatus(story(), 'Approved');
    expect(stampStatus(once, 'Approved')).toBe(once);
  });

  it('throws when the story has no status line to stamp', () => {
    // Silently appending one would invent a header the template owns.
    expect(() => stampStatus('# Story\n\nBody.\n', 'Approved')).toThrow(/no \*\*Status:\*\*/);
  });
});

describe('writeApproval', () => {
  it('writes the record and stamps the story together', () => {
    const { outPath } = writeApproval(input());
    const record = parseStoryApproval(read(join(root, outPath), 'utf8'));
    expect(record.ok).toBe(true);
    expect(read(join(root, STORY_REL), 'utf8')).toContain('**Status:** Approved');
  });

  it('writes nothing when a precondition fails', () => {
    // Neither file is written without the other.
    put(STORY_REL, '# Story\n\n**Status:** Draft\n\nBody.\n');
    expect(() => writeApproval(input())).toThrow(/Source spec/);
    expect(existsSync(join(root, approvalPathForStory(STORY_REL)))).toBe(false);
    expect(read(join(root, STORY_REL), 'utf8')).toContain('**Status:** Draft');
  });

  it('recovers when the second write fails: the story stays stamped and the retry succeeds', () => {
    // Simulate the approval-record write failing after the story has already
    // been stamped, without tripping buildStoryApproval's own "already
    // exists" check (which reads the record path if anything is there — a
    // directory placed directly at that path would throw EISDIR from that
    // read, before either write is attempted, and would prove nothing about
    // write order). Instead, strip write permission from the record's parent
    // directory: the file does not exist yet (so the existence check takes
    // the normal no-op path), but creating it fails with EACCES. Overwriting
    // the already-existing story file in the same directory is unaffected —
    // that needs write permission on the file, not on the directory.
    const outPath = approvalPathForStory(STORY_REL);
    const storyDirAbs = join(root, dirname(STORY_REL));
    chmodSync(storyDirAbs, 0o555);

    try {
      expect(() => writeApproval(input())).toThrow();
      // Recoverable state: the story is stamped Approved even though the
      // record never landed. A stamped-but-unrecorded story is refused by
      // the dispatch gate (fails closed) rather than silently treated as
      // approved.
      expect(read(join(root, STORY_REL), 'utf8')).toContain('**Status:** Approved');
      expect(existsSync(join(root, outPath))).toBe(false);
    } finally {
      chmodSync(storyDirAbs, 0o755); // restore before retrying (and for cleanup either way)
    }

    // Retry. The story's hash is unchanged (the status line is excluded from
    // hashStory) and no approval record exists yet, so neither guard in
    // buildStoryApproval has anything to trip on.
    expect(() => writeApproval(input())).not.toThrow();
    const record = parseStoryApproval(read(join(root, outPath), 'utf8'));
    expect(record.ok).toBe(true);
  });
});

describe('CLI invocation guard', () => {
  // `import.meta.url` percent-encodes reserved characters (a space becomes
  // `%20`), but `process.argv[1]` never does. A guard that compares
  // `import.meta.url` against a raw `file://${process.argv[1]}` string is
  // therefore false whenever the script's own path contains a space — main()
  // silently never runs, and the process exits 0 having written nothing. This
  // repo's own checkout can sit under a path like ".../Software Dev/...",
  // which triggers exactly this. Reproduced here by copying the CLI and its
  // two dependencies into a temp directory whose name contains a space, then
  // invoking it as a real subprocess the way the calling skill does.
  const tsxBin = resolve(process.cwd(), 'node_modules/.bin/tsx');

  it('still runs main() when its own script path contains a space', () => {
    // realpathSync: on macOS, os.tmpdir() sits under /var, which is itself a
    // symlink to /private/var. Node's loader resolves that symlink when
    // building `import.meta.url` but leaves `process.argv[1]` as given, which
    // would make the two disagree for a reason that has nothing to do with
    // spaces. Resolving the base path up front keeps the test isolated to the
    // one thing under test: percent-encoding of the space itself.
    const spaceRoot = mkdtempSync(join(realpathSync(tmpdir()), 'approve story cli-'));
    expect(spaceRoot).toMatch(/ /); // sanity: the reproduction requires a space

    for (const rel of ['lib/cli/approve-story.ts', 'lib/story-approval.ts', 'lib/spec-approval.ts']) {
      const dest = join(spaceRoot, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(resolve(process.cwd(), rel), dest);
    }

    try {
      execFileSync(tsxBin, [join(spaceRoot, 'lib/cli/approve-story.ts')], {
        // `cwd: root` rather than relying on a REPO_ROOT env var: at the time
        // this test was written `main()` still read `process.cwd()`
        // unconditionally (see Finding 4), so this keeps the reproduction
        // independent of that separate fix.
        cwd: root,
        env: {
          ...process.env,
          STORY_PATH: STORY_REL,
          REVIEW_VERDICT: 'ok',
          REVIEW_ROUNDS: '1',
          APPROVED_BY: 'ali@example.com',
          REPO_ROOT: root,
        },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`subprocess failed: ${err.stderr ?? err.stdout ?? String(e)}`);
    } finally {
      rmSync(spaceRoot, { recursive: true, force: true });
    }

    expect(existsSync(join(root, approvalPathForStory(STORY_REL)))).toBe(true);
    expect(read(join(root, STORY_REL), 'utf8')).toContain('**Status:** Approved');
  });
});
