import { describe, it, expect } from 'vitest';
import { renderPrompt } from '../../lib/render-prompt';

describe('renderPrompt', () => {
  const baseImplementVars = {
    spec_path: 'docs/specs/foo.md',
    plan_path: 'docs/plans/foo.md',
    branch_name: 'feat/bar',
    issue_number: 42,
    commands: { test: 'npm test', typecheck: 'tsc', lint: 'eslint' },
    guardrails: {
      blocked_paths: ['supabase/migrations/**'],
      require_explicit_unlock: ['tests/integration/**'],
      max_files_changed: 30,
      max_lines_changed: 800,
    },
    audit_skills: { pre_pr: [] },
  };

  it('substitutes {{var}} placeholders', () => {
    const out = renderPrompt('implement', baseImplementVars);
    expect(out).toContain('docs/specs/foo.md');
    expect(out).toContain('feat/bar');
    expect(out).toContain('npm test');
  });

  it('renders plan_path when present', () => {
    const out = renderPrompt('implement', {
      ...baseImplementVars,
      plan_path: 'docs/plans/x.md',
    });
    expect(out).toContain('docs/plans/x.md');
    // No unreplaced placeholder remains.
    expect(out).not.toMatch(/\{\{plan_path\}\}/);
  });

  it('leaves no unreplaced template placeholder when plan_path is empty', () => {
    const out = renderPrompt('implement', { ...baseImplementVars, plan_path: '' });
    expect(out).not.toMatch(/\{\{plan_path\}\}/);
  });

  it('throws on missing required variable', () => {
    expect(() => renderPrompt('implement', {})).toThrow();
  });

  it('handles array variables', () => {
    const out = renderPrompt('staging-deploy', {
      consumer_root: '.',
      deploy_skills: { staging: ['deploy-a', 'deploy-b'] },
      branches: { staging: 'staging' },
      commands: { test: 'npm test' },
      merge_sha: 'abc123',
    });
    expect(out).toContain('deploy-a');
  });

  it('rejects unknown prompt name', () => {
    expect(() => renderPrompt('does-not-exist' as never, {})).toThrow(/unknown|not found/i);
  });
});
