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
});
