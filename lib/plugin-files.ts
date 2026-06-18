export const EXPECTED_COMMANDS = [
  'dev-agent-init',
  'develop',
  'proposals',
  'status',
  'approve',
  'abandon',
  'rollback',
  'digest',
] as const;

export const EXPECTED_SKILLS = [
  'orchestrator',
  'scout',
  'drift-check',
  'notify',
  // Industry-grade verification skills (build steps 4 + 6 + 12 + 13)
  'acm',
  'acm-test-agent',
  'swarm-review',
  'self-review',
  'tier2-smoke',
  // User-invocable skill (PM via Claude Code — auto-activates on pitch/bug intents)
  'start-feature',
  // Adversarial fresh-context audit of spec + plan before issue handoff
  // (invoked from start-feature Phase 3.5). Templates the spec uses live
  // at templates/spec.template.md + templates/plan.template.md.
  'spec-review',
] as const;

export const EXPECTED_TEMPLATES = [
  'spec.template.md',
  'plan.template.md',
] as const;

/**
 * Subset of EXPECTED_SKILLS that are meant to be invoked by the user
 * (directly or via Claude Code's auto-activation), as opposed to
 * internal skills invoked by slash commands / workflows. Drives the
 * `user-invocable: true|false` frontmatter assertion in skills.test.ts.
 */
export const USER_INVOCABLE_SKILLS: ReadonlySet<string> = new Set([
  'start-feature',
]);

export const EXPECTED_PROMPTS = [
  'implement',
  'staging-deploy',
  'promote-to-prod',
  'smoke-verify',
  'rollback',
  'scout-digest',
  'drift-check',
  'pm',
  'bug-scout',
  'unfinished-work-scout',
  'cleanup-scout',
  // Industry-grade verification prompts (build steps 4 + 6 + 8 + 12 + 13)
  'acm',
  'acm-test-agent',
  'swarm-spec-compliance',
  'swarm-regression-guard',
  'swarm-security-scout',
  'self-review',
  'tier2-smoke',
] as const;

export type ExpectedCommand = (typeof EXPECTED_COMMANDS)[number];
export type ExpectedSkill = (typeof EXPECTED_SKILLS)[number];
export type ExpectedPrompt = (typeof EXPECTED_PROMPTS)[number];
export type ExpectedTemplate = (typeof EXPECTED_TEMPLATES)[number];
