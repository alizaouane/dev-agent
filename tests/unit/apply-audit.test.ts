import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { runAudit, renderMarkdown } from '../../lib/cli/apply-audit';

/**
 * Pillar 4 advisory audit. Tests the report-rendering + the runAudit
 * function over a real git working tree (since the audit fundamentally
 * shells out to `git diff`). Each test creates a fresh repo so the
 * git-diff resolution is deterministic.
 */
describe('lib/cli/apply-audit', () => {
  let repoRoot: string;

  function git(...args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  function initRepoWithBaseCommit(): void {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repoRoot, 'README.md'), '# initial\n', 'utf8');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    // Create a `main` branch alias so origin/main fallback works in tests.
    git('branch', '-M', 'main');
    // Simulate `origin/main` by tagging — git diff origin/main...HEAD
    // works against any ref whose name git can resolve.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'apply-audit-'));
    initRepoWithBaseCommit();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns no-files verdict when the diff has no TS/JS files', () => {
    writeFileSync(join(repoRoot, 'README.md'), '# updated\n', 'utf8');
    git('add', '.');
    git('commit', '-q', '-m', 'docs');
    const report = runAudit({
      baseRef: 'origin/main',
      output: '/tmp/unused',
      repoRoot,
    });
    expect(report.verdict).toBe('no-files');
    expect(report.files_checked).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it('returns clean verdict when all TS files parse', () => {
    writeFileSync(join(repoRoot, 'good.ts'), 'export const x: number = 42;\n', 'utf8');
    writeFileSync(join(repoRoot, 'good.tsx'), "export function F() { return <div>ok</div>; }\n", 'utf8');
    git('add', '.');
    git('commit', '-q', '-m', 'good');
    const report = runAudit({
      baseRef: 'origin/main',
      output: '/tmp/unused',
      repoRoot,
    });
    expect(report.verdict).toBe('clean');
    expect(report.files_checked).toBe(2);
    expect(report.errors).toEqual([]);
  });

  it('returns syntax-errors verdict + lists the bad file when TS fails to parse', () => {
    writeFileSync(join(repoRoot, 'good.ts'), 'export const x = 1;\n', 'utf8');
    // Truncated arrow function — the TS parser will reject this.
    writeFileSync(join(repoRoot, 'bad.ts'), 'const fn = (a, b) => {\n', 'utf8');
    git('add', '.');
    git('commit', '-q', '-m', 'mixed');
    const report = runAudit({
      baseRef: 'origin/main',
      output: '/tmp/unused',
      repoRoot,
    });
    expect(report.verdict).toBe('syntax-errors');
    expect(report.files_checked).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].file).toBe('bad.ts');
    expect(report.errors[0].error).toMatch(/syntax error/);
  });

  it('skips deleted files (diff includes them but content is gone)', () => {
    writeFileSync(join(repoRoot, 'will-delete.ts'), 'export const x = 1;\n', 'utf8');
    git('add', '.');
    git('commit', '-q', '-m', 'add');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const r = spawnSync('rm', [join(repoRoot, 'will-delete.ts')]);
    expect(r.status).toBe(0);
    git('add', '-A');
    git('commit', '-q', '-m', 'delete');
    const report = runAudit({
      baseRef: 'origin/main',
      output: '/tmp/unused',
      repoRoot,
    });
    // The deleted file shouldn't crash + shouldn't be counted as checked.
    expect(report.verdict).toBe('no-files');
    expect(report.errors).toEqual([]);
  });

  it('falls back to HEAD~1 when the base ref is unreachable', () => {
    writeFileSync(join(repoRoot, 'good.ts'), 'export const x = 1;\n', 'utf8');
    git('add', '.');
    git('commit', '-q', '-m', 'good');
    const report = runAudit({
      baseRef: 'origin/nonexistent-ref',
      output: '/tmp/unused',
      repoRoot,
    });
    // Fallback path: should resolve to HEAD~1 + report findings.
    expect(report.base_ref).toBe('HEAD~1');
    expect(report.verdict).toBe('clean');
    expect(report.files_checked).toBe(1);
  });

  describe('codex P2 — working-tree visibility (uncommitted + untracked)', () => {
    it('audits an UNTRACKED .ts file the agent wrote but never `git add`ed', () => {
      // The exact failure mode codex flagged: agent ends turn without
      // committing → audit step runs → salvage step (which runs AFTER
      // the audit) auto-commits broken TS. Without working-tree
      // visibility, the audit reports `no-files` and the broken code
      // ships. Lock the visibility in.
      writeFileSync(join(repoRoot, 'agent-wrote.ts'), 'const fn = (a, b => {\n', 'utf8');
      // Note: NO `git add`, NO commit — exactly the agent-pre-salvage state.
      const report = runAudit({
        baseRef: 'origin/main',
        output: '/tmp/unused',
        repoRoot,
      });
      expect(report.verdict).toBe('syntax-errors');
      expect(report.files_checked).toBe(1);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].file).toBe('agent-wrote.ts');
    });

    it('audits a STAGED-but-not-committed .ts edit', () => {
      // The agent did `git add` but ended turn before `git commit`. The
      // salvage step would then commit + push. Audit must see the staged
      // change.
      writeFileSync(join(repoRoot, 'staged.ts'), 'const broken = (\n', 'utf8');
      git('add', 'staged.ts');
      // No commit.
      const report = runAudit({
        baseRef: 'origin/main',
        output: '/tmp/unused',
        repoRoot,
      });
      expect(report.verdict).toBe('syntax-errors');
      expect(report.errors[0].file).toBe('staged.ts');
    });

    it('audits a MODIFIED-but-not-committed change to a tracked file', () => {
      // Agent edited an existing tracked file then exited; salvage will
      // commit the modification. The audit must catch broken syntax in
      // the working-tree version even though HEAD has the clean version.
      writeFileSync(join(repoRoot, 'tracked.ts'), 'export const x: number = 1;\n', 'utf8');
      git('add', '.');
      git('commit', '-q', '-m', 'add tracked');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      // Now break it in the working tree (no add, no commit).
      writeFileSync(join(repoRoot, 'tracked.ts'), 'export const x: number = (\n', 'utf8');
      const report = runAudit({
        baseRef: 'origin/main',
        output: '/tmp/unused',
        repoRoot,
      });
      expect(report.verdict).toBe('syntax-errors');
      expect(report.errors[0].file).toBe('tracked.ts');
    });

    it('honors .gitignore (does NOT audit ignored files)', () => {
      // Defensive: the untracked-file scan uses --exclude-standard so
      // node_modules, dist/, etc. don't get audited. A broken .ts in an
      // ignored path must NOT be reported.
      writeFileSync(join(repoRoot, '.gitignore'), 'ignored/\n', 'utf8');
      git('add', '.gitignore');
      git('commit', '-q', '-m', 'gitignore');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      // Drop a broken file inside the ignored path.
      const ignoredDir = join(repoRoot, 'ignored');
      spawnSync('mkdir', ['-p', ignoredDir]);
      writeFileSync(join(ignoredDir, 'broken.ts'), 'const fn = (\n', 'utf8');
      const report = runAudit({
        baseRef: 'origin/main',
        output: '/tmp/unused',
        repoRoot,
      });
      // No real changes outside ignored/ → no-files. The broken ignored
      // file must not surface.
      expect(report.verdict).toBe('no-files');
      expect(report.errors).toEqual([]);
    });

    it('dedupes a file that appears in both committed + working-tree channels', () => {
      // Agent committed a partial edit, then edited again without
      // committing. The same path appears in `git diff <base>...HEAD`
      // AND in `git diff HEAD --name-only`. The audit must check it
      // once (not double-count). Counter invariant.
      writeFileSync(join(repoRoot, 'evolving.ts'), 'export const a = 1;\n', 'utf8');
      git('add', '.');
      git('commit', '-q', '-m', 'first edit');
      // Now modify in working tree without committing.
      writeFileSync(join(repoRoot, 'evolving.ts'), 'export const a = 2;\n', 'utf8');
      const report = runAudit({
        baseRef: 'origin/main',
        output: '/tmp/unused',
        repoRoot,
      });
      // Both passes find evolving.ts; dedupe → files_checked === 1.
      expect(report.files_checked).toBe(1);
      expect(report.verdict).toBe('clean');
    });

    it('still works when no committed history exists (only working-tree changes)', () => {
      // Edge case: a fresh shallow clone with the base ref unreachable
      // AND no HEAD~1. The committed channel returns nothing; the
      // uncommitted + untracked channels still work. Lock that the
      // audit doesn't crash + still surfaces broken syntax.
      writeFileSync(join(repoRoot, 'fresh.ts'), 'const fn = (\n', 'utf8');
      const report = runAudit({
        baseRef: 'origin/nonexistent-ref',
        output: '/tmp/unused',
        repoRoot,
      });
      // base_ref reflects either HEAD~1 fallback (initial commit exists) or 'unavailable'.
      expect(['HEAD~1', 'unavailable']).toContain(report.base_ref);
      // Either way, the broken untracked file MUST be flagged.
      expect(report.verdict).toBe('syntax-errors');
      expect(report.errors[0].file).toBe('fresh.ts');
    });
  });

  it('truncates long error messages to fit in the PR comment', () => {
    // Very long broken file — the TS parser's error includes a substring
    // of the source. Make sure we cap at 400 chars per error so the PR
    // comment stays readable.
    const huge = 'X'.repeat(2000);
    writeFileSync(join(repoRoot, 'big.ts'), `const fn = (${huge}\n`, 'utf8');
    git('add', '.');
    git('commit', '-q', '-m', 'big');
    const report = runAudit({
      baseRef: 'origin/main',
      output: '/tmp/unused',
      repoRoot,
    });
    expect(report.verdict).toBe('syntax-errors');
    expect(report.errors[0].error.length).toBeLessThanOrEqual(400);
  });

  describe('renderMarkdown', () => {
    it('produces a no-files notice when nothing was checked', () => {
      const md = renderMarkdown({ verdict: 'no-files', files_checked: 0, base_ref: 'origin/main', errors: [] });
      expect(md).toMatch(/Verdict: no-files/);
      expect(md).toMatch(/informational, not a failure/);
    });

    it("produces a clean notice that's positive but brief", () => {
      const md = renderMarkdown({ verdict: 'clean', files_checked: 5, base_ref: 'origin/main', errors: [] });
      expect(md).toMatch(/Verdict: clean/);
      expect(md).toMatch(/Files checked: 5/);
      expect(md).toMatch(/parsed cleanly/);
    });

    it('produces a syntax-errors report with a row per error', () => {
      const md = renderMarkdown({
        verdict: 'syntax-errors',
        files_checked: 3,
        base_ref: 'origin/main',
        errors: [
          { file: 'a.ts', error: 'syntax error at line 1' },
          { file: 'b.ts', error: 'syntax error at line 7' },
        ],
      });
      expect(md).toMatch(/Verdict: syntax-errors \(2 of 3 files\)/);
      expect(md).toMatch(/`a\.ts` — syntax error at line 1/);
      expect(md).toMatch(/`b\.ts` — syntax error at line 7/);
      expect(md).toMatch(/Advisory in v1.*does not block/);
    });

    it('caps the rendered errors list at 20 with a "more" footer', () => {
      const errors = Array.from({ length: 25 }, (_, i) => ({ file: `f${i}.ts`, error: `err ${i}` }));
      const md = renderMarkdown({ verdict: 'syntax-errors', files_checked: 25, base_ref: 'origin/main', errors });
      expect((md.match(/`f\d+\.ts`/g) ?? []).length).toBe(20);
      expect(md).toMatch(/and 5 more errors/);
    });
  });
});
