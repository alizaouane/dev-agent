import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

import { parseConfig } from '../../lib/parse-config';

const templateRoot = resolve(__dirname, '../../examples/web-app-template');
const DEFAULTS = resolve(__dirname, '../../schema/defaults.yml');

/**
 * The web-app-template is the copy-paste starting point for new consumers.
 * If it stops parsing or stops referencing the right reusable workflow
 * tags, every fresh onboarding silently lands a broken setup. Lock the
 * shape down here so the template can't drift from the engine.
 */
describe('examples/web-app-template', () => {
  it('.dev-agent.yml exists, parses, and validates against the schema', async () => {
    const configPath = resolve(templateRoot, '.dev-agent.yml');
    expect(existsSync(configPath)).toBe(true);
    // parseConfig throws if the file is invalid against the published
    // dev-agent schema — this catches drift between template and schema.
    const cfg = await parseConfig({ configPath, defaultsPath: DEFAULTS });
    expect(cfg.commands.test).toBeDefined();
    expect(cfg.guardrails.max_files_changed).toBeGreaterThan(0);
  });

  it('.dev-agent.yml blocks env files and secrets by default', async () => {
    const cfg = await parseConfig({
      configPath: resolve(templateRoot, '.dev-agent.yml'),
      defaultsPath: DEFAULTS,
    });
    const blocked = cfg.guardrails.blocked_paths;
    expect(blocked).toContain('.env*');
    expect(blocked).toContain('secrets/**');
    // Workflows themselves should be unlocked only via PR review.
    expect(blocked.some((p) => p.includes('.github/workflows'))).toBe(true);
  });

  it('wrapper workflow references the published v1 tag', () => {
    const path = resolve(templateRoot, '.github/workflows/dev-agent.yml');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    const parsed = yaml.load(raw) as { jobs: Record<string, { uses?: string }> };
    const jobs = Object.values(parsed.jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      // Every job must call a reusable workflow pinned to a published
      // tag — never a branch name (which would silently follow main).
      expect(job.uses).toMatch(/^alizaouane\/dev-agent\/\.github\/workflows\/phase-[a-z-]+\.yml@v\d+/);
    }
  });

  it('wrapper covers the four human-dispatchable phases', () => {
    // smoke-verify was removed in #72 — it requires upstream inputs
    // (smoke_phase / smoke_output / smoke_exit_code) that the
    // wrapper has no way to supply, so including it failed workflow
    // validation at startup. It still runs internally from
    // staging-deploy; that's the right place for it.
    const raw = readFileSync(resolve(templateRoot, '.github/workflows/dev-agent.yml'), 'utf8');
    const expected = [
      'phase-implement.yml',
      'phase-staging-deploy.yml',
      'phase-promote-to-prod.yml',
      'phase-rollback.yml',
    ];
    for (const phase of expected) {
      expect(raw).toContain(phase);
    }
    // Guard against re-adding smoke-verify here — see #72 commit
    // c1e51b7 for the failure mode.
    expect(raw).not.toContain('phase-smoke-verify.yml');
  });

  it('verification wrapper exists + all jobs are pinned to v1', () => {
    // dev-agent-verification.yml is the auto-dispatch wrapper (v1.5+) that
    // fires the verification gates on issue/PR events. Its presence is what
    // activates the gates on a consumer; absence keeps existing flows
    // unchanged. Lock the shape so consumers copying it land a working setup.
    const path = resolve(templateRoot, '.github/workflows/dev-agent-verification.yml');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    const parsed = yaml.load(raw) as { jobs: Record<string, { uses?: string }> };
    const jobs = Object.values(parsed.jobs);
    expect(jobs.length).toBeGreaterThan(0);
    // Reusable-workflow jobs must pin to a published v-tag, never a branch.
    // The aggregate `verification-gate` job is a plain runs-on/steps job
    // (no `uses:`) — it has nothing to pin, so it's excluded here.
    const reusableJobs = jobs.filter((job) => job.uses !== undefined);
    expect(reusableJobs.length).toBeGreaterThan(0);
    for (const job of reusableJobs) {
      expect(job.uses).toMatch(/^alizaouane\/dev-agent\/\.github\/workflows\/phase-[a-z-]+\.yml@v\d+/);
    }
  });

  it('verification wrapper covers the three v1.5 gates (acm + evidence + swarm)', () => {
    const raw = readFileSync(resolve(templateRoot, '.github/workflows/dev-agent-verification.yml'), 'utf8');
    for (const phase of ['phase-acm.yml', 'phase-evidence-collector.yml', 'phase-swarm-review.yml']) {
      expect(raw).toContain(phase);
    }
  });

  it('verification wrapper triggers on issue_comment + pull_request only', () => {
    // The wrapper must NOT use pull_request_target (fork-PR security
    // footgun) and must scope triggers tightly. Internal-team PRs work
    // end-to-end; fork PRs intentionally skip via the same-repo guard
    // below — not via fragile token-perm fallbacks.
    const raw = readFileSync(resolve(templateRoot, '.github/workflows/dev-agent-verification.yml'), 'utf8');
    expect(raw).toMatch(/issue_comment:/);
    expect(raw).toMatch(/pull_request:/);
    expect(raw).not.toMatch(/pull_request_target:/);
  });

  it('verification wrapper uses startsWith (not contains) for /approve match', () => {
    // CodeRabbit nitpick (PR #77): `contains(comment.body, '/approve')`
    // matches `> /approve` (quoted reply), `Please don't /approve yet`
    // (prose), and `/approveplus` (typo). With the same-author guard
    // these aren't exploitable, but they fire surprising runs and waste
    // runner minutes on every comment in the repo. `startsWith` only
    // matches when the comment begins with the command.
    const raw = readFileSync(resolve(templateRoot, '.github/workflows/dev-agent-verification.yml'), 'utf8');
    expect(raw).toMatch(/startsWith\(github\.event\.comment\.body, '\/approve'\)/);
    // Negative: ensure the old contains-based match isn't restored.
    expect(raw).not.toMatch(/contains\(github\.event\.comment\.body, '\/approve'\)/);
  });

  it('verification wrapper guards every PR-triggered job to same-repo only', () => {
    // P2 (PR #77 review): `pull_request` from forks would otherwise enter
    // evidence/swarm-review jobs and crash on missing secrets / read-only
    // tokens. The same-repo guard skips fork PRs at the wrapper level so
    // they cleanly don't run (rather than running and failing loudly).
    // Lock this in: every job firing on `pull_request` events MUST check
    // `head.repo.full_name == github.repository`. (The `acm` job is gated
    // on `issue_comment`, not `pull_request`, so it's exempt.)
    const raw = readFileSync(resolve(templateRoot, '.github/workflows/dev-agent-verification.yml'), 'utf8');
    const parsed = yaml.load(raw) as { jobs: Record<string, { if?: string }> };
    for (const [jobName, job] of Object.entries(parsed.jobs)) {
      const cond = job.if ?? '';
      // Only assert the guard for jobs that explicitly fire on
      // pull_request events — not jobs that merely reference
      // `issue.pull_request` (which is the null-check distinguishing
      // an issue comment from a PR comment).
      if (!cond.includes("event_name == 'pull_request'")) continue;
      expect(
        cond,
        `${jobName}: pull_request-triggered job must include same-repo guard`,
      ).toMatch(/head\.repo\.full_name == github\.repository/);
    }
  });

  it('tier2-smoke wrapper exists, pins reusable to v1, declares the right permissions', () => {
    const path = resolve(templateRoot, '.github/workflows/dev-agent-tier2-smoke.yml');
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    const parsed = yaml.load(raw) as {
      permissions?: Record<string, string>;
      on?: { issues?: { types: string[] }; workflow_dispatch?: unknown };
      jobs: Record<string, { uses?: string; if?: string }>;
    };
    expect(parsed.permissions?.contents).toBe('read');
    expect(parsed.permissions?.issues).toBe('write');
    expect(parsed.permissions?.['id-token']).toBe('write');
    expect(parsed.on?.issues?.types).toContain('labeled');
    expect(parsed.on?.workflow_dispatch).toBeDefined();
    const jobs = Object.values(parsed.jobs);
    const reusableJobs = jobs.filter((j) => j.uses !== undefined);
    expect(reusableJobs.length).toBe(1);
    expect(reusableJobs[0].uses).toMatch(
      /^alizaouane\/dev-agent\/\.github\/workflows\/phase-tier2-smoke\.yml@v\d+/,
    );
    const resolveJob = jobs.find((j) => j.uses === undefined);
    expect(resolveJob?.if ?? '').toMatch(/state:staging-deployed/);
    expect(resolveJob?.if ?? '').toMatch(/kind:user-intent/);
  });

  it('scout workflows grant workflow-level permissions so reusable jobs can start', () => {
    // The reusable phase-{bug,unfinished-work,cleanup}-scout workflows
    // declare job-level `permissions: { contents: read, issues: write,
    // id-token: write }`. A reusable workflow can never elevate above what
    // the caller grants — so each scout wrapper MUST grant those at the
    // workflow level. Without the block the caller inherits the repo's
    // default GITHUB_TOKEN scopes, and on a repo whose default is read-only
    // the called job fails at startup ("but is only allowed issues:
    // none, ..."). That was the bug behind every scout run on consumer
    // repos coming back as startup_failure.
    const scouts = [
      'dev-agent-bug-scout.yml',
      'dev-agent-unfinished-work-scout.yml',
      'dev-agent-cleanup-scout.yml',
    ];
    for (const file of scouts) {
      const raw = readFileSync(
        resolve(templateRoot, '.github/workflows', file),
        'utf8',
      );
      const parsed = yaml.load(raw) as { permissions?: Record<string, string> };
      expect(parsed.permissions, `${file}: missing workflow-level permissions block`).toBeDefined();
      expect(parsed.permissions?.issues, `${file}: needs issues: write`).toBe('write');
      expect(parsed.permissions?.['id-token'], `${file}: needs id-token: write`).toBe('write');
      expect(parsed.permissions?.contents, `${file}: needs contents: read`).toBe('read');
    }
  });
});
