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
] as const;

export type ExpectedCommand = (typeof EXPECTED_COMMANDS)[number];
export type ExpectedSkill = (typeof EXPECTED_SKILLS)[number];
export type ExpectedPrompt = (typeof EXPECTED_PROMPTS)[number];
