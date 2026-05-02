import { describe, it, expect } from 'vitest';
import { devAgentConfigSchema } from '../../lib/schema';

const validSample = {
  schema_version: 1,
  commands: { test: 'npm test', build: 'npm run build', typecheck: 'npm run typecheck' },
  branches: { default: 'main', staging: 'staging', release_target: 'main', release_pr_required: true },
  deploy_skills: { staging: ['deploy-staging'], prod: ['deploy-prod'] },
  audit_skills: { pre_pr: ['lint'] },
  scaffold_skills: {},
  artifacts: { specs_dir: 'docs/specs', plans_dir: 'docs/plans', status_file: 'docs/status.md', runbooks_dir: 'docs/runbooks' },
  guardrails: {
    blocked_paths: [], require_explicit_unlock: [], max_files_changed: 30, max_lines_changed: 800,
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
    scout: 'claude-haiku-4-5', triage: 'claude-haiku-4-5', smoke_analysis: 'claude-haiku-4-5',
    drift_detection: 'claude-haiku-4-5', notification: 'claude-haiku-4-5',
    implementation: 'claude-sonnet-4-6', staging_deploy: 'claude-sonnet-4-6',
    promote_to_prod: 'claude-sonnet-4-6', rollback: 'claude-sonnet-4-6',
    spec_brainstorm: 'claude-opus-4-7', ambiguous_failure: 'claude-opus-4-7',
  },
  scout: {
    enabled: true, cron: '0 9 * * *', sources: [{ kind: 'github_issues' }],
    suppression: { track_rejections: true, suppress_after_n_rejects: 3 },
  },
  notifications: { github_issue: true, status_file: true },
  hotfix: { enabled: true, required_label: 'kind:hotfix', skip_spec: true, skip_drift_check: false },
};

describe('devAgentConfigSchema', () => {
  it('accepts a complete valid config', () => {
    const result = devAgentConfigSchema.safeParse(validSample);
    expect(result.success).toBe(true);
  });

  it('rejects schema_version other than 1', () => {
    const bad = { ...validSample, schema_version: 2 };
    const result = devAgentConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects missing commands.test', () => {
    const bad = { ...validSample, commands: { build: 'x', typecheck: 'y' } };
    const result = devAgentConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects negative cost cap dollars', () => {
    const bad = { ...validSample, cost_caps: { ...validSample.cost_caps, implement: { tokens_in: 1, tokens_out: 1, dollars: -1 } } };
    const result = devAgentConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('accepts staging: null (no staging-first repo)', () => {
    const variant = { ...validSample, branches: { ...validSample.branches, staging: null } };
    const result = devAgentConfigSchema.safeParse(variant);
    expect(result.success).toBe(true);
  });
});
