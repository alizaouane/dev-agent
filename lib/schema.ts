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
    // Industry-grade verification gates (v1 build sequence). All optional —
    // existing consumer configs validate without these blocks. Wired to phases
    // in build steps 6 (ACM), 9 (evidence collector), 12 (swarm), 13 (tier-2).
    acm: z
      .object({
        required: z.boolean(),
        test_pattern: z.string().min(1),
        mutation_score_threshold: z.number().int().min(0).max(100),
        flaky_runs: z.number().int().positive(),
        max_iterations: z.number().int().positive(),
      })
      .optional(),
    swarm: z
      .object({
        reviewers: z.array(z.string()),
        reviewer_weights: z.record(z.number()).optional(),
        timeout_minutes: z.number().int().positive(),
        fail_open: z.boolean(),
        kill_switch_env: z.string().optional(),
      })
      .optional(),
    evidence_collector: z
      .object({
        scanners: z.array(z.string()),
      })
      .optional(),
    tier2_smoke: z
      .object({
        enabled: z.boolean(),
        timeout_minutes: z.number().int().positive(),
        target_routes: z.array(z.string()).optional(),
      })
      .optional(),
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
    // Industry-grade verification phases — optional for existing configs.
    acm: phaseCostCapSchema.optional(),
    swarm_review: phaseCostCapSchema.optional(),
    evidence_collector: phaseCostCapSchema.optional(),
    tier2_smoke: phaseCostCapSchema.optional(),
    self_review: phaseCostCapSchema.optional(),
    index_refresh: phaseCostCapSchema.optional(),
    // Per-repo monthly budget watchdog (Pillar 10). When set, lib/cli/cost-watchdog.ts
    // opens an alert issue at alert_threshold_pct and hard-stops new phase
    // invocations at 100% of monthly_budget_usd.
    monthly_budget_usd: z.number().nonnegative().optional(),
    alert_threshold_pct: z.number().min(0).max(100).optional(),
  }),
  // Model IDs are kept loose at the schema layer (any non-empty string) but
  // the v1 convention is **dated snapshots** (e.g. claude-haiku-4-5-20251022),
  // never aliases — so eval baselines stay meaningful when Anthropic rotates
  // pointers underneath an alias. Enforce the convention via the
  // examples/web-app-template defaults, not the schema.
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
    // Industry-grade verification phases — optional for existing configs.
    acm: modelIdSchema.optional(),
    acm_test_agent: modelIdSchema.optional(),
    swarm_review: modelIdSchema.optional(),
    meta_reviewer: modelIdSchema.optional(),
    evidence_collector: modelIdSchema.optional(),
    tier2_smoke: modelIdSchema.optional(),
    self_review: modelIdSchema.optional(),
    rerank: modelIdSchema.optional(),
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
  // Pillar 3 (Codebase Context Engine) — optional. Wired in build step 3.
  // Drives lib/index/* (tree-sitter chunker + local embedder + sqlite-vec store
  // + 2-stage retrieve+rerank). Index lives at .dev-agent/index.sqlite, local
  // to the runner — no third-party LLM provider sees raw code.
  index: z
    .object({
      enabled: z.boolean(),
      embedding_model: z.string().min(1),
      refresh_on_push: z.boolean(),
      rerank_enabled: z.boolean(),
    })
    .optional(),
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
