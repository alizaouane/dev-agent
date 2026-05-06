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
] as const;

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
