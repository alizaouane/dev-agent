export type ModelId =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-7'
  | string;

export interface CommandSet {
  test: string;
  test_unit?: string;
  test_contract?: string;
  test_integration?: string;
  test_components?: string;
  test_e2e?: string;
  build: string;
  typecheck: string;
  lint?: string;
}

export interface BranchConfig {
  default: string;
  staging: string | null;
  release_target: string;
  release_pr_required: boolean;
}

export interface DeploySkills {
  staging: string[];
  prod: string[];
}

export interface AuditSkills {
  pre_pr: string[];
}

export interface ScaffoldSkills {
  edge_function?: string;
  migration?: string;
}

export interface ArtifactsConfig {
  specs_dir: string;
  plans_dir: string;
  status_file: string;
  runbooks_dir: string;
}

export interface ScopeCreepThresholds {
  files_outside_spec_scope: number;
  loc_outside_spec_scope: number;
}

export interface GuardrailsConfig {
  blocked_paths: string[];
  require_explicit_unlock: string[];
  max_files_changed: number;
  max_lines_changed: number;
  scope_creep_thresholds: ScopeCreepThresholds;
  trivial_cleanup_categories: string[];
}

export interface PhaseCostCap {
  tokens_in: number;
  tokens_out: number;
  dollars: number;
}

export interface CostCapsConfig {
  spec_brainstorm: PhaseCostCap;
  implement: PhaseCostCap;
  staging_deploy: PhaseCostCap;
  promote_to_prod: PhaseCostCap;
  smoke_verify: PhaseCostCap;
  scout_digest: PhaseCostCap;
  rollback: PhaseCostCap;
}

export interface ModelRouting {
  scout: ModelId;
  triage: ModelId;
  smoke_analysis: ModelId;
  drift_detection: ModelId;
  notification: ModelId;
  implementation: ModelId;
  staging_deploy: ModelId;
  promote_to_prod: ModelId;
  rollback: ModelId;
  spec_brainstorm: ModelId;
  ambiguous_failure: ModelId;
}

export type ScoutSource =
  | { kind: 'github_issues' }
  | { kind: 'vercel_logs'; project: string }
  | { kind: 'supabase_logs'; project_ids: string[] }
  | { kind: 'codebase_audit'; pitfalls_path: string; max_age_days: number }
  | { kind: 'competitive'; feeds: string[] };

export interface ScoutSuppression {
  track_rejections: boolean;
  suppress_after_n_rejects: number;
}

export interface ScoutConfig {
  enabled: boolean;
  cron: string;
  sources: ScoutSource[];
  suppression: ScoutSuppression;
}

export interface PushNotification {
  provider: 'ntfy.sh' | 'pushover' | 'slack-webhook';
  topic: string;
}

export interface EmailNotification {
  via: 'resend';
  secret_name: string;
  to: string;
}

export interface NotificationsConfig {
  push?: PushNotification;
  email?: EmailNotification;
  github_issue: boolean;
  status_file: boolean;
}

export interface HotfixConfig {
  enabled: boolean;
  required_label: string;
  skip_spec: boolean;
  skip_drift_check: boolean;
}

export interface DevAgentConfig {
  schema_version: 1;
  commands: CommandSet;
  branches: BranchConfig;
  deploy_skills: DeploySkills;
  audit_skills: AuditSkills;
  scaffold_skills: ScaffoldSkills;
  artifacts: ArtifactsConfig;
  guardrails: GuardrailsConfig;
  cost_caps: CostCapsConfig;
  models: ModelRouting;
  scout: ScoutConfig;
  notifications: NotificationsConfig;
  hotfix: HotfixConfig;
}
