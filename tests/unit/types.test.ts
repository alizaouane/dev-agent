import { describe, it, expectTypeOf } from 'vitest';
import type { DevAgentConfig } from '../../lib/types';

describe('DevAgentConfig type', () => {
  it('compiles with a complete sample', () => {
    const sample: DevAgentConfig = {
      schema_version: 1,
      commands: { test: 'npm test', build: 'npm run build', typecheck: 'npm run typecheck' },
      branches: { default: 'main', staging: 'staging', release_target: 'main', release_pr_required: true },
      deploy_skills: { staging: ['deploy-staging'], prod: ['deploy-prod'] },
      audit_skills: { pre_pr: ['lint'] },
      scaffold_skills: { edge_function: 'new-fn', migration: 'new-mig' },
      artifacts: {
        specs_dir: 'docs/specs',
        plans_dir: 'docs/plans',
        status_file: 'docs/status.md',
        runbooks_dir: 'docs/runbooks',
      },
      guardrails: {
        blocked_paths: [],
        require_explicit_unlock: [],
        max_files_changed: 30,
        max_lines_changed: 800,
        scope_creep_thresholds: { files_outside_spec_scope: 0, loc_outside_spec_scope: 50 },
        trivial_cleanup_categories: ['formatting'],
      },
      cost_caps: {
        spec_brainstorm: { tokens_in: 100000, tokens_out: 30000, dollars: 3 },
        implement: { tokens_in: 200000, tokens_out: 100000, dollars: 5 },
        staging_deploy: { tokens_in: 50000, tokens_out: 20000, dollars: 1 },
        promote_to_prod: { tokens_in: 75000, tokens_out: 30000, dollars: 1.5 },
        smoke_verify: { tokens_in: 30000, tokens_out: 10000, dollars: 0.5 },
        scout_digest: { tokens_in: 100000, tokens_out: 20000, dollars: 0.5 },
        rollback: { tokens_in: 50000, tokens_out: 20000, dollars: 1 },
      },
      models: {
        scout: 'claude-haiku-4-5',
        triage: 'claude-haiku-4-5',
        smoke_analysis: 'claude-haiku-4-5',
        drift_detection: 'claude-haiku-4-5',
        notification: 'claude-haiku-4-5',
        implementation: 'claude-sonnet-4-6',
        staging_deploy: 'claude-sonnet-4-6',
        promote_to_prod: 'claude-sonnet-4-6',
        rollback: 'claude-sonnet-4-6',
        spec_brainstorm: 'claude-opus-4-7',
        ambiguous_failure: 'claude-opus-4-7',
      },
      scout: {
        enabled: true,
        cron: '0 9 * * *',
        sources: [{ kind: 'github_issues' }],
        suppression: { track_rejections: true, suppress_after_n_rejects: 3 },
      },
      notifications: {
        push: { provider: 'ntfy.sh', topic: 'dev-agent' },
        email: { via: 'resend', secret_name: 'RESEND_API_KEY', to: 'user@example.com' },
        github_issue: true,
        status_file: true,
      },
      hotfix: { enabled: true, required_label: 'kind:hotfix', skip_spec: true, skip_drift_check: false },
    };
    expectTypeOf(sample).toMatchTypeOf<DevAgentConfig>();
  });
});
