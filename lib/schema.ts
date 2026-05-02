import { z } from 'zod';

const modelIdSchema = z.string().min(1);

const phaseCostCapSchema = z.object({
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  dollars: z.number().nonnegative(),
});

const scoutSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github_issues') }),
  z.object({ kind: z.literal('vercel_logs'), project: z.string() }),
  z.object({ kind: z.literal('supabase_logs'), project_ids: z.array(z.string()) }),
  z.object({
    kind: z.literal('codebase_audit'),
    pitfalls_path: z.string(),
    max_age_days: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('competitive'), feeds: z.array(z.string()) }),
]);

export const devAgentConfigSchema = z.object({
  schema_version: z.literal(1),
  commands: z.object({
    test: z.string().min(1),
    test_unit: z.string().optional(),
    test_contract: z.string().optional(),
    test_integration: z.string().optional(),
    test_components: z.string().optional(),
    test_e2e: z.string().optional(),
    build: z.string().min(1),
    typecheck: z.string().min(1),
    lint: z.string().optional(),
  }),
  branches: z.object({
    default: z.string().min(1),
    staging: z.string().nullable(),
    release_target: z.string().min(1),
    release_pr_required: z.boolean(),
  }),
  deploy_skills: z.object({
    staging: z.array(z.string()),
    prod: z.array(z.string()),
  }),
  audit_skills: z.object({
    pre_pr: z.array(z.string()),
  }),
  scaffold_skills: z.object({
    edge_function: z.string().optional(),
    migration: z.string().optional(),
  }),
  artifacts: z.object({
    specs_dir: z.string().min(1),
    plans_dir: z.string().min(1),
    status_file: z.string().min(1),
    runbooks_dir: z.string().min(1),
  }),
  guardrails: z.object({
    blocked_paths: z.array(z.string()),
    require_explicit_unlock: z.array(z.string()),
    max_files_changed: z.number().int().positive(),
    max_lines_changed: z.number().int().positive(),
    scope_creep_thresholds: z.object({
      files_outside_spec_scope: z.number().int().nonnegative(),
      loc_outside_spec_scope: z.number().int().nonnegative(),
    }),
    trivial_cleanup_categories: z.array(z.string()),
  }),
  cost_caps: z.object({
    spec_brainstorm: phaseCostCapSchema,
    implement: phaseCostCapSchema,
    staging_deploy: phaseCostCapSchema,
    promote_to_prod: phaseCostCapSchema,
    smoke_verify: phaseCostCapSchema,
    scout_digest: phaseCostCapSchema,
    rollback: phaseCostCapSchema,
  }),
  models: z.object({
    scout: modelIdSchema,
    triage: modelIdSchema,
    smoke_analysis: modelIdSchema,
    drift_detection: modelIdSchema,
    notification: modelIdSchema,
    implementation: modelIdSchema,
    staging_deploy: modelIdSchema,
    promote_to_prod: modelIdSchema,
    rollback: modelIdSchema,
    spec_brainstorm: modelIdSchema,
    ambiguous_failure: modelIdSchema,
  }),
  scout: z.object({
    enabled: z.boolean(),
    cron: z.string().min(1),
    sources: z.array(scoutSourceSchema),
    suppression: z.object({
      track_rejections: z.boolean(),
      suppress_after_n_rejects: z.number().int().positive(),
    }),
  }),
  notifications: z.object({
    push: z
      .object({
        provider: z.enum(['ntfy.sh', 'pushover', 'slack-webhook']),
        topic: z.string().min(1),
      })
      .optional(),
    email: z
      .object({
        via: z.literal('resend'),
        secret_name: z.string().min(1),
        to: z.string().email(),
      })
      .optional(),
    github_issue: z.boolean(),
    status_file: z.boolean(),
  }),
  hotfix: z.object({
    enabled: z.boolean(),
    required_label: z.string().min(1),
    skip_spec: z.boolean(),
    skip_drift_check: z.boolean(),
  }),
});

export type DevAgentConfigParsed = z.infer<typeof devAgentConfigSchema>;
