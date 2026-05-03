import { describe, it, expect } from 'vitest';
import { renderPrompt } from '../../lib/render-prompt';

describe('renderPrompt', () => {
  it('substitutes {{var}} placeholders', () => {
    const out = renderPrompt('implement', {
      spec_path: 'docs/specs/foo.md',
      branch_name: 'feat/bar',
      commands: { test: 'npm test', typecheck: 'tsc', lint: 'eslint' },
      guardrails: {
        blocked_paths: ['supabase/migrations/**'],
        require_explicit_unlock: ['tests/integration/**'],
        max_files_changed: 30,
        max_lines_changed: 800,
      },
    });
    expect(out).toContain('docs/specs/foo.md');
    expect(out).toContain('feat/bar');
    expect(out).toContain('npm test');
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
