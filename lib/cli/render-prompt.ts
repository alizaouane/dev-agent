#!/usr/bin/env tsx
/**
 * Render a prompt template to stdout. Used by phase workflows to construct
 * the system-prompt text that gets piped to claude-code-action's `prompt`
 * input as a file (avoids YAML escaping headaches with multiline content).
 *
 * Usage:
 *   PROMPT_VARS_JSON='{"spec_path":"...","branch_name":"...",...}' \
 *     npx tsx lib/cli/render-prompt.ts implement > /tmp/system-prompt.md
 */
import { renderPrompt } from '../render-prompt';
import type { ExpectedPrompt } from '../plugin-files';

function main(): void {
  const promptName = process.argv[2] as ExpectedPrompt | undefined;
  if (!promptName) {
    console.error('usage: render-prompt.ts <prompt-name>');
    process.exit(2);
  }
  const varsRaw = process.env.PROMPT_VARS_JSON ?? '{}';
  const vars = JSON.parse(varsRaw) as Record<string, unknown>;
  const rendered = renderPrompt(promptName, vars);
  process.stdout.write(rendered);
}

main();
