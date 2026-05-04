import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderPrompt } from '../../lib/render-prompt';

const promptsDir = resolve(__dirname, '../../prompts');

/**
 * Pluggable-skills wiring is spread across three prompt edits and one
 * workflow render-vars change. These tests pin down the parts that are
 * easy to break in a future edit:
 *   - The implement prompt's audit-chain section
 *   - The promote-to-prod prompt's dual-resolution block
 *   - The rollback prompt's scaffold_skills.migration handling
 *   - The implement prompt's required output now lists `audits[]`
 */

describe('audit_skills.pre_pr (implement)', () => {
  const path = resolve(promptsDir, 'implement.md');
  const raw = readFileSync(path, 'utf8');

  it('declares {{audit_skills.pre_pr}} as a documented input', () => {
    expect(raw).toMatch(/\{\{audit_skills\.pre_pr\}\}/);
  });

  it('has a "Pre-PR audit chain" section with dual-resolution rules', () => {
    expect(raw).toMatch(/##\s+Pre-PR audit chain/);
    expect(raw).toMatch(/scripts\/<skill>\.sh/);
    expect(raw).toMatch(/\.claude\/skills\/<skill>\/SKILL\.md/);
  });

  it('explicitly says failures DO NOT block PR open (flag-only behavior)', () => {
    expect(raw).toMatch(/do(?:n't| not| NOT) block PR open/i);
    expect(raw).toMatch(/audit-failed:<skill-name>/i);
  });

  it('says continue the chain on failure (collect ALL failures, don\'t abort first)', () => {
    expect(raw).toMatch(/Continue the chain.*don't abort/i);
  });

  it('extends the required-output JSON to include an audits[] array', () => {
    expect(raw).toMatch(/"audits":/);
    expect(raw).toMatch(/"resolved":\s*"script"\s*\|\s*"claude_skill"\s*\|\s*null/);
  });

  it('renders cleanly when audit_skills.pre_pr is empty (Handlebars strict-mode)', () => {
    const out = renderPrompt('implement', {
      spec_path: 'docs/specs/x.md',
      branch_name: 'feat/dev-agent-issue-1',
      issue_number: 1,
      commands: { test: 'npm test', typecheck: 'npm run tc', lint: null },
      guardrails: {
        blocked_paths: [],
        require_explicit_unlock: [],
        max_files_changed: 30,
        max_lines_changed: 800,
      },
      audit_skills: { pre_pr: [] },
    });
    expect(out).toContain('Pre-PR audit chain');
  });

  it('renders with a non-empty audit list', () => {
    const out = renderPrompt('implement', {
      spec_path: 'docs/specs/x.md',
      branch_name: 'feat/dev-agent-issue-1',
      issue_number: 1,
      commands: { test: 'npm test', typecheck: 'npm run tc', lint: null },
      guardrails: {
        blocked_paths: [],
        require_explicit_unlock: [],
        max_files_changed: 30,
        max_lines_changed: 800,
      },
      audit_skills: { pre_pr: ['lint', 'policy-check'] },
    });
    // Handlebars renders an array as a comma-joined string.
    expect(out).toContain('lint,policy-check');
  });
});

describe('deploy_skills dual-resolution (promote-to-prod)', () => {
  const path = resolve(promptsDir, 'promote-to-prod.md');
  const raw = readFileSync(path, 'utf8');

  it('has a "How to invoke each skill" section symmetric with staging-deploy.md', () => {
    expect(raw).toMatch(/##\s+How to invoke each skill/);
    expect(raw).toMatch(/scripts\/<skill>\.sh/);
    expect(raw).toMatch(/\.claude\/skills\/<skill>\/SKILL\.md/);
  });

  it('aborts the chain on missing skill (matches staging-deploy contract)', () => {
    expect(raw).toMatch(/abort the chain.*skill not found/i);
  });
});

describe('scaffold_skills.migration (rollback)', () => {
  const path = resolve(promptsDir, 'rollback.md');
  const raw = readFileSync(path, 'utf8');

  it('declares {{scaffold_skills.migration}} as a documented input', () => {
    expect(raw).toMatch(/\{\{scaffold_skills\.migration\}\}/);
  });

  it('has a "How to locate paired rollback SQL" section with dual-resolution + fallback', () => {
    expect(raw).toMatch(/##\s+How to locate paired rollback SQL/);
    expect(raw).toMatch(/scripts\/\{\{scaffold_skills\.migration\}\}\.sh/);
    expect(raw).toMatch(/\.claude\/skills\/\{\{scaffold_skills\.migration\}\}\/SKILL\.md/);
  });

  it('falls back to a sibling _rollback.sql convention when scaffold_skills.migration is empty', () => {
    expect(raw).toMatch(/_rollback\.sql/);
    expect(raw).toMatch(/(empty|unresolvable).*sibling/i);
  });

  it('escalates rather than schema-rollbacks-by-hand if no rollback file exists', () => {
    expect(raw).toMatch(/escalate.*state:blocked/i);
    expect(raw).toMatch(/Do NOT.*manual schema rollback/i);
  });

  it('also has a deploy-skill dual-resolution block (rollback redeploys via deploy_skills)', () => {
    expect(raw).toMatch(/##\s+How to invoke deploy skills/);
  });

  it('renders cleanly with both empty and populated scaffold_skills.migration', () => {
    const baseVars = {
      issue_number: 42,
      merged_pr: 100,
      branches: { staging: 'staging', release_target: 'main' },
      deploy_skills: { staging: [], prod: [] },
      commands: { test: 'npm test' },
    };
    expect(() =>
      renderPrompt('rollback', { ...baseVars, scaffold_skills: { migration: '' } }),
    ).not.toThrow();
    expect(() =>
      renderPrompt('rollback', { ...baseVars, scaffold_skills: { migration: 'supabase-migration' } }),
    ).not.toThrow();
  });
});
